import { createHash } from 'node:crypto'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { join, posix, relative, resolve } from 'node:path'
import { t } from './i18n.js'
import { createZip, type ZipEntry } from './zip.js'

export interface ExportSource {
  /** Directory of the PASSED run (the generated app after build and verification). */
  readonly runDirectory: string
  readonly projectName: string
  readonly runId: string
}

export interface ExportPackage {
  readonly archive: Buffer
  readonly sha256: string
  readonly entries: number
  readonly fileName: string
}

/** Paths that must never leave the machine: verification data, captured codes, cookies, local env files. */
const EXCLUDED_SEGMENTS = new Set(['data', '.git', 'test-results', 'playwright-report', '.cache'])
const EXCLUDED_FILES = [/^\.env(\..*)?$/u, /\.sqlite(-journal|-wal|-shm)?$/u, /^studio-capture\.json$/u, /^studio-auth-state\.json$/u, /\.pem$/u, /\.key$/u]

export const ENV_EXAMPLE = [
  `# ${t('export.envComment')}`,
  'APP_OWNER_EMAIL=',
  'APP_EMAIL_MODE=smtp',
  'APP_SMTP_URL=',
  'APP_EMAIL_FROM=',
  'DATA_DIR=/var/lib/meu-aplicativo',
  'PORT=3000',
  '',
].join('\n')

export class ExportError extends Error {
  constructor(readonly code: 'RUN_MISSING' | 'INVALID_PATH', message: string) { super(message) }
}

/**
 * Package the verified prototype: the Next.js standalone server, its static
 * assets and public files, the acceptance report, a plain-language README and
 * an `.env.example` with names only. Reproducible: same input → same digest.
 */
export async function packagePrototype(source: ExportSource): Promise<ExportPackage> {
  const root = resolve(source.runDirectory)
  const standalone = join(root, '.next', 'standalone')
  if (!(await isDirectory(standalone))) throw new ExportError('RUN_MISSING', t('errors.exportRunMissing'))
  const entries: ZipEntry[] = []
  await collect(standalone, 'app', entries)
  if (await isDirectory(join(root, '.next', 'static'))) await collect(join(root, '.next', 'static'), 'app/.next/static', entries)
  if (await isDirectory(join(root, 'public'))) await collect(join(root, 'public'), 'app/public', entries)
  const report = join(root, 'evidence', 'appspec-report.json')
  if (await isFile(report)) entries.push({ name: 'evidence/appspec-report.json', data: await readFile(report) })
  entries.push({ name: 'README.md', data: Buffer.from(readme(source), 'utf8') })
  entries.push({ name: '.env.example', data: Buffer.from(ENV_EXAMPLE, 'utf8') })
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) // byte order: locale-independent
  const archive = createZip(entries)
  const sha256 = createHash('sha256').update(archive).digest('hex')
  return { archive, sha256, entries: entries.length, fileName: `${slug(source.projectName)}-${source.runId.slice(0, 8)}.zip` }
}

function readme(source: ExportSource): string {
  return [
    `# ${t('export.readmeTitle')} — ${source.projectName}`, '',
    t('export.readmeIntro'), '', t('export.readmeRun'), '', t('export.readmeData'), '', t('export.readmeSecurity'), '',
    t('export.readmeRunLine', { runId: source.runId }), '',
  ].join('\n')
}

async function collect(directory: string, prefix: string, entries: ZipEntry[]): Promise<void> {
  const items = (await readdir(directory, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const item of items) {
    const full = join(directory, item.name)
    if (item.isSymbolicLink()) continue
    if (item.isDirectory()) {
      if (EXCLUDED_SEGMENTS.has(item.name)) continue
      await collect(full, posix.join(prefix, item.name), entries)
      continue
    }
    if (!item.isFile()) continue
    if (EXCLUDED_FILES.some(pattern => pattern.test(item.name))) continue
    const name = posix.join(prefix, item.name)
    if (name.includes('..') || relative(directory, full).startsWith('..')) throw new ExportError('INVALID_PATH', `unsafe path ${name}`)
    const info = await lstat(full)
    entries.push({ name, data: await readFile(full), mode: (info.mode & 0o111) !== 0 ? 0o755 : 0o644 })
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try { return (await lstat(path)).isDirectory() } catch { return false }
}
async function isFile(path: string): Promise<boolean> {
  try { return (await lstat(path)).isFile() } catch { return false }
}

export function slug(value: string): string {
  const normalized = value.normalize('NFD').replace(/[\u0300-\u036f]/gu, '').toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '')
  return normalized === '' ? 'prototipo' : normalized.slice(0, 40)
}


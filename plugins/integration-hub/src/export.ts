import { createHash } from 'node:crypto'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { join, posix, relative, resolve } from 'node:path'
import { t } from './i18n.js'
import { createZipAsync, type ZipEntry } from './zip.js'

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

/**
 * Paths that must never leave the machine. `.git` is skipped anywhere; the
 * app's own runtime folders (`data/` with the SQLite store and captured codes,
 * caches, test output) are skipped only at the ROOT of the standalone build —
 * deeper `data/` folders belong to libraries and are part of the app.
 */
const EXCLUDED_ANYWHERE = new Set(['.git'])
const EXCLUDED_AT_APP_ROOT = new Set(['data', 'test-results', 'playwright-report', '.cache'])
const EXCLUDED_FILES = [/^\.env(\..*)?$/u, /\.sqlite(-journal|-wal|-shm)?$/u, /^studio-capture\.json$/u, /^studio-auth-state\.json$/u, /\.pem$/u, /\.key$/u]
/** Total bytes of the packaged files; a prototype beyond this is refused in words instead of exhausting memory. */
export const EXPORT_LIMIT_BYTES = 200 * 1024 * 1024

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
  constructor(readonly code: 'RUN_MISSING' | 'INVALID_PATH' | 'TOO_LARGE', message: string) { super(message) }
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
  const budget = { remaining: EXPORT_LIMIT_BYTES }
  await collect(standalone, 'app', entries, budget, true)
  if (await isDirectory(join(root, '.next', 'static'))) await collect(join(root, '.next', 'static'), 'app/.next/static', entries, budget, false)
  if (await isDirectory(join(root, 'public'))) await collect(join(root, 'public'), 'app/public', entries, budget, false)
  const report = join(root, 'evidence', 'appspec-report.json')
  if (await isFile(report)) entries.push({ name: 'evidence/appspec-report.json', data: await readFile(report) })
  entries.push({ name: 'README.md', data: Buffer.from(readme(source), 'utf8') })
  entries.push({ name: '.env.example', data: Buffer.from(ENV_EXAMPLE, 'utf8') })
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) // byte order: locale-independent
  const archive = await createZipAsync(entries)
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

async function collect(directory: string, prefix: string, entries: ZipEntry[], budget: { remaining: number }, appRoot: boolean): Promise<void> {
  const items = (await readdir(directory, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const item of items) {
    const full = join(directory, item.name)
    if (item.isSymbolicLink()) continue
    if (item.isDirectory()) {
      if (EXCLUDED_ANYWHERE.has(item.name) || (appRoot && EXCLUDED_AT_APP_ROOT.has(item.name))) continue
      await collect(full, posix.join(prefix, item.name), entries, budget, false)
      continue
    }
    if (!item.isFile()) continue
    if (EXCLUDED_FILES.some(pattern => pattern.test(item.name))) continue
    // Names come from readdir, so a literal `..` segment cannot appear; `assertEntryName` in the writer re-checks every segment.
    if (relative(directory, full).startsWith('..')) throw new ExportError('INVALID_PATH', `unsafe path ${posix.join(prefix, item.name)}`)
    const info = await lstat(full)
    budget.remaining -= info.size
    if (budget.remaining < 0) throw new ExportError('TOO_LARGE', t('errors.exportTooLarge', { limitMb: EXPORT_LIMIT_BYTES / (1024 * 1024) }))
    entries.push({ name: posix.join(prefix, item.name), data: await readFile(full), mode: (info.mode & 0o111) !== 0 ? 0o755 : 0o644 })
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


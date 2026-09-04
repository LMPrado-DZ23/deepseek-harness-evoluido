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
/**
 * Folders that never travel, at any depth OUTSIDE `node_modules`. They used to
 * be excluded only at the very root of the standalone build, on the theory that
 * a deeper `data/` belongs to a library — and a generated app sitting one
 * folder down kept its own `data/`, captured access codes included, inside the
 * package. Under `node_modules` the theory does hold: a dependency's `data/`
 * is part of the dependency, and dropping it would break the app.
 */
const EXCLUDED_APP_FOLDERS = new Set(['data', 'test-results', 'playwright-report', '.cache'])

function isInsideDependencies(prefix: string): boolean {
  return prefix.split('/').includes('node_modules')
}
const EXCLUDED_FILES = [/^\.env(\..*)?$/u, /\.sqlite(-journal|-wal|-shm)?$/u, /^studio-capture\.json$/u, /^studio-auth-state\.json$/u, /\.pem$/u, /\.key$/u]

/**
 * What may leave the machine, by extension: an allow-list, so a file type
 * nobody thought about is left out instead of shipped. Nothing is dropped in
 * silence — every excluded path is written into `EXCLUIDOS.txt` inside the
 * package, in plain words.
 */
const ALLOWED_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.json', '.map', '.ts', '.tsx', '.jsx', '.mts', '.cts',
  '.html', '.htm', '.css', '.scss', '.txt', '.md', '.xml', '.webmanifest', '.csv',
  '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.bmp',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.wasm', '.node', '.br', '.gz',
  '.mp4', '.webm', '.mp3', '.ogg', '.pdf', '.lock', '.yml', '.yaml',
])
const ALLOWED_EXTENSIONLESS = new Set(['LICENSE', 'LICENCE', 'NOTICE', 'README', 'AUTHORS', 'CHANGELOG', 'COPYING', 'Dockerfile', 'server'])

/**
 * Shapes that are a secret wherever they appear, with effectively no false
 * positives: a private key block, a provider key with its own prefix, or a
 * connection string carrying a password. Finding one FAILS the export — the
 * package is never written with the secret quietly inside it.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bASIA[0-9A-Z]{16}\b/u,
  /\bghp_[A-Za-z0-9]{36}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{22,}/u,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/u,
  /\bsk-(?:live|proj)-[A-Za-z0-9_-]{16,}/u,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|amqp|redis):\/\/[^\s:@/]+:[^\s:@/]+@/u,
]
/** Text types the scan reads. Everything else is packaged uninspected — and SAID SO, in `EXCLUIDOS.txt`. */
const SCANNED_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.json', '.map', '.ts', '.tsx', '.jsx', '.mts', '.cts', '.html', '.htm', '.css', '.scss', '.txt', '.md', '.xml', '.webmanifest', '.csv', '.svg', '.yml', '.yaml', '.lock', ''])
/** A scanned file is read in slices of this size, with an overlap, so a big bundle is inspected whole instead of skipped. */
const SCAN_CHUNK_BYTES = 1024 * 1024
/** Longest secret shape, doubled: the overlap between slices, so a pattern split across a boundary is still seen. */
const SCAN_OVERLAP_BYTES = 512
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
  constructor(readonly code: 'RUN_MISSING' | 'INVALID_PATH' | 'TOO_LARGE' | 'SECRET_DETECTED', message: string) { super(message) }
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
  const excluded: string[] = []
  const uninspected: string[] = []
  await collect(standalone, 'app', entries, budget, true, excluded, uninspected)
  if (await isDirectory(join(root, '.next', 'static'))) await collect(join(root, '.next', 'static'), 'app/.next/static', entries, budget, false, excluded, uninspected)
  if (await isDirectory(join(root, 'public'))) await collect(join(root, 'public'), 'app/public', entries, budget, false, excluded, uninspected)
  const report = join(root, 'evidence', 'appspec-report.json')
  if (await isFile(report)) entries.push({ name: 'evidence/appspec-report.json', data: await readFile(report) })
  if (excluded.length > 0 || uninspected.length > 0) {
    const order = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)
    excluded.sort(order)
    uninspected.sort(order)
    const lines = [`# ${t('export.excludedTitle')}`, '', t('export.excludedIntro'), '', ...excluded]
    if (uninspected.length > 0) lines.push('', `# ${t('export.uninspectedTitle')}`, '', t('export.uninspectedIntro'), '', ...uninspected)
    entries.push({ name: 'EXCLUIDOS.txt', data: Buffer.from([...lines, ''].join('\n'), 'utf8') })
  }
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

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot).toLowerCase()
}

/** True when this file may be packaged at all. */
export function isExportable(name: string): boolean {
  const extension = extensionOf(name)
  return extension === '' ? ALLOWED_EXTENSIONLESS.has(name) : ALLOWED_EXTENSIONS.has(extension)
}

/** Whether the scan can read this file at all. A `false` here is reported, never assumed harmless. */
export function isScannable(name: string): boolean {
  return SCANNED_EXTENSIONS.has(extensionOf(name))
}

/**
 * The secret shape found in this file, or `null`. Fail-closed: the caller turns
 * a hit into a refused export. Read in overlapping slices, so a 40 MB bundle is
 * inspected like a 4 KB one — a size limit here would mean "no secret found"
 * for exactly the files most likely to have one bundled into them.
 */
export function findSecret(name: string, data: Buffer): string | null {
  if (!isScannable(name)) return null
  for (let offset = 0; offset < Math.max(data.length, 1); offset += SCAN_CHUNK_BYTES) {
    const slice = data.subarray(Math.max(0, offset - SCAN_OVERLAP_BYTES), offset + SCAN_CHUNK_BYTES).toString('utf8')
    for (const pattern of SECRET_PATTERNS) if (pattern.test(slice)) return name
  }
  return null
}

async function collect(directory: string, prefix: string, entries: ZipEntry[], budget: { remaining: number }, appRoot: boolean, excluded: string[], uninspected: string[]): Promise<void> {
  const items = (await readdir(directory, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const item of items) {
    const full = join(directory, item.name)
    // A skipped shortcut is named too: an app missing files with no explanation is its own kind of lie.
    if (item.isSymbolicLink()) { excluded.push(`${posix.join(prefix, item.name)} (${t('export.excludedShortcut')})`); continue }
    if (item.isDirectory()) {
      if (EXCLUDED_ANYWHERE.has(item.name) || (EXCLUDED_APP_FOLDERS.has(item.name) && !isInsideDependencies(prefix))) {
        excluded.push(`${posix.join(prefix, item.name)}/`)
        continue
      }
      await collect(full, posix.join(prefix, item.name), entries, budget, false, excluded, uninspected)
      continue
    }
    if (!item.isFile()) continue
    const name = posix.join(prefix, item.name)
    if (EXCLUDED_FILES.some(pattern => pattern.test(item.name))) { excluded.push(name); continue }
    if (!isExportable(item.name)) { excluded.push(name); continue }
    // A name the ZIP writer would refuse (backslash, control character) leaves the package as an
    // exclusion instead of turning the whole export into an internal error.
    if (/[\\\u0000-\u001f]/u.test(item.name)) { excluded.push(`${name} (${t('export.excludedUnsupportedName')})`); continue }
    // Names come from readdir, so a literal `..` segment cannot appear; `assertEntryName` in the writer re-checks every segment.
    if (relative(directory, full).startsWith('..')) throw new ExportError('INVALID_PATH', `unsafe path ${name}`)
    const info = await lstat(full)
    budget.remaining -= info.size
    if (budget.remaining < 0) throw new ExportError('TOO_LARGE', t('errors.exportTooLarge', { limitMb: EXPORT_LIMIT_BYTES / (1024 * 1024) }))
    const data = await readFile(full)
    const secret = findSecret(item.name, data)
    if (secret !== null) throw new ExportError('SECRET_DETECTED', t('errors.exportSecretFound', { file: name }))
    // Packaged, but nobody looked inside it: the package says so rather than implying it was checked.
    if (!isScannable(item.name)) uninspected.push(name)
    entries.push({ name, data, mode: (info.mode & 0o111) !== 0 ? 0o755 : 0o644 })
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


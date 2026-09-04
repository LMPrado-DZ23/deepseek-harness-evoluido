import { createHash } from 'node:crypto'
import { constants, existsSync, type Stats } from 'node:fs'
import { lstat, open, readdir, realpath, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join, posix, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { brotliDecompress, gunzip } from 'node:zlib'
import { t } from './i18n.js'
import { createZipAsync, type ZipEntry } from './zip.js'

export interface ExportSource {
  /** Directory of the PASSED run (the generated app after build and verification). */
  readonly runDirectory: string
  /** Descriptor pinned by the service after walking from `runsRoot`; caller retains ownership. */
  readonly runHandle?: FileHandle
  readonly projectName: string
  readonly runId: string
  readonly signal?: AbortSignal
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
  '.js', '.mjs', '.cjs', '.json', '.ts', '.tsx', '.jsx', '.mts', '.cts',
  '.html', '.htm', '.css', '.scss', '.txt', '.md', '.xml', '.webmanifest', '.csv',
  '.svg', '.br', '.gz', '.lock', '.yml', '.yaml',
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
  // ANY URI scheme carrying `user:password@`, not the five that happened to be listed first.
  // `smtp://`, `ftp://`, `https://` and `ldap://` hide exactly the same credential — and the app's
  // own e-mail setting IS an `smtp://` URL, the shape most likely to be pasted into a config file.
  /\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s:@/]{1,256}:[^\s:@/]{1,256}@[^\s/]/u,
]
/** Text types the scan reads. Everything else is packaged uninspected — and SAID SO, in `EXCLUIDOS.txt`. */
const SCANNED_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.json', '.ts', '.tsx', '.jsx', '.mts', '.cts', '.html', '.htm', '.css', '.scss', '.txt', '.md', '.xml', '.webmanifest', '.csv', '.svg', '.yml', '.yaml', '.lock', ''])
/**
 * Compressed copies of text (`main.js.gz`, `main.css.br`, written next to the originals by a Next.js
 * build). They used to travel as "nobody looked inside": a secret bundled into `main.js` was caught
 * in the `.js` and shipped in the `.gz`. They are now decompressed under a ceiling and scanned as the
 * file they really are; one that cannot be decompressed under that ceiling is EXCLUDED and named,
 * never packaged as if it had been checked.
 */
const COMPRESSED_EXTENSIONS = new Set(['.gz', '.br'])
const SCAN_DECOMPRESSED_LIMIT = 64 * 1024 * 1024
const gunzipAsync = promisify(gunzip)
const brotliDecompressAsync = promisify(brotliDecompress)
/** A scanned file is read in slices of this size, with an overlap, so a big bundle is inspected whole instead of skipped. */
const SCAN_CHUNK_BYTES = 1024 * 1024
/** Longest secret shape, doubled: the overlap between slices, so a pattern split across a boundary is still seen. */
const SCAN_OVERLAP_BYTES = 512
/** Total bytes of the packaged files; a prototype beyond this is refused in words instead of exhausting memory. */
export const EXPORT_LIMIT_BYTES = 200 * 1024 * 1024
/**
 * Hard ZIP (non-64) ceiling on the number of entries, checked while WALKING — before any of those
 * files is opened, read, scanned or compressed. A `node_modules` tree passes 65 535 files without
 * trying, and a ceiling verified after the work it is meant to prevent is not a ceiling.
 */
export const EXPORT_MAX_ENTRIES = 0xffff
/** README, `.env.example`, `EXCLUIDOS.txt` and the acceptance report are added after the walk; the walk leaves room for them. */
const RESERVED_ENTRIES = 4
/**
 * Ceiling on the two lists the package publishes inside `EXCLUIDOS.txt`. Unbounded, they are the
 * same denial of service as the entry list, one string per file. Hitting it REFUSES the export:
 * truncating would mean a file stayed behind — or travelled uninspected — without being named.
 */
export const EXPORT_MAX_LISTED = 100_000

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

/**
 * Why an export was refused, in words the history can keep. The four refusals used to reach the audit
 * trail as their CODE alone: three different `TOO_LARGE` reasons — too many bytes, too many files, a
 * list of exclusions too long — were one indistinguishable row, and a package refused for carrying a
 * secret named the file on the screen and nowhere in the history. The detail is a path or a count,
 * never the matched text: naming the file is what makes the refusal actionable, quoting it would put
 * the secret in the row.
 */
export type ExportRefusal =
  | 'run-missing' | 'invalid-path' | 'bytes-over-limit' | 'too-many-entries' | 'too-many-listed' | `secret-in ${string}`

export class ExportError extends Error {
  constructor(readonly code: 'RUN_MISSING' | 'INVALID_PATH' | 'TOO_LARGE' | 'SECRET_DETECTED', message: string, readonly detail: ExportRefusal = 'invalid-path') { super(message) }
}

/**
 * The two ceilings, as parameters. Production passes none and gets the constants above; a test can
 * lower them and REACH them, instead of having to materialise 65 535 files to find out whether the
 * refusal happens before or after the reading it is supposed to prevent.
 */
export interface ExportLimits {
  readonly maxEntries?: number
  readonly maxListed?: number
  readonly maxBytes?: number
}

interface Walk {
  readonly entries: ZipEntry[]
  readonly budget: { remaining: number }
  readonly excluded: string[]
  readonly uninspected: string[]
  readonly maxEntries: number
  readonly maxListed: number
  readonly signal?: AbortSignal
}

/** Add a line to a published list, or refuse the export when the list would grow without bound. */
function note(walk: Walk, list: string[], line: string): void {
  if (walk.excluded.length + walk.uninspected.length >= walk.maxListed) {
    throw new ExportError('TOO_LARGE', t('errors.exportTooManyListed', { limit: walk.maxListed }), 'too-many-listed')
  }
  list.push(line)
}

const O_NOFOLLOW = (constants.O_NOFOLLOW ?? 0) as number
const O_DIRECTORY = (constants.O_DIRECTORY ?? 0) as number
/**
 * `open()` on a FIFO in `O_RDONLY` WITHOUT this flag blocks until somebody opens the other end —
 * forever, if nobody ever does. A named pipe sitting where a file is expected (`evidence/appspec-report.json`,
 * or any entry that becomes one between `readdir` and `open`) therefore froze packaging itself, and with
 * it the packaging slot, the in-flight entry for that project and, after two of them, every export in the
 * Studio. With `O_NONBLOCK` the open returns immediately, `stat()` says it is not a regular file, and it
 * becomes a NAMED exclusion like every other special file. On a regular file the flag changes nothing.
 */
const O_NONBLOCK = (constants.O_NONBLOCK ?? 0) as number
/** Read-only, no symlink, and never blocking on a pipe or a device: the only way this module opens a file. */
const O_READ_FILE = (constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK) as number
/**
 * Linux gives an `openat` equivalent reachable from JavaScript: a path under `/proc/self/fd/<fd>`
 * resolves from the OPEN inode instead of walking the names again. That is what closes the directory
 * half of the TOCTOU — `readdir` and every child open below happen against the very directory that
 * was opened with `O_NOFOLLOW|O_DIRECTORY`, so swapping the folder for a symlink after the check
 * changes nothing that is read. Node exposes no portable `openat`; where `/proc/self/fd` is absent
 * the walker falls back to the pathname and pins the directory by device+inode (see `openDirectory`).
 */
const HAS_PROC_FD = existsSync('/proc/self/fd')

/** Open a directory without following a symlink, or `undefined` — never a silent success on something else. */
export async function openDirectory(path: string): Promise<FileHandle | undefined> {
  const handle = await open(path, (constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW) as number).catch(() => undefined)
  if (handle === undefined) return undefined
  const info = await handle.stat().catch(() => undefined)
  if (info === undefined || !info.isDirectory()) { await handle.close().catch(() => undefined); return undefined }
  if (!HAS_PROC_FD) {
    // Without an `openat` equivalent the walker must name the directory again to read it, so it
    // re-checks that the name still points at the inode it opened. A swap between the two is caught
    // and the folder becomes a NAMED exclusion instead of a walked one.
    const named = await lstat(path).catch(() => undefined)
    if (named === undefined || named.dev !== info.dev || named.ino !== info.ino) {
      await handle.close().catch(() => undefined)
      return undefined
    }
  }
  return handle
}

/** How to name a child of an already-open directory: through the descriptor where the platform allows it. */
export function referenceOf(handle: FileHandle, path: string): string {
  return HAS_PROC_FD ? `/proc/self/fd/${String(handle.fd)}` : path
}

/**
 * Package the verified prototype: the Next.js standalone server, its static
 * assets and public files, the acceptance report, a plain-language README and
 * an `.env.example` with names only. Reproducible: same input → same digest.
 */
export async function packagePrototype(source: ExportSource, limits: ExportLimits = {}): Promise<ExportPackage> {
  const root = resolve(source.runDirectory)
  const rootHandle = source.runHandle ?? await openDirectory(root)
  if (rootHandle === undefined) throw new ExportError('RUN_MISSING', t('errors.exportRunMissing'), 'run-missing')
  const ownsRoot = source.runHandle === undefined
  const walk: Walk = {
    entries: [], budget: { remaining: limits.maxBytes ?? EXPORT_LIMIT_BYTES }, excluded: [], uninspected: [],
    maxEntries: limits.maxEntries ?? EXPORT_MAX_ENTRIES, maxListed: limits.maxListed ?? EXPORT_MAX_LISTED,
    ...(source.signal === undefined ? {} : { signal: source.signal }),
  }
  let next: FileHandle | undefined
  let standalone: FileHandle | undefined
  try {
    next = await openChildDirectory(rootHandle, root, '.next')
    standalone = next === undefined ? undefined : await openChildDirectory(next, join(root, '.next'), 'standalone')
    if (standalone === undefined) throw new ExportError('RUN_MISSING', t('errors.exportRunMissing'), 'run-missing')
    await collect(standalone, join(root, '.next', 'standalone'), 'app', walk)
    const staticDirectory = next === undefined ? undefined : await openChildDirectory(next, join(root, '.next'), 'static')
    await walkFolder(staticDirectory, join(root, '.next', 'static'), 'app/.next/static', walk)
    const publicDirectory = await openChildDirectory(rootHandle, root, 'public')
    await walkFolder(publicDirectory, join(root, 'public'), 'app/public', walk)
  // The acceptance report goes through the SAME discipline as every other file: the `evidence`
  // folder is resolved and confined first (a symlinked folder pointed the read outside the run
  // directory that was just confined), the file is opened once without following links, and it
  // counts against the budget and the scan. Skipping it is named, never silent.
  const evidence = await openChildDirectory(rootHandle, root, 'evidence')
  const reportName = 'evidence/appspec-report.json'
  if (evidence === undefined) {
    if (await pathExists(join(root, 'evidence'))) note(walk, walk.excluded, `${reportName} (${t('export.excludedShortcut')})`)
  } else {
    const report = join(referenceOf(evidence, join(root, 'evidence')), 'appspec-report.json')
    const handle = await open(report, O_READ_FILE).catch(() => undefined)
    if (handle === undefined) {
      if (await pathExists(report)) note(walk, walk.excluded, `${reportName} (${t('export.excludedShortcut')})`)
      await evidence.close().catch(() => undefined)
    } else {
      try {
        const info = await handle.stat()
        if (!info.isFile()) {
          note(walk, walk.excluded, `${reportName} (${t('export.excludedSpecialFile')})`)
        } else {
          const data = await readBounded(handle, walk)
          if (findSecret('appspec-report.json', data) !== null) throw new ExportError('SECRET_DETECTED', t('errors.exportSecretFound', { file: reportName }), `secret-in ${reportName}`)
          walk.entries.push({ name: reportName, data })
        }
      } finally {
        await handle.close().catch(() => undefined)
        await evidence.close().catch(() => undefined)
      }
    }
  }
  const entries = walk.entries
  if (walk.excluded.length > 0 || walk.uninspected.length > 0) {
    const order = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)
    walk.excluded.sort(order)
    walk.uninspected.sort(order)
    const lines = [`# ${t('export.excludedTitle')}`, '', t('export.excludedIntro'), '', ...walk.excluded]
    if (walk.uninspected.length > 0) lines.push('', `# ${t('export.uninspectedTitle')}`, '', t('export.uninspectedIntro'), '', ...walk.uninspected)
    entries.push({ name: 'EXCLUIDOS.txt', data: Buffer.from([...lines, ''].join('\n'), 'utf8') })
  }
  entries.push({ name: 'README.md', data: Buffer.from(readme(source), 'utf8') })
  entries.push({ name: '.env.example', data: Buffer.from(ENV_EXAMPLE, 'utf8') })
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) // byte order: locale-independent
  const archive = await createZipAsync(entries)
  const sha256 = createHash('sha256').update(archive).digest('hex')
  return { archive, sha256, entries: entries.length, fileName: `${slug(source.projectName)}-${source.runId.slice(0, 8)}.zip` }
  } finally {
    await standalone?.close().catch(() => undefined)
    await next?.close().catch(() => undefined)
    if (ownsRoot) await rootHandle.close().catch(() => undefined)
  }
}

/** An optional top folder: absent is nothing, present-but-unopenable is a NAMED exclusion. */
async function walkFolder(handle: FileHandle | undefined, path: string, prefix: string, walk: Walk): Promise<void> {
  if (handle === undefined) return
  try { await collect(handle, path, prefix, walk) } finally { await handle.close().catch(() => undefined) }
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

/** The plain text inside a `.gz`/`.br`, under a ceiling, or `undefined` when it cannot be read at all. */
async function decompressedText(extension: string, data: Buffer): Promise<Buffer | undefined> {
  try {
    return extension === '.gz'
      ? await gunzipAsync(data, { maxOutputLength: SCAN_DECOMPRESSED_LIMIT })
      : await brotliDecompressAsync(data, { maxOutputLength: SCAN_DECOMPRESSED_LIMIT })
  } catch { return undefined }
}

async function collect(handle: FileHandle, path: string, prefix: string, walk: Walk): Promise<void> {
  throwIfAborted(walk.signal)
  const reference = referenceOf(handle, path)
  const items = (await readdir(reference, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const item of items) {
    // `readdir` returns single path segments; anything else means the platform lied and the walk stops.
    if (item.name === '' || item.name === '.' || item.name === '..' || item.name.includes('/')) throw new ExportError('INVALID_PATH', `unsafe name under ${prefix}`, 'invalid-path')
    const name = posix.join(prefix, item.name)
    // A skipped shortcut is named too: an app missing files with no explanation is its own kind of lie.
    if (item.isSymbolicLink()) { note(walk, walk.excluded, `${name} (${t('export.excludedShortcut')})`); continue }
    if (item.isDirectory()) {
      if (EXCLUDED_ANYWHERE.has(item.name) || (EXCLUDED_APP_FOLDERS.has(item.name) && !isInsideDependencies(prefix))) {
        note(walk, walk.excluded, `${name}/`)
        continue
      }
      // Opened AS a directory, without following a link, and everything below is addressed through
      // that descriptor: the folder cannot be swapped for a symlink between this check and the read.
      const child = await openDirectory(join(reference, item.name))
      if (child === undefined) { note(walk, walk.excluded, `${name}/ (${t('export.excludedShortcut')})`); continue }
      try { await collect(child, join(path, item.name), name, walk) } finally { await child.close().catch(() => undefined) }
      continue
    }
    // A fifo, a socket, a block or character device: not packaged — and no longer skipped in
    // SILENCE. It is named in `EXCLUIDOS.txt` like everything else that stayed behind.
    if (!item.isFile()) { note(walk, walk.excluded, `${name} (${t('export.excludedSpecialFile')})`); continue }
    if (EXCLUDED_FILES.some(pattern => pattern.test(item.name))) { note(walk, walk.excluded, name); continue }
    if (!isExportable(item.name)) { note(walk, walk.excluded, name); continue }
    // A name the ZIP writer would refuse (backslash, control character) leaves the package as an
    // exclusion instead of turning the whole export into an internal error.
    if (/[\\\u0000-\u001f]/u.test(item.name)) { note(walk, walk.excluded, `${name} (${t('export.excludedUnsupportedName')})`); continue }
    // BEFORE the file is opened, read, scanned or compressed: the archive cannot hold more entries
    // than this, so finding out at write time would mean reading and deflating a whole tree first.
    if (walk.entries.length + RESERVED_ENTRIES >= walk.maxEntries) {
      throw new ExportError('TOO_LARGE', t('errors.exportTooManyEntries', { limit: walk.maxEntries }), 'too-many-entries')
    }
    // Opened ONCE, without following a symlink, and both the size and the bytes come from that same
    // handle: `lstat` then `readFile` left a window where the entry could be swapped for a link to
    // something else between the check and the read.
    const file = await open(join(reference, item.name), O_READ_FILE).catch(() => undefined)
    if (file === undefined) { note(walk, walk.excluded, `${name} (${t('export.excludedShortcut')})`); continue }
    let data: Buffer
    let info: Stats
    try {
      info = await file.stat()
      // Not a regular file any more (or never was): named, not skipped — and certainly not read.
      if (!info.isFile()) { note(walk, walk.excluded, `${name} (${t('export.excludedSpecialFile')})`); continue }
      data = await readBounded(file, walk)
    } finally {
      await file.close().catch(() => undefined)
    }
    let scanName = item.name
    let scanData = data
    if (COMPRESSED_EXTENSIONS.has(extensionOf(item.name))) {
      const plain = await decompressedText(extensionOf(item.name), data)
      if (plain === undefined) { note(walk, walk.excluded, `${name} (${t('export.excludedUnreadable')})`); continue }
      scanName = item.name.slice(0, item.name.lastIndexOf('.'))
      scanData = plain
    }
    if (findSecret(scanName, scanData) !== null) throw new ExportError('SECRET_DETECTED', t('errors.exportSecretFound', { file: name }), `secret-in ${name}`)
    // Opaque binaries never leave the machine: only content the scanner understands is exportable.
    if (!isScannable(scanName)) { note(walk, walk.excluded, name); continue }
    walk.entries.push({ name, data, mode: (info.mode & 0o111) !== 0 ? 0o755 : 0o644 })
  }
}

export async function openChildDirectory(parent: FileHandle, parentPath: string, name: string): Promise<FileHandle | undefined> {
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) return undefined
  return openDirectory(join(referenceOf(parent, parentPath), name))
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw signal.reason instanceof Error ? signal.reason : new Error('EXPORT_ABORTED')
}

/** Reads no more than the remaining quota plus one byte; growth after stat can never consume to EOF. */
async function readBounded(handle: FileHandle, walk: Walk): Promise<Buffer> {
  throwIfAborted(walk.signal)
  const ceiling = walk.budget.remaining
  if (ceiling < 0) throw new ExportError('TOO_LARGE', t('errors.exportTooLarge', { limitMb: EXPORT_LIMIT_BYTES / (1024 * 1024) }), 'bytes-over-limit')
  const chunks: Buffer[] = []
  let total = 0
  const chunkSize = Math.min(1024 * 1024, ceiling + 1)
  while (true) {
    throwIfAborted(walk.signal)
    const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(chunkSize, ceiling + 1 - total)))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, total)
    if (bytesRead === 0) break
    total += bytesRead
    if (total > ceiling) throw new ExportError('TOO_LARGE', t('errors.exportTooLarge', { limitMb: EXPORT_LIMIT_BYTES / (1024 * 1024) }), 'bytes-over-limit')
    chunks.push(buffer.subarray(0, bytesRead))
  }
  walk.budget.remaining -= total
  return Buffer.concat(chunks, total)
}

/** The real path of `<root>/<name>`, or `undefined` when it resolves outside `root` or is not a directory. */
async function confinedChild(root: string, name: string): Promise<string | undefined> {
  try {
    const realRoot = await realpath(root)
    const child = await realpath(join(realRoot, name))
    const inside = relative(realRoot, child)
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return undefined
    return (await lstat(child)).isDirectory() ? child : undefined
  } catch { return undefined }
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch { return false }
}

export function slug(value: string): string {
  const normalized = value.normalize('NFD').replace(/[\u0300-\u036f]/gu, '').toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '')
  return normalized === '' ? 'prototipo' : normalized.slice(0, 40)
}

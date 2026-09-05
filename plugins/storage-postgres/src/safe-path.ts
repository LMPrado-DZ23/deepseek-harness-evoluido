import { constants } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import { basename, dirname, join, parse, resolve, sep } from 'node:path'

interface FileIdentity { dev: bigint; ino: bigint }

export interface PinnedDirectory {
  readonly path: string
  readonly handle: FileHandle
  readonly identity: FileIdentity
}

/**
 * Pin a directory and reject symlinks/reparse points in every ancestor. Node
 * has no portable openat(2), so every pathname operation is bracketed by this
 * descriptor identity check. The configured backup directory is private
 * (0700), making replacement by another OS user impossible between checks.
 */
export async function pinDirectory(path: string, create = false): Promise<PinnedDirectory> {
  const absolute = resolve(path)
  if (create) await createDirectoryTreeSafe(absolute)
  await assertNoSymlinkAncestors(absolute)
  const canonical = await realpath(absolute)
  if (!samePath(canonical, absolute)) throw new Error(`unsafe storage path: '${absolute}' resolves outside itself`)
  const handle = await open(absolute, constants.O_RDONLY)
  try {
    const stats = await handle.stat({ bigint: true })
    if (!stats.isDirectory()) throw new Error(`unsafe storage path: '${absolute}' is not a directory`)
    if (process.platform !== 'win32' && (Number(stats.mode) & 0o022) !== 0) {
      throw new Error(`unsafe storage path: directory '${absolute}' is writable by another OS user`)
    }
    const pinned = { path: absolute, handle, identity: { dev: stats.dev, ino: stats.ino } }
    await assertPinnedDirectory(pinned)
    return pinned
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

async function createDirectoryTreeSafe(path: string): Promise<void> {
  const absolute = resolve(path)
  const root = parse(absolute).root
  const rest = absolute.slice(root.length).split(sep).filter(Boolean)
  let current = root
  for (const part of rest) {
    current = join(current, part)
    try {
      const stats = await lstat(current)
      if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(`unsafe storage path: ancestor '${current}' is not a real directory`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await mkdir(current, { mode: 0o700 })
      const created = await lstat(current)
      if (created.isSymbolicLink() || !created.isDirectory()) throw new Error(`unsafe storage path: '${current}' was replaced while being created`)
    }
  }
}

export async function assertPinnedDirectory(directory: PinnedDirectory): Promise<void> {
  const [byHandle, byPath] = await Promise.all([
    directory.handle.stat({ bigint: true }),
    lstat(directory.path, { bigint: true }),
  ])
  if (
    !byHandle.isDirectory()
    || !byPath.isDirectory()
    || byPath.isSymbolicLink()
    || byHandle.dev !== directory.identity.dev
    || byHandle.ino !== directory.identity.ino
    || byPath.dev !== directory.identity.dev
    || byPath.ino !== directory.identity.ino
  ) {
    throw new Error(`unsafe storage path: directory '${directory.path}' changed while it was in use`)
  }
  const canonical = await realpath(directory.path)
  if (!samePath(canonical, directory.path)) throw new Error(`unsafe storage path: directory '${directory.path}' became a symlink`)
}

export function childPath(directory: PinnedDirectory, name: string): string {
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new Error(`unsafe storage child name '${name}'`)
  }
  return join(directory.path, name)
}

/**
 * Path used for the actual syscall. Linux resolves the child through the
 * already-open directory descriptor, which is openat-equivalent and remains
 * confined even if the configured pathname is renamed concurrently. Windows
 * has no `/proc/self/fd`; there the pinned identity plus private ACL boundary
 * is rechecked around every operation.
 */
export function pinnedChildPath(directory: PinnedDirectory, name: string): string {
  childPath(directory, name)
  return process.platform === 'linux' ? `/proc/self/fd/${String(directory.handle.fd)}/${name}` : childPath(directory, name)
}

export async function openNewPinnedFile(directory: PinnedDirectory, name: string, mode = 0o600): Promise<FileHandle> {
  await assertPinnedDirectory(directory)
  const target = pinnedChildPath(directory, name)
  const noFollow = constants.O_NOFOLLOW ?? 0
  const handle = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, mode)
  try {
    const stats = await handle.stat({ bigint: true })
    if (!stats.isFile()) throw new Error(`unsafe storage path: '${target}' is not a regular file`)
    await assertPinnedDirectory(directory)
    return handle
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

/** New private regular file that can be hashed through the creating descriptor. */
export async function openNewPinnedReadWriteFile(directory: PinnedDirectory, name: string, mode = 0o600): Promise<FileHandle> {
  await assertPinnedDirectory(directory)
  const target = pinnedChildPath(directory, name)
  const noFollow = constants.O_NOFOLLOW ?? 0
  const handle = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | noFollow, mode)
  try {
    const stats = await handle.stat({ bigint: true })
    if (!stats.isFile() || stats.nlink !== 1n) throw new Error(`unsafe storage path: '${target}' is not a private regular file`)
    await assertPinnedDirectory(directory)
    return handle
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

export async function openPinnedAppendFile(directory: PinnedDirectory, name: string, mode = 0o600): Promise<FileHandle> {
  await assertPinnedDirectory(directory)
  const target = pinnedChildPath(directory, name)
  const noFollow = constants.O_NOFOLLOW ?? 0
  const handle = await open(target, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | noFollow, mode)
  try {
    const stats = await handle.stat({ bigint: true })
    if (!stats.isFile()) throw new Error(`unsafe storage path: '${target}' is not a regular file`)
    await assertPinnedDirectory(directory)
    return handle
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

export async function pinParent(path: string, create = false): Promise<{ directory: PinnedDirectory; name: string }> {
  const absolute = resolve(path)
  return { directory: await pinDirectory(dirname(absolute), create), name: basename(absolute) }
}

async function assertNoSymlinkAncestors(path: string): Promise<void> {
  const absolute = resolve(path)
  const root = parse(absolute).root
  const rest = absolute.slice(root.length).split(sep).filter(Boolean)
  let current = root
  for (const part of rest) {
    current = join(current, part)
    const stats = await lstat(current)
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(`unsafe storage path: ancestor '${current}' is not a real directory`)
    if (process.platform !== 'win32' && (stats.mode & 0o022) !== 0 && (stats.mode & 0o1000) === 0) {
      throw new Error(`unsafe storage path: ancestor '${current}' is writable by another OS user`)
    }
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

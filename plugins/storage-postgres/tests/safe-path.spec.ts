import { chmod, mkdir, mkdtemp, open, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertPinnedDirectory,
  childPath,
  openNewPinnedFile,
  openNewPinnedReadWriteFile,
  openPinnedAppendFile,
  pinDirectory,
  pinnedChildPath,
  pinParent,
} from '../src/safe-path.ts'

const scratch: string[] = []
afterEach(async () => {
  for (const directory of scratch.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe('storage path confinement', () => {
  it('detects replacement of a pinned directory before another pathname operation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-pin-'))
    scratch.push(root)
    const target = join(root, 'backups')
    const moved = join(root, 'backups-original')
    await mkdir(target)
    const pinned = await pinDirectory(target)
    try {
      try {
        await rename(target, moved)
      } catch (error) {
        if (['EPERM', 'EBUSY'].includes((error as { code?: string }).code ?? '')) return
        throw error
      }
      await mkdir(target)
      await expect(assertPinnedDirectory(pinned)).rejects.toThrow('changed while it was in use')
    } finally {
      await pinned.handle.close()
    }
  })

  it('rejects a symlink in the configured directory ancestry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-pin-link-'))
    scratch.push(root)
    const real = join(root, 'real')
    const linked = join(root, 'linked')
    await mkdir(real)
    try {
      await symlink(real, linked, 'junction')
    } catch (error) {
      if ((error as { code?: string }).code === 'EPERM') return
      throw error
    }
    await expect(pinDirectory(join(linked, 'backups'), true)).rejects.toThrow('not a real directory')
  })

  it('creates a private directory tree and confines every child operation to the pinned directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-pin-create-'))
    scratch.push(root)
    const target = join(root, 'private', 'nested')
    const pinned = await pinDirectory(target, true)
    try {
      expect(pinnedChildPath(pinned, 'backup.json')).toContain('backup.json')
      expect(childPath(pinned, 'backup.json')).toBe(join(target, 'backup.json'))
      for (const invalid of ['', '.', '..', '../escape', 'nested/file', 'nested\\file', `nul\0name`]) {
        expect(() => childPath(pinned, invalid)).toThrow('unsafe storage child name')
      }

      const writeOnly = await openNewPinnedFile(pinned, 'write-only')
      await writeOnly.writeFile('first')
      await writeOnly.close()

      const readWrite = await openNewPinnedReadWriteFile(pinned, 'read-write')
      await readWrite.writeFile('second')
      const data = Buffer.alloc(6)
      await readWrite.read(data, 0, data.length, 0)
      expect(data.toString()).toBe('second')
      await readWrite.close()

      const append = await openPinnedAppendFile(pinned, 'append')
      await append.writeFile('a')
      await append.close()
      const appendAgain = await openPinnedAppendFile(pinned, 'append')
      await appendAgain.writeFile('b')
      await appendAgain.close()
      const appended = await open(join(target, 'append'), 'r')
      try { expect(await appended.readFile('utf8')).toBe('ab') } finally { await appended.close() }

      await expect(openNewPinnedFile(pinned, 'write-only')).rejects.toMatchObject({ code: 'EEXIST' })
      await expect(openNewPinnedReadWriteFile(pinned, 'read-write')).rejects.toMatchObject({ code: 'EEXIST' })
    } finally {
      await pinned.handle.close()
    }

    const parent = await pinParent(join(target, 'child.json'))
    try { expect(parent.name).toBe('child.json') } finally { await parent.directory.handle.close() }
  })

  it('refuses a regular file where a directory is required', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-pin-file-'))
    scratch.push(root)
    const file = join(root, 'not-a-directory')
    await writeFile(file, 'x')
    await expect(pinDirectory(file)).rejects.toThrow('not a real directory')
    await expect(pinDirectory(file, true)).rejects.toThrow('not a real directory')
  })

  it.runIf(process.platform !== 'win32')('refuses group/world-writable private directories and ancestors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-pin-mode-'))
    scratch.push(root)
    const unsafe = join(root, 'unsafe')
    const child = join(unsafe, 'child')
    await mkdir(child, { recursive: true, mode: 0o700 })
    await chmod(unsafe, 0o777)
    await expect(pinDirectory(unsafe)).rejects.toThrow('writable by another OS user')
    await expect(pinDirectory(child)).rejects.toThrow('ancestor')
  })
})

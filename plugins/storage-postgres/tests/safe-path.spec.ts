import { mkdir, mkdtemp, rename, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertPinnedDirectory, pinDirectory } from '../src/safe-path.ts'

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
})

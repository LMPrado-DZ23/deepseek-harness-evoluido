import { beforeEach, describe, expect, it, vi } from 'vitest'

type Kind = 'dir' | 'file' | 'link'
const state = vi.hoisted(() => ({
  kind: 'dir' as Kind,
  nlink: 1n,
  mode: 0o700,
  dev: 1n,
  ino: 2n,
  canonical: '',
  lstatError: undefined as NodeJS.ErrnoException | undefined,
  lstatSequence: [] as Array<ReturnType<typeof makeStats> | NodeJS.ErrnoException>,
  handleStats: undefined as ReturnType<typeof makeStats> | undefined,
  closes: 0,
  closeError: false,
}))

function makeStats(kind: Kind = 'dir', overrides: Partial<{ nlink: bigint; mode: number; dev: bigint; ino: bigint }> = {}) {
  return {
    dev: overrides.dev ?? 1n, ino: overrides.ino ?? 2n, nlink: overrides.nlink ?? 1n,
    mode: overrides.mode ?? 0o700,
    isDirectory: () => kind === 'dir', isFile: () => kind === 'file', isSymbolicLink: () => kind === 'link',
  }
}

vi.mock('node:fs/promises', () => ({
  lstat: vi.fn(async () => {
    const next = state.lstatSequence.shift()
    if (next !== undefined) {
      if (next instanceof Error) throw next
      return next
    }
    if (state.lstatError !== undefined) throw state.lstatError
    return makeStats(state.kind, state)
  }),
  mkdir: vi.fn(async () => undefined),
  realpath: vi.fn(async (path: string) => state.canonical || path),
  open: vi.fn(async () => ({
    fd: 9,
    stat: async () => state.handleStats ?? makeStats(state.kind, state),
    close: async () => { state.closes += 1; if (state.closeError) throw new Error('close failed') },
  })),
}))

import { assertPinnedDirectory, openNewPinnedFile, openNewPinnedReadWriteFile, openPinnedAppendFile, pinDirectory } from '../src/safe-path.ts'

beforeEach(() => {
  state.kind = 'dir'; state.nlink = 1n; state.mode = 0o700; state.dev = 1n; state.ino = 2n
  state.canonical = ''; state.lstatError = undefined; state.lstatSequence = []; state.handleStats = undefined; state.closes = 0; state.closeError = false
})

describe('storage path failure boundaries', () => {
  it('closes the pin when the opened target is not a directory or is group-writable', async () => {
    state.handleStats = makeStats('file')
    await expect(pinDirectory('/private/data')).rejects.toThrow('not a directory')
    expect(state.closes).toBe(1)

    state.handleStats = makeStats('dir', { mode: 0o722 })
    await expect(pinDirectory('/private/data')).rejects.toThrow('writable by another OS user')
    expect(state.closes).toBe(2)
  })

  it('refuses canonical-path replacement and invalid directory creation races', async () => {
    state.canonical = '/other/place'
    await expect(pinDirectory('/private/data')).rejects.toThrow('resolves outside itself')

    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' })
    state.canonical = ''
    state.lstatSequence = [missing, makeStats('link')]
    await expect(pinDirectory('/private/data', true)).rejects.toThrow('replaced while being created')
  })

  it('detects a pinned path becoming a different canonical path', async () => {
    state.canonical = '/other/place'
    await expect(assertPinnedDirectory({ path: '/private/data', handle: { stat: async () => makeStats('dir') } as never, identity: { dev: 1n, ino: 2n } }))
      .rejects.toThrow('became a symlink')
  })

  it('closes newly opened non-regular or linked files on every write mode', async () => {
    const directory = { path: '/private/data', handle: { fd: 9, stat: async () => makeStats('dir') } as never, identity: { dev: 1n, ino: 2n } }
    state.handleStats = makeStats('dir')
    await expect(openNewPinnedFile(directory, 'one')).rejects.toThrow('not a regular file')
    state.handleStats = makeStats('file', { nlink: 2n })
    await expect(openNewPinnedReadWriteFile(directory, 'two')).rejects.toThrow('not a private regular file')
    state.handleStats = makeStats('dir')
    await expect(openPinnedAppendFile(directory, 'three')).rejects.toThrow('not a regular file')
    expect(state.closes).toBe(3)
  })

  it('preserves the safety error even when closing each rejected descriptor also fails', async () => {
    state.closeError = true
    state.handleStats = makeStats('file')
    await expect(pinDirectory('/private/data')).rejects.toThrow('not a directory')
    const directory = { path: '/private/data', handle: { fd: 9, stat: async () => makeStats('dir') } as never, identity: { dev: 1n, ino: 2n } }
    state.handleStats = makeStats('dir')
    await expect(openNewPinnedFile(directory, 'one')).rejects.toThrow('not a regular file')
    state.handleStats = makeStats('file', { nlink: 2n })
    await expect(openNewPinnedReadWriteFile(directory, 'two')).rejects.toThrow('not a private regular file')
    state.handleStats = makeStats('dir')
    await expect(openPinnedAppendFile(directory, 'three')).rejects.toThrow('not a regular file')
  })
})

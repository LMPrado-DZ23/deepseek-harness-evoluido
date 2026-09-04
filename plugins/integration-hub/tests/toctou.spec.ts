import { describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { packagePrototype } from '../src/export.ts'
import { readZip } from '../src/zip.ts'

/**
 * The only way to observe a time-of-check/time-of-use window deterministically is to open it on
 * purpose: this hook fires the instant the walker has finished listing a directory, which is exactly
 * the moment an attacker with write access to the run folder would swap that directory.
 */
const hooks = vi.hoisted(() => ({ afterReaddir: undefined as ((names: string[]) => Promise<void>) | undefined }))
vi.mock('node:fs/promises', async importOriginal => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...real,
    default: real,
    readdir: async (path: Parameters<typeof real.readdir>[0], options?: Parameters<typeof real.readdir>[1]) => {
      const listed = await (real.readdir as (p: unknown, o: unknown) => Promise<unknown[]>)(path, options)
      const names = listed.map(item => (typeof item === 'string' ? item : (item as { name: string }).name))
      await hooks.afterReaddir?.(names)
      return listed
    },
  }
})

/** Linux is the only platform where Node can reach an `openat` equivalent (`/proc/self/fd/<fd>`). */
const hasProcFd = existsSync('/proc/self/fd')

describe('export reads each file through one handle', () => {
  it('never follows a symlink, even one planted where a regular file was', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-toctou-'))
    try {
      const standalone = join(root, '.next', 'standalone')
      await mkdir(standalone, { recursive: true })
      await writeFile(join(standalone, 'server.js'), 'ok')
      await chmod(join(standalone, 'server.js'), 0o755)
      // A file that IS a symlink to something private: it must not be read, and it must be named.
      await writeFile(join(root, 'segredo.txt'), 'nao-deveria-sair')
      await symlink(join(root, 'segredo.txt'), join(standalone, 'atalho.js'))
      const built = await packagePrototype({ runDirectory: root, projectName: 'A', runId: 'run-1' })
      const entries = readZip(built.archive)
      expect(entries.map(entry => entry.name)).not.toContain('app/atalho.js')
      const all = entries.map(entry => entry.data.toString('utf8')).join('\n')
      expect(all).not.toContain('nao-deveria-sair')
      expect(entries.find(entry => entry.name === 'EXCLUIDOS.txt')!.data.toString('utf8')).toContain('app/atalho.js')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not read the acceptance report through a symlinked evidence folder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-evidence-'))
    const outside = await mkdtemp(join(tmpdir(), 'dz23-outside-'))
    try {
      await mkdir(join(root, '.next', 'standalone'), { recursive: true })
      await writeFile(join(root, '.next', 'standalone', 'server.js'), 'ok')
      // `evidence/` is a symlink to somewhere else: the report there must not travel, and the skip is named.
      await writeFile(join(outside, 'appspec-report.json'), '{"conteudo":"FORA-DO-RUN-DIRECTORY"}')
      await symlink(outside, join(root, 'evidence'))
      const built = await packagePrototype({ runDirectory: root, projectName: 'A', runId: 'run-1' })
      const entries = readZip(built.archive)
      expect(entries.map(entry => entry.name)).not.toContain('evidence/appspec-report.json')
      expect(entries.map(entry => entry.data.toString('utf8')).join('\n')).not.toContain('FORA-DO-RUN-DIRECTORY')
      expect(entries.find(entry => entry.name === 'EXCLUIDOS.txt')!.data.toString('utf8')).toContain('evidence/appspec-report.json')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('still packages a real evidence folder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-evidence-ok-'))
    try {
      await mkdir(join(root, '.next', 'standalone'), { recursive: true })
      await writeFile(join(root, '.next', 'standalone', 'server.js'), 'ok')
      await mkdir(join(root, 'evidence'), { recursive: true })
      await writeFile(join(root, 'evidence', 'appspec-report.json'), '{"checks":[]}')
      const built = await packagePrototype({ runDirectory: root, projectName: 'A', runId: 'run-1' })
      expect(readZip(built.archive).map(entry => entry.name)).toContain('evidence/appspec-report.json')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  /**
   * The file half of the window was closed at HEAD (one `O_NOFOLLOW` handle per file). This is the
   * DIRECTORY half: the walker listed a folder and then reopened it BY NAME, so a folder swapped for
   * a symlink after the listing sent every read below it somewhere else — and `O_NOFOLLOW` on the
   * file did not help, because the file at the end of the swapped path is a perfectly regular file.
   */
  it.skipIf(!hasProcFd)('reads a directory\'s files from the descriptor it opened, not from the name it had', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-dirswap-'))
    const outside = await mkdtemp(join(tmpdir(), 'dz23-dirswap-out-'))
    try {
      const sub = join(root, '.next', 'standalone', 'sub')
      await mkdir(sub, { recursive: true })
      await writeFile(join(root, '.next', 'standalone', 'server.js'), 'ok')
      await writeFile(join(sub, 'config.js'), 'const origem = "DENTRO-DA-RUN"')
      await writeFile(join(outside, 'config.js'), 'const origem = "FORA-DA-RUN"')
      hooks.afterReaddir = async names => {
        if (!names.includes('config.js')) return
        hooks.afterReaddir = undefined // exactly once: the listing of `sub` has just been handed over
        await rename(sub, join(root, 'sub-real'))
        await symlink(outside, sub)
      }
      const built = await packagePrototype({ runDirectory: root, projectName: 'A', runId: 'run-1' })
      const entries = readZip(built.archive)
      const all = entries.map(entry => entry.data.toString('utf8')).join('\n')
      expect(all).not.toContain('FORA-DA-RUN')
      expect(entries.find(entry => entry.name === 'app/sub/config.js')!.data.toString('utf8')).toContain('DENTRO-DA-RUN')
    } finally {
      hooks.afterReaddir = undefined
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  /** A folder swapped for a symlink BEFORE it is opened must fail closed — and be named, not skipped. */
  it('refuses a directory swapped for a symlink between the listing and the walk, and names it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-dirlink-'))
    const outside = await mkdtemp(join(tmpdir(), 'dz23-dirlink-out-'))
    try {
      const sub = join(root, '.next', 'standalone', 'sub')
      await mkdir(sub, { recursive: true })
      await writeFile(join(root, '.next', 'standalone', 'server.js'), 'ok')
      await writeFile(join(outside, 'privado.js'), 'const x = "FORA-DA-RUN"')
      hooks.afterReaddir = async names => {
        if (!names.includes('sub')) return
        hooks.afterReaddir = undefined // the walker believes `sub` is a directory; it stops being one now
        await rm(sub, { recursive: true, force: true })
        await symlink(outside, sub)
      }
      const built = await packagePrototype({ runDirectory: root, projectName: 'A', runId: 'run-1' })
      const entries = readZip(built.archive)
      expect(entries.map(entry => entry.data.toString('utf8')).join('\n')).not.toContain('FORA-DA-RUN')
      expect(entries.map(entry => entry.name)).not.toContain('app/sub/privado.js')
      expect(entries.find(entry => entry.name === 'EXCLUIDOS.txt')!.data.toString('utf8')).toContain('app/sub/')
    } finally {
      hooks.afterReaddir = undefined
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  /** A fifo/socket/device used to vanish from the package with no line anywhere saying it had. */
  it('names a special file instead of skipping it in silence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-fifo-'))
    try {
      const standalone = join(root, '.next', 'standalone')
      await mkdir(standalone, { recursive: true })
      await writeFile(join(standalone, 'server.js'), 'ok')
      execFileSync('mkfifo', [join(standalone, 'canal.js')])
      const built = await packagePrototype({ runDirectory: root, projectName: 'A', runId: 'run-1' })
      const entries = readZip(built.archive)
      expect(entries.map(entry => entry.name)).not.toContain('app/canal.js')
      const left = entries.find(entry => entry.name === 'EXCLUIDOS.txt')!.data.toString('utf8')
      expect(left).toContain('app/canal.js')
      expect(left).toContain('arquivo especial do sistema')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

import { describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { packagePrototype } from '../src/export.ts'
import { readZip } from '../src/zip.ts'

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
})

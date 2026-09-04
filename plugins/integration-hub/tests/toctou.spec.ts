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
})

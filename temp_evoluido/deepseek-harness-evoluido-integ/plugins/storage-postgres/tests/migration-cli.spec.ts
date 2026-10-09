import { execFile } from 'node:child_process'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { SqliteStorageBackend } from '@deepseek-ai/dsh-storage-sqlite'
import { descriptorOf } from '@deepseek-ai/dsh-storage-domain'
import { studioHelloDomainSpec } from '../../hello/src/index.ts'
import { validateBundle, type StorageExportBundle } from '../../../scripts/storage-migration.ts'

const run = promisify(execFile)

describe('SQLite export CLI', () => {
  it('is dry-run by default and writes a validated bundle only with explicit confirmation', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'dz23-p31-cli-'))
    try {
      const sourcePath = join(temporary, 'source.sqlite')
      const outputPath = join(temporary, 'export.json')
      const source = new SqliteStorageBackend({ path: sourcePath, journalMode: 'delete' })
      const unit = await source.kv!.open(descriptorOf(studioHelloDomainSpec))
      await unit.putRecord('records', 'primary', { tenant_id: 'tenant-a', created_at: '2026-09-02T00:00:00.000Z', note: 'cli' })
      await source.close()

      const script = resolve('scripts/export-sqlite-storage.ts')
      const common = ['--import', 'tsx', script, '--sqlite', sourcePath, '--out', outputPath, '--confirm-harness-stopped']
      const dry = await run(process.execPath, common)
      expect(JSON.parse(dry.stdout)).toMatchObject({ mode: 'dry-run', destination: null })
      await expect(access(outputPath)).rejects.toThrow()

      const written = await run(process.execPath, [...common, '--write'])
      expect(JSON.parse(written.stdout)).toMatchObject({ mode: 'write', destination: outputPath })
      const bundle = JSON.parse(await readFile(outputPath, 'utf8')) as StorageExportBundle
      expect(() => validateBundle(bundle)).not.toThrow()
      expect(bundle.domains.find(domain => domain.descriptor.name === 'studio_hello')?.snapshot.tables.records?.primary)
        .toMatchObject({ tenant_id: 'tenant-a', note: 'cli' })

      await expect(run(process.execPath, ['--import', 'tsx', script, '--sqlite', sourcePath, '--out', join(temporary, 'refused.json')]))
        .rejects.toThrow('confirm-harness-stopped')
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }, 30_000)
})

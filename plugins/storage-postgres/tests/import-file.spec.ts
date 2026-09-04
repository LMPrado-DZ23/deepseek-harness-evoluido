import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { exportedDomain, sealBundle } from '../src/bundle.ts'
import { readStorageBundleFile } from '../src/import-file.ts'

const scratch: string[] = []
afterEach(async () => {
  for (const directory of scratch.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function directory(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'dz23-import-file-'))
  scratch.push(value)
  return value
}

function validBundle() {
  const descriptor = { name: 'studio_hello', version: 1, tables: ['records'], hasGlobal: false }
  return sealBundle({ kind: 'postgres', sha256: 'a'.repeat(64) }, [
    exportedDomain(descriptor, { tables: { records: { one: { note: 'ok' } } }, global: null }),
  ], '2026-09-04T00:00:00.000Z')
}

describe('bounded storage import reader', () => {
  it('reads a valid bundle through one descriptor and enforces the actual EOF byte count', async () => {
    const root = await directory()
    const input = join(root, 'bundle.json')
    const serialized = JSON.stringify(validBundle())
    await writeFile(input, serialized)
    await expect(readStorageBundleFile(input, { maxBytes: Buffer.byteLength(serialized), maxDomains: 1, maxRecords: 1, maxDepth: 64 }))
      .resolves.toEqual(validBundle())
    await expect(readStorageBundleFile(input, { maxBytes: Buffer.byteLength(serialized) - 1, maxDomains: 1, maxRecords: 1, maxDepth: 64 }))
      .rejects.toThrow('byte limit')
  })

  it('refuses excessive structural depth before JSON materialization', async () => {
    const root = await directory()
    const input = join(root, 'deep.json')
    await writeFile(input, `${'['.repeat(20)}0${']'.repeat(20)}`)
    await expect(readStorageBundleFile(input, { maxBytes: 1024, maxDomains: 1, maxRecords: 1, maxDepth: 8 }))
      .rejects.toThrow('nesting-depth limit')
  })

  it('refuses a symlink as the input or as an ancestor', async () => {
    const root = await directory()
    const real = join(root, 'real')
    const linked = join(root, 'linked')
    await writeFile(real, JSON.stringify(validBundle()))
    try {
      await symlink(real, linked, 'file')
    } catch (error) {
      if ((error as { code?: string }).code === 'EPERM') return
      throw error
    }
    await expect(readStorageBundleFile(linked)).rejects.toThrow()
  })
})

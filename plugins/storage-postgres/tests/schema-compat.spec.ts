import { describe, expect, it, vi } from 'vitest'
import type { Client } from 'pg'
import { descriptorFingerprint } from '../src/bundle.ts'
import { readInstallation, storedDescriptor, unitsProjection, type UnitRow } from '../src/snapshot.ts'

function clientWithRows(...rows: unknown[][]): Client {
  const query = vi.fn()
  for (const value of rows) query.mockResolvedValueOnce({ rows: value })
  return { query } as unknown as Client
}

describe('schema compatibility readers', () => {
  it('uses typed NULLs only for optional unit columns absent from the catalog', async () => {
    const client = clientWithRows([{ attname: 'tables' }])
    await expect(unitsProjection(client, 'dz23_storage')).resolves.toBe(
      '"name", "version", "tables", NULL::boolean AS "has_global", NULL::text AS "descriptor_sha256"',
    )
  })

  it('omits an installation identity when the old schema has no metadata column', async () => {
    const client = clientWithRows([{ n: 0 }])
    await expect(readInstallation(client, 'dz23_storage')).resolves.toBeUndefined()
  })

  it('reads the installation identity only after confirming the column exists', async () => {
    const installation = '11111111-1111-4111-8111-111111111111'
    const client = clientWithRows([{ n: 1 }], [{ text_value: installation }])
    await expect(readInstallation(client, 'dz23_storage')).resolves.toBe(installation)
  })
})

describe('stored descriptor integrity', () => {
  const declared = { name: 'studio_hello', version: 1, tables: ['records'], hasGlobal: false }

  it('requires a matching fingerprint for every declaration', () => {
    const row: UnitRow = { name: declared.name, version: declared.version, tables: declared.tables, has_global: false, descriptor_sha256: null }
    expect(() => storedDescriptor(row, new Set(['records']), false)).toThrow('no fingerprint')

    expect(storedDescriptor({ ...row, descriptor_sha256: descriptorFingerprint(declared) }, new Set(), false)).toEqual(declared)
  })

  it('keeps accepting the all-NULL row from the legacy schema and infers its shape', () => {
    const row: UnitRow = { name: declared.name, version: declared.version, tables: null, has_global: null, descriptor_sha256: null }
    expect(storedDescriptor(row, new Set(['records']), true)).toEqual({ ...declared, hasGlobal: true })
  })
})

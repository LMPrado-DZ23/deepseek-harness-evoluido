import { describe, expect, it } from 'vitest'
import { bundleRecordCount, canonicalJson, exportedDomain, sealBundle, sha256, validateBundle, type StorageExportBundle } from '../src/bundle.ts'

const descriptor = { name: 'studio_hello', version: 1, tables: ['records'], hasGlobal: false }
const sealed = () => sealBundle({ kind: 'json', sha256: 'b'.repeat(64) }, [
  exportedDomain(descriptor, { tables: { records: { a: { note: 'a' }, b: { note: 'b' } } }, global: null }),
], '2026-09-03T12:00:00.000Z')

describe('storage export bundle', () => {
  it('seals a bundle that validates and counts records', () => {
    const bundle = sealed()
    expect(() => validateBundle(bundle)).not.toThrow()
    expect(bundleRecordCount(bundle)).toBe(2)
  })

  it('seals a logical installation identity while preserving legacy identity-less bundles', () => {
    const installation = '11111111-1111-4111-8111-111111111111'
    const identified = sealBundle(sealed().source, sealed().domains, sealed().createdAt, installation)
    expect(identified.installation).toBe(installation)
    expect(() => validateBundle(identified)).not.toThrow()

    const legacy = sealed()
    expect(Object.hasOwn(legacy, 'installation')).toBe(false)
    expect(() => validateBundle(legacy)).not.toThrow()

    const invalid = sealBundle(sealed().source, sealed().domains, sealed().createdAt, 'not-an-installation-id')
    expect(() => validateBundle(invalid)).toThrow('installation identity is invalid')
  })

  it('rejects a foreign format or pin, an unknown source kind, a payload edit, a duplicate domain and a domain edit', () => {
    expect(() => validateBundle({ ...sealed(), format: 'other' } as unknown as StorageExportBundle)).toThrow('incompatible')
    expect(() => validateBundle({ ...sealed(), upstreamCommit: 'deadbeef' } as unknown as StorageExportBundle)).toThrow('incompatible')
    const kind = sealed(); (kind.source as { kind: string }).kind = 'mystery'
    expect(() => validateBundle(kind)).toThrow('source kind is unknown')
    expect(() => validateBundle({ ...sealed(), createdAt: '2026-09-04T00:00:00.000Z' })).toThrow('payload checksum mismatch')
    const duplicated = sealBundle({ kind: 'sqlite', sha256: 'c'.repeat(64) }, [sealed().domains[0]!, sealed().domains[0]!], '2026-09-03T12:00:00.000Z')
    expect(() => validateBundle(duplicated)).toThrow('duplicate exported domain')
    const edited = sealed()
    ;(edited.domains[0]!.snapshot.tables.records as Record<string, unknown>).a = { note: 'tampered' }
    const resealed = { ...edited, payloadSha256: sealBundle(edited.source, edited.domains, edited.createdAt).payloadSha256 }
    expect(() => validateBundle(resealed)).toThrow('domain checksum mismatch')
  })

  it('rejects unknown fields, undeclared tables and bounded record/depth explosions even when resealed', () => {
    const unknown = structuredClone(sealed()) as StorageExportBundle & { surprise?: boolean }
    unknown.surprise = true
    unknown.payloadSha256 = sha256(canonicalJson({
      format: unknown.format, upstreamCommit: unknown.upstreamCommit, source: unknown.source,
      createdAt: unknown.createdAt, domains: unknown.domains, surprise: true,
    }))
    expect(() => validateBundle(unknown)).toThrow('unknown or missing fields')

    const extraTable = sealed()
    ;(extraTable.domains[0]!.snapshot.tables as Record<string, unknown>).undeclared = {}
    expect(() => validateBundle(sealBundle(extraTable.source, extraTable.domains, extraTable.createdAt))).toThrow('unknown or missing fields')

    expect(() => validateBundle(sealed(), { maxDomains: 1, maxRecords: 1, maxDepth: 8 })).toThrow('record limit')
    const twoDomains = sealBundle({ kind: 'json', sha256: 'b'.repeat(64) }, [
      sealed().domains[0]!,
      exportedDomain({ ...descriptor, name: 'studio_second' }, { tables: { records: {} }, global: null }),
    ], '2026-09-03T12:00:00.000Z')
    expect(() => validateBundle(twoDomains, { maxDomains: 1, maxRecords: 10, maxDepth: 8 })).toThrow('domain limit')
    const deep = sealed()
    deep.domains[0]!.snapshot.tables.records!.a = { one: { two: { three: true } } }
    const deepSealed = sealBundle(deep.source, [exportedDomain(deep.domains[0]!.descriptor, deep.domains[0]!.snapshot)], deep.createdAt)
    expect(() => validateBundle(deepSealed, { maxDomains: 1, maxRecords: 10, maxDepth: 1 })).toThrow('nesting-depth limit')
  })
})

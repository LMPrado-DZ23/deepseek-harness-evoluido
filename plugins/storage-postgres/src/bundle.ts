import { createHash } from 'node:crypto'
import type { KvUnitDescriptor } from '@deepseek-ai/dsh-storage'

/**
 * Logical export format shared by the SQLite/JSON → PostgreSQL migration, the
 * hot PostgreSQL snapshot and the scheduled backups. One format, one
 * validator, one restore path (scripts/import-postgres-storage.ts).
 */
export const STORAGE_EXPORT_FORMAT = 'dz23-studio-kv-export/v1'
export const HARNESS_UPSTREAM_COMMIT = '6c705be1ce6774a000d061da41d1823b03a3d42c'

export type StorageExportSourceKind = 'sqlite' | 'json' | 'postgres'

export interface ExportedDomain {
  descriptor: KvUnitDescriptor
  snapshot: { tables: Record<string, Record<string, unknown>>; global: unknown }
  sha256: string
}

export interface StorageExportBundle {
  format: typeof STORAGE_EXPORT_FORMAT
  upstreamCommit: typeof HARNESS_UPSTREAM_COMMIT
  source: { kind: StorageExportSourceKind; sha256: string }
  createdAt: string
  domains: ExportedDomain[]
  payloadSha256: string
}

export function exportedDomain(descriptor: KvUnitDescriptor, snapshot: ExportedDomain['snapshot']): ExportedDomain {
  return { descriptor, snapshot, sha256: sha256(canonicalJson({ descriptor, snapshot })) }
}

export function sealBundle(
  source: StorageExportBundle['source'],
  domains: ExportedDomain[],
  createdAt: string,
): StorageExportBundle {
  const payload: Omit<StorageExportBundle, 'payloadSha256'> = {
    format: STORAGE_EXPORT_FORMAT,
    upstreamCommit: HARNESS_UPSTREAM_COMMIT,
    source,
    createdAt,
    domains,
  }
  return { ...payload, payloadSha256: sha256(canonicalJson(payload)) }
}

export function validateBundle(value: StorageExportBundle): void {
  if (value.format !== STORAGE_EXPORT_FORMAT || value.upstreamCommit !== HARNESS_UPSTREAM_COMMIT) {
    throw new Error('storage export format or Harness pin is incompatible')
  }
  if (!['sqlite', 'json', 'postgres'].includes(value.source?.kind)) throw new Error('storage export source kind is unknown')
  const { payloadSha256, ...payload } = value
  if (sha256(canonicalJson(payload)) !== payloadSha256) throw new Error('storage export payload checksum mismatch')
  const names = new Set<string>()
  for (const domain of value.domains) {
    if (names.has(domain.descriptor.name)) throw new Error(`duplicate exported domain '${domain.descriptor.name}'`)
    names.add(domain.descriptor.name)
    if (sha256(canonicalJson({ descriptor: domain.descriptor, snapshot: domain.snapshot })) !== domain.sha256) {
      throw new Error(`storage export domain checksum mismatch for '${domain.descriptor.name}'`)
    }
  }
}

export function bundleRecordCount(bundle: StorageExportBundle): number {
  return bundle.domains.reduce((total, domain) =>
    total + Object.values(domain.snapshot.tables).reduce((sum, table) => sum + Object.keys(table).length, 0), 0)
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Byte order of the UTF-8 encoding: exactly what `COLLATE "C"` compares. */
export function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value !== null && typeof value === 'object') {
    // UTF-8 BYTE order, locale-independent, and the same order PostgreSQL gives
    // under `COLLATE "C"` — the backup reads records straight from a cursor in
    // that order. `localeCompare` would depend on the machine's ICU, and JS `<`
    // compares UTF-16 code units, which disagrees with byte order for any key
    // outside the BMP: an emoji sorts one way here and the other way in the
    // database, and a single such key would seal a bundle that fails its own
    // validator.
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => compareUtf8(left, right))
      .map(([key, nested]) => [key, sortValue(nested)]))
  }
  return value
}

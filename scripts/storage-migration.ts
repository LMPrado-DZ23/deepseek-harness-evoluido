import { createHash } from 'node:crypto'
import type { DomainSpec } from '@deepseek-ai/dsh-storage-domain'
import { descriptorOf } from '@deepseek-ai/dsh-storage-domain'
import type { KvUnitDescriptor, StorageBackend } from '@deepseek-ai/dsh-storage'

export const STORAGE_EXPORT_FORMAT = 'dz23-studio-kv-export/v1'
export const HARNESS_UPSTREAM_COMMIT = '6c705be1ce6774a000d061da41d1823b03a3d42c'

export interface ExportedDomain {
  descriptor: KvUnitDescriptor
  snapshot: { tables: Record<string, Record<string, unknown>>; global: unknown }
  sha256: string
}

export interface StorageExportBundle {
  format: typeof STORAGE_EXPORT_FORMAT
  upstreamCommit: typeof HARNESS_UPSTREAM_COMMIT
  source: { kind: 'sqlite'; sha256: string }
  createdAt: string
  domains: ExportedDomain[]
  payloadSha256: string
}

export async function exportStorage(
  backend: StorageBackend,
  specs: readonly DomainSpec[],
  sourceSha256: string,
  createdAt = new Date().toISOString(),
): Promise<StorageExportBundle> {
  if (backend.kv === undefined) throw new Error('source backend has no KV facet')
  const domains: ExportedDomain[] = []
  try {
    for (const spec of specs) {
      const descriptor = descriptorOf(spec)
      const unit = await backend.kv.open(descriptor)
      try {
        const snapshot = await unit.loadAll()
        domains.push({ descriptor, snapshot, sha256: sha256(canonicalJson({ descriptor, snapshot })) })
      } finally {
        await unit.close()
      }
    }
  } finally {
    await backend.close()
  }
  const payload: Omit<StorageExportBundle, 'payloadSha256'> = {
    format: STORAGE_EXPORT_FORMAT,
    upstreamCommit: HARNESS_UPSTREAM_COMMIT,
    source: { kind: 'sqlite', sha256: sourceSha256 },
    createdAt,
    domains,
  }
  return { ...payload, payloadSha256: sha256(canonicalJson(payload)) }
}

export async function importStorage(backend: StorageBackend, bundle: StorageExportBundle): Promise<void> {
  validateBundle(bundle)
  if (backend.kv === undefined) throw new Error('target backend has no KV facet')
  try {
    for (const domain of bundle.domains) {
      const unit = await backend.kv.open(domain.descriptor)
      try {
        const empty = await unit.loadAll()
        if (Object.values(empty.tables).some(table => Object.keys(table as Record<string, unknown>).length > 0) || empty.global !== null) {
          throw new Error(`target unit '${domain.descriptor.name}' is not empty`)
        }
        for (const [table, records] of Object.entries(domain.snapshot.tables)) {
          for (const [key, value] of Object.entries(records)) await unit.putRecord(table, key, value)
        }
        if (domain.descriptor.hasGlobal && domain.snapshot.global !== null) await unit.setGlobal(domain.snapshot.global)
        const restored = await unit.loadAll()
        const restoredHash = sha256(canonicalJson({ descriptor: domain.descriptor, snapshot: restored }))
        if (restoredHash !== domain.sha256) throw new Error(`checksum mismatch after importing '${domain.descriptor.name}'`)
      } finally {
        await unit.close()
      }
    }
  } finally {
    await backend.close()
  }
}

export function validateBundle(value: StorageExportBundle): void {
  if (value.format !== STORAGE_EXPORT_FORMAT || value.upstreamCommit !== HARNESS_UPSTREAM_COMMIT) {
    throw new Error('storage export format or Harness pin is incompatible')
  }
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

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortValue(nested)]))
  }
  return value
}

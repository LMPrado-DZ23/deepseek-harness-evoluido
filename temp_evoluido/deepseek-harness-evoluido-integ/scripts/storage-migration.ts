import type { DomainSpec } from '@deepseek-ai/dsh-storage-domain'
import { descriptorOf } from '@deepseek-ai/dsh-storage-domain'
import type { StorageBackend } from '@deepseek-ai/dsh-storage'
import {
  canonicalJson, exportedDomain, sealBundle, sha256, validateBundle,
  type ExportedDomain, type StorageExportBundle, type StorageExportSourceKind,
} from '../plugins/storage-postgres/src/bundle.ts'

export {
  HARNESS_UPSTREAM_COMMIT, STORAGE_EXPORT_FORMAT, canonicalJson, sha256, validateBundle,
  type ExportedDomain, type StorageExportBundle, type StorageExportSourceKind,
} from '../plugins/storage-postgres/src/bundle.ts'

export async function exportStorage(
  backend: StorageBackend,
  specs: readonly DomainSpec[],
  sourceSha256: string,
  createdAt = new Date().toISOString(),
  sourceKind: StorageExportSourceKind = 'sqlite',
): Promise<StorageExportBundle> {
  if (backend.kv === undefined) throw new Error('source backend has no KV facet')
  const domains: ExportedDomain[] = []
  try {
    for (const spec of specs) {
      const descriptor = descriptorOf(spec)
      const unit = await backend.kv.open(descriptor)
      try {
        const snapshot = await unit.loadAll()
        domains.push(exportedDomain(descriptor, snapshot))
      } finally {
        await unit.close()
      }
    }
  } finally {
    await backend.close()
  }
  return sealBundle({ kind: sourceKind, sha256: sourceSha256 }, domains, createdAt)
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

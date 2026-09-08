import type { KvUnitDescriptor } from '@deepseek-ai/dsh-storage';
/**
 * Logical export format shared by the SQLite/JSON → PostgreSQL migration, the
 * hot PostgreSQL snapshot and the scheduled backups. One format, one
 * validator, one restore path (scripts/import-postgres-storage.ts).
 */
export declare const STORAGE_EXPORT_FORMAT = "dz23-studio-kv-export/v1";
export declare const HARNESS_UPSTREAM_COMMIT = "6c705be1ce6774a000d061da41d1823b03a3d42c";
export type StorageExportSourceKind = 'sqlite' | 'json' | 'postgres';
export interface ExportedDomain {
    descriptor: KvUnitDescriptor;
    snapshot: {
        tables: Record<string, Record<string, unknown>>;
        global: unknown;
    };
    sha256: string;
}
export interface StorageExportBundle {
    format: typeof STORAGE_EXPORT_FORMAT;
    upstreamCommit: typeof HARNESS_UPSTREAM_COMMIT;
    source: {
        kind: StorageExportSourceKind;
        sha256: string;
    };
    createdAt: string;
    /** Logical identity of the installation that owns the exported schema. */
    installation?: string;
    domains: ExportedDomain[];
    payloadSha256: string;
}
export interface StorageBundleLimits {
    maxDomains: number;
    maxRecords: number;
    maxDepth: number;
}
/** Import limits are deliberately finite: a checksummed file is not necessarily a safe file. */
export declare const DEFAULT_STORAGE_BUNDLE_LIMITS: Readonly<StorageBundleLimits>;
export declare function exportedDomain(descriptor: KvUnitDescriptor, snapshot: ExportedDomain['snapshot']): ExportedDomain;
export declare function sealBundle(source: StorageExportBundle['source'], domains: ExportedDomain[], createdAt: string, installation?: string): StorageExportBundle;
export declare function validateBundle(value: unknown, limits?: Readonly<StorageBundleLimits>): asserts value is StorageExportBundle;
/**
 * Fingerprint of a unit's DECLARED shape. Persisted next to the unit on the
 * medium so a backup can carry the declaration itself instead of guessing it
 * back from whichever rows happen to exist, and so a hand-edited `units` row
 * is detected instead of silently believed.
 */
export declare function descriptorFingerprint(descriptor: KvUnitDescriptor): string;
export declare function bundleRecordCount(bundle: StorageExportBundle): number;
export declare function canonicalJson(value: unknown): string;
export declare function sha256(value: string | Buffer): string;
/** Byte order of the UTF-8 encoding: exactly what `COLLATE "C"` compares. */
export declare function compareUtf8(left: string, right: string): number;
//# sourceMappingURL=bundle.d.ts.map
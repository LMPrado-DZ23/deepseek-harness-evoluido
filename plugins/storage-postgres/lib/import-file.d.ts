import { type StorageBundleLimits, type StorageExportBundle } from './bundle.js';
export declare const IMPORT_MAX_BYTES_DEFAULT: number;
export interface StorageImportLimits extends StorageBundleLimits {
    maxBytes: number;
}
export declare const DEFAULT_STORAGE_IMPORT_LIMITS: Readonly<StorageImportLimits>;
export interface VerifiedStorageBundle {
    readonly bundle: StorageExportBundle;
    readonly inputSha256: string;
    readonly bytes: number;
    readonly file: string;
}
/**
 * Read an import through one descriptor. Size and syntactic nesting are
 * enforced while bytes arrive, before JSON.parse can allocate an attacker-
 * controlled object graph. The strict bundle schema and semantic quotas run
 * before the caller is allowed to connect to or mutate PostgreSQL.
 */
export declare function readStorageBundleFile(path: string, limits?: Readonly<StorageImportLimits>): Promise<StorageExportBundle>;
/**
 * Verification and parsing share one descriptor. The pathname is never opened
 * once for the digest and again for the restore, so a replacement cannot turn
 * a verified backup into a different, still-valid bundle.
 */
export declare function readVerifiedStorageBundleFile(path: string, limits?: Readonly<StorageImportLimits>, signal?: AbortSignal): Promise<VerifiedStorageBundle>;
//# sourceMappingURL=import-file.d.ts.map
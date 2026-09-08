import type { StorageExportBundle } from './bundle.js';
import { type TlsPolicy } from './dsn.js';
export declare function assertRestoreIntent(write: boolean, safetyBackup: string | undefined): void;
export declare function assertRestorableBundle(bundle: StorageExportBundle): void;
export declare function assertReplacementAllowed(targetHasContent: boolean, force: boolean, confirmation: string | undefined): void;
export declare function assertDomainLossAllowed(wouldBeLost: readonly string[], allowed: boolean, confirmation: string | undefined): void;
export interface RestoreRecordLoss {
    readonly domain: string;
    readonly recordsInBackup: number;
    readonly recordsInTarget: number;
    readonly globalWouldBeLost: boolean;
}
export declare function assertRecordLossAllowed(losses: readonly RestoreRecordLoss[], allowed: boolean, confirmation: string | undefined): void;
export declare function assertUnknownObjectsAllowed(unknownObjects: readonly string[], allowed: boolean, confirmation: string | undefined): void;
export declare function assertForeignInstallationAllowed(backupInstallation: string | null | undefined, targetInstallation: string | null | undefined, allowed: boolean, confirmation: string | undefined): void;
/** Pure process boundary: no connection string is ever an argv item. */
export declare function postgresDumpInvocation(dsn: string, schema: string, ssl: TlsPolicy, environment?: NodeJS.ProcessEnv): {
    command: 'pg_dump';
    args: string[];
    environment: NodeJS.ProcessEnv;
};
//# sourceMappingURL=restore-policy.d.ts.map
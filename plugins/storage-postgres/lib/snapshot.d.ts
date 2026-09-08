import { Client } from 'pg';
import type { KvUnitDescriptor } from '@deepseek-ai/dsh-storage';
import { type StorageExportBundle } from './bundle.js';
export interface SnapshotOptions {
    connectionString: string;
    ssl: false | {
        rejectUnauthorized: boolean;
    };
    schema: string;
    /**
     * Units to snapshot. When given, each stamped unit must match its declared
     * version. When omitted, descriptors are derived from the medium itself:
     * every stamped unit, with the tables actually holding records and a
     * global slot when one is stored — enough for a complete restore.
     */
    descriptors?: readonly KvUnitDescriptor[];
    /** Diagnostic snapshots are bounded; large production backups use backup-worker's cursors. */
    maxDomains?: number;
    maxRecords?: number;
    now?: () => Date;
}
export interface UnitRow {
    name: string;
    version: number;
    tables: string[] | null;
    has_global: boolean | null;
    descriptor_sha256: string | null;
}
export interface RecordRow {
    unit: string;
    table_name: string;
    key: string;
    value: unknown;
}
export interface GlobalRow {
    unit: string;
    value: unknown;
}
/**
 * Hot logical snapshot of every Studio unit in one REPEATABLE READ, READ ONLY
 * transaction. It never takes the unit writer lock, so it runs while the
 * Studio is serving requests; the running writer keeps its lease and the
 * snapshot is a consistent point-in-time view of the whole schema.
 */
export declare function snapshotPostgresStorage(options: SnapshotOptions): Promise<StorageExportBundle>;
/** Read the logical installation identity without aborting a snapshot of an older schema. */
export declare function readInstallation(client: Client, schema: string): Promise<string | undefined>;
/** Build a read-only projection that also works before additive columns existed. */
export declare function unitsProjection(client: Client, schema: string): Promise<string>;
/**
 * The descriptor of each unit, from the DECLARATION stamped on the medium when
 * the unit was opened, widened by whatever the rows actually show.
 *
 * Inference alone lost every declared-but-empty table and every `hasGlobal`
 * that had not been written yet, so a restore came back with a narrower shape
 * than the product declares. The stored declaration fixes that; the union with
 * the observed tables makes sure no stored row is ever left undeclared, and a
 * row written by an older build (no declaration stored) still degrades to pure
 * inference instead of failing.
 */
export declare function deriveDescriptors(units: readonly UnitRow[], records: readonly RecordRow[], globals: readonly GlobalRow[]): KvUnitDescriptor[];
/** One unit's descriptor: the stamped declaration checked against its fingerprint, widened by what is on the medium. */
export declare function storedDescriptor(unit: UnitRow, observedTables: ReadonlySet<string> | undefined, observedGlobal: boolean): KvUnitDescriptor;
//# sourceMappingURL=snapshot.d.ts.map
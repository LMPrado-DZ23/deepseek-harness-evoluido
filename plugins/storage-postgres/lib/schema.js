import { randomUUID } from 'node:crypto';
import { StorageError, UNIT_NAME_RE } from '@deepseek-ai/dsh-storage';
export const STORAGE_POSTGRES_LAYOUT_VERSION = 1;
export const INSTALLATION_ID_KEY = 'installation_id';
export const POSTGRES_SCHEMA_MAX_LENGTH = 40;
export const POSTGRES_IDENTIFIER_MAX_LENGTH = 63;
export function assertIdentifier(value, label) {
    if (!UNIT_NAME_RE.test(value))
        throw new Error(`${label} '${value}' violates ${UNIT_NAME_RE}`);
    if (value.length > POSTGRES_IDENTIFIER_MAX_LENGTH) {
        throw new Error(`${label} exceeds the ${String(POSTGRES_IDENTIFIER_MAX_LENGTH)} character limit`);
    }
}
export function assertConfiguredSchemaName(value) {
    assertIdentifier(value, 'postgres schema');
    if (value.length > POSTGRES_SCHEMA_MAX_LENGTH) {
        throw new Error(`postgres schema exceeds the ${String(POSTGRES_SCHEMA_MAX_LENGTH)} character limit`);
    }
}
export function quoteIdentifier(value) {
    assertIdentifier(value, 'postgres identifier');
    return `"${value}"`;
}
export function storageUnitLockName(schema, unit) {
    assertIdentifier(schema, 'postgres schema');
    if (!UNIT_NAME_RE.test(unit))
        throw new Error(`kv unit name '${unit}' violates ${UNIT_NAME_RE}`);
    return `dz23-storage-unit:${schema}:${unit}`;
}
/**
 * Schema-wide maintenance lock. A running Studio holds it in SHARED mode for
 * as long as it is up; restore and migration take it EXCLUSIVE. That is what
 * makes "the Studio is still running" a refusal even when the incoming bundle
 * mentions none of the units the Studio has open — per-unit locks alone would
 * leave those units unprotected in front of a `DROP SCHEMA`.
 */
export function storageMaintenanceLockName(schema) {
    assertIdentifier(schema, 'postgres schema');
    return `dz23-storage-maintenance:${schema}`;
}
export function recordsTable(schema) {
    return `${quoteIdentifier(schema)}."records"`;
}
export function globalsTable(schema) {
    return `${quoteIdentifier(schema)}."unit_globals"`;
}
export function unitsTable(schema) {
    return `${quoteIdentifier(schema)}."units"`;
}
export function leasesTable(schema) {
    return `${quoteIdentifier(schema)}."unit_leases"`;
}
export function tenantRecordsTable(schema) {
    return `${quoteIdentifier(schema)}."tenant_records"`;
}
/** Create and version the physical layout under a database advisory lock. */
export async function ensureSchema(pool, schema) {
    assertIdentifier(schema, 'postgres schema');
    const client = await pool.connect();
    const lockName = `dz23-storage-schema:${schema}`;
    try {
        await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockName]);
        await createLayout(client, schema);
    }
    finally {
        /* v8 ignore next -- unlock failure cannot supersede the schema error and session release also drops the lock. */
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockName]).catch(() => undefined);
        client.release();
    }
}
async function createLayout(client, schema) {
    const quoted = quoteIdentifier(schema);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoted}`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${quoted}."storage_meta" (
    key TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  )`);
    // Additive and nullable so an older schema remains readable before upgrade.
    await client.query(`ALTER TABLE ${quoted}."storage_meta" ADD COLUMN IF NOT EXISTS text_value TEXT`);
    const version = await client.query(`SELECT value FROM ${quoted}."storage_meta" WHERE key = 'layout_version'`);
    const onDisk = version.rows[0]?.value;
    if (onDisk !== undefined && onDisk !== STORAGE_POSTGRES_LAYOUT_VERSION) {
        throw new StorageError('version-mismatch', `postgres storage schema '${schema}' has layout version ${String(onDisk)}, incompatible with this build (${String(STORAGE_POSTGRES_LAYOUT_VERSION)})`);
    }
    await client.query(`CREATE TABLE IF NOT EXISTS ${unitsTable(schema)} (
    name TEXT PRIMARY KEY,
    version INTEGER NOT NULL CHECK (version >= 0)
  )`);
    // The DECLARED shape of each unit, stamped when it is opened. Without it a
    // backup can only infer the descriptor from the rows that happen to exist,
    // which silently drops a declared-but-empty table and a `hasGlobal` slot that
    // was never written — a restore would then come back with a different shape
    // than the one the product declares. Added as nullable columns on purpose:
    // a schema written by an older build keeps working and simply falls back to
    // inference until each unit is opened once, so the physical layout version
    // does not change.
    for (const column of ['tables JSONB', 'has_global BOOLEAN', 'descriptor_sha256 TEXT']) {
        await client.query(`ALTER TABLE ${unitsTable(schema)} ADD COLUMN IF NOT EXISTS ${column}`);
    }
    await client.query(`CREATE TABLE IF NOT EXISTS ${recordsTable(schema)} (
    unit TEXT NOT NULL REFERENCES ${unitsTable(schema)}(name) ON DELETE CASCADE,
    table_name TEXT NOT NULL,
    key TEXT NOT NULL,
    value JSONB NOT NULL,
    PRIMARY KEY (unit, table_name, key)
  )`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${globalsTable(schema)} (
    unit TEXT PRIMARY KEY REFERENCES ${unitsTable(schema)}(name) ON DELETE CASCADE,
    value JSONB NOT NULL
  )`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${leasesTable(schema)} (
    unit TEXT PRIMARY KEY,
    holder TEXT NOT NULL,
    acquired_at TIMESTAMPTZ NOT NULL,
    heartbeat_at TIMESTAMPTZ NOT NULL
  )`);
    if (onDisk === undefined) {
        await client.query(`INSERT INTO ${quoted}."storage_meta" (key, value) VALUES ('layout_version', $1)`, [STORAGE_POSTGRES_LAYOUT_VERSION]);
    }
    // The logical installation identity is created once and is never rewritten by startup.
    await client.query(`INSERT INTO ${quoted}."storage_meta" (key, value, text_value) VALUES ($1, 0, $2) ON CONFLICT (key) DO NOTHING`, [INSTALLATION_ID_KEY, randomUUID()]);
}

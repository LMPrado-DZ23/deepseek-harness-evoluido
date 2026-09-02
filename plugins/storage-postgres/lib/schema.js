import { StorageError, UNIT_NAME_RE } from '@deepseek-ai/dsh-storage';
export const STORAGE_POSTGRES_LAYOUT_VERSION = 1;
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
    const version = await client.query(`SELECT value FROM ${quoted}."storage_meta" WHERE key = 'layout_version'`);
    const onDisk = version.rows[0]?.value;
    if (onDisk !== undefined && onDisk !== STORAGE_POSTGRES_LAYOUT_VERSION) {
        throw new StorageError('version-mismatch', `postgres storage schema '${schema}' has layout version ${String(onDisk)}, incompatible with this build (${String(STORAGE_POSTGRES_LAYOUT_VERSION)})`);
    }
    await client.query(`CREATE TABLE IF NOT EXISTS ${unitsTable(schema)} (
    name TEXT PRIMARY KEY,
    version INTEGER NOT NULL CHECK (version >= 0)
  )`);
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
}

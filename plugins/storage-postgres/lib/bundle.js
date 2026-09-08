import { createHash } from 'node:crypto';
/**
 * Logical export format shared by the SQLite/JSON → PostgreSQL migration, the
 * hot PostgreSQL snapshot and the scheduled backups. One format, one
 * validator, one restore path (scripts/import-postgres-storage.ts).
 */
export const STORAGE_EXPORT_FORMAT = 'dz23-studio-kv-export/v1';
export const HARNESS_UPSTREAM_COMMIT = '6c705be1ce6774a000d061da41d1823b03a3d42c';
/** Import limits are deliberately finite: a checksummed file is not necessarily a safe file. */
export const DEFAULT_STORAGE_BUNDLE_LIMITS = Object.freeze({
    maxDomains: 2_048,
    maxRecords: 5_000_000,
    maxDepth: 64,
});
export function exportedDomain(descriptor, snapshot) {
    return { descriptor, snapshot, sha256: sha256(canonicalJson({ descriptor, snapshot })) };
}
export function sealBundle(source, domains, createdAt, installation) {
    const payload = {
        format: STORAGE_EXPORT_FORMAT,
        upstreamCommit: HARNESS_UPSTREAM_COMMIT,
        source,
        createdAt,
        domains,
        ...(installation === undefined ? {} : { installation }),
    };
    return { ...payload, payloadSha256: sha256(canonicalJson(payload)) };
}
export function validateBundle(value, limits = DEFAULT_STORAGE_BUNDLE_LIMITS) {
    assertLimits(limits);
    assertPlainObject(value, 'storage export');
    const topLevelKeys = ['format', 'upstreamCommit', 'source', 'createdAt', 'domains', 'payloadSha256'];
    if ('installation' in value)
        topLevelKeys.push('installation');
    assertExactKeys(value, topLevelKeys, 'storage export');
    if (value.format !== STORAGE_EXPORT_FORMAT || value.upstreamCommit !== HARNESS_UPSTREAM_COMMIT) {
        throw new Error('storage export format or Harness pin is incompatible');
    }
    assertPlainObject(value.source, 'storage export source');
    assertExactKeys(value.source, ['kind', 'sha256'], 'storage export source');
    if (!['sqlite', 'json', 'postgres'].includes(String(value.source.kind)))
        throw new Error('storage export source kind is unknown');
    assertSha256(value.source.sha256, 'storage export source checksum');
    if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)))
        throw new Error('storage export creation time is invalid');
    if ('installation' in value && (typeof value.installation !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.installation))) {
        throw new Error('storage export installation identity is invalid');
    }
    if (!Array.isArray(value.domains))
        throw new Error('storage export domains must be an array');
    if (value.domains.length > limits.maxDomains)
        throw new Error(`storage export exceeds the ${String(limits.maxDomains)} domain limit`);
    assertSha256(value.payloadSha256, 'storage export payload checksum');
    const names = new Set();
    let records = 0;
    for (const domain of value.domains) {
        assertPlainObject(domain, 'exported domain');
        assertExactKeys(domain, ['descriptor', 'snapshot', 'sha256'], 'exported domain');
        assertPlainObject(domain.descriptor, 'exported domain descriptor');
        assertExactKeys(domain.descriptor, ['name', 'version', 'tables', 'hasGlobal'], 'exported domain descriptor');
        if (typeof domain.descriptor.name !== 'string' || !/^[a-z][a-z0-9_]*$/u.test(domain.descriptor.name))
            throw new Error('exported domain name is invalid');
        if (!Number.isInteger(domain.descriptor.version) || Number(domain.descriptor.version) < 0)
            throw new Error(`exported domain '${domain.descriptor.name}' version is invalid`);
        if (!Array.isArray(domain.descriptor.tables) || domain.descriptor.tables.some(table => typeof table !== 'string' || !/^[a-z][a-z0-9_]*$/u.test(table))) {
            throw new Error(`exported domain '${domain.descriptor.name}' tables are invalid`);
        }
        if (new Set(domain.descriptor.tables).size !== domain.descriptor.tables.length)
            throw new Error(`exported domain '${domain.descriptor.name}' has duplicate tables`);
        if (typeof domain.descriptor.hasGlobal !== 'boolean')
            throw new Error(`exported domain '${domain.descriptor.name}' hasGlobal is invalid`);
        assertPlainObject(domain.snapshot, `snapshot for '${domain.descriptor.name}'`);
        assertExactKeys(domain.snapshot, ['tables', 'global'], `snapshot for '${domain.descriptor.name}'`);
        assertPlainObject(domain.snapshot.tables, `tables for '${domain.descriptor.name}'`);
        assertExactKeys(domain.snapshot.tables, domain.descriptor.tables, `tables for '${domain.descriptor.name}'`);
        for (const table of domain.descriptor.tables) {
            const tableRecords = domain.snapshot.tables[table];
            assertPlainObject(tableRecords, `table '${domain.descriptor.name}.${table}'`);
            records += Object.keys(tableRecords).length;
            if (records > limits.maxRecords)
                throw new Error(`storage export exceeds the ${String(limits.maxRecords)} record limit`);
            for (const [key, record] of Object.entries(tableRecords)) {
                if (key.length === 0)
                    throw new Error(`table '${domain.descriptor.name}.${table}' contains an empty record key`);
                assertJsonDepth(record, limits.maxDepth, `record '${domain.descriptor.name}.${table}.${key}'`);
            }
        }
        if (!domain.descriptor.hasGlobal && domain.snapshot.global !== null) {
            throw new Error(`exported domain '${domain.descriptor.name}' has a global value but declares no global slot`);
        }
        assertJsonDepth(domain.snapshot.global, limits.maxDepth, `global value for '${domain.descriptor.name}'`);
        assertSha256(domain.sha256, `checksum for '${domain.descriptor.name}'`);
        if (names.has(domain.descriptor.name))
            throw new Error(`duplicate exported domain '${domain.descriptor.name}'`);
        names.add(domain.descriptor.name);
    }
    // Only canonicalise after strict shape and depth checks. Otherwise a deeply
    // nested but checksummed payload could exhaust the stack inside sortValue
    // before the validator reached its nesting quota.
    const { payloadSha256, ...payload } = value;
    if (sha256(canonicalJson(payload)) !== payloadSha256)
        throw new Error('storage export payload checksum mismatch');
    for (const domain of value.domains) {
        if (sha256(canonicalJson({ descriptor: domain.descriptor, snapshot: domain.snapshot })) !== domain.sha256) {
            throw new Error(`storage export domain checksum mismatch for '${domain.descriptor.name}'`);
        }
    }
}
function assertLimits(limits) {
    for (const [name, limit] of Object.entries(limits)) {
        if (!Number.isSafeInteger(limit) || limit < 1)
            throw new Error(`storage bundle ${name} must be a positive safe integer`);
    }
}
function assertPlainObject(value, label) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        throw new Error(`${label} must be an object`);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        throw new Error(`${label} must be a plain object`);
}
function assertExactKeys(value, expected, label) {
    const actual = Object.keys(value).sort(compareUtf8);
    const wanted = [...expected].sort(compareUtf8);
    if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
        throw new Error(`${label} has unknown or missing fields`);
    }
}
function assertSha256(value, label) {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value))
        throw new Error(`${label} is invalid`);
}
function assertJsonDepth(value, maxDepth, label) {
    const pending = [{ value, depth: 0 }];
    while (pending.length > 0) {
        const current = pending.pop();
        if (current.depth > maxDepth)
            throw new Error(`${label} exceeds the ${String(maxDepth)} nesting-depth limit`);
        if (current.value === null || typeof current.value === 'string' || typeof current.value === 'boolean')
            continue;
        if (typeof current.value === 'number') {
            if (!Number.isFinite(current.value))
                throw new Error(`${label} contains a non-finite number`);
            continue;
        }
        if (typeof current.value !== 'object')
            throw new Error(`${label} contains a value that JSON cannot represent`);
        for (const nested of Array.isArray(current.value) ? current.value : Object.values(current.value)) {
            pending.push({ value: nested, depth: current.depth + 1 });
        }
    }
}
/**
 * Fingerprint of a unit's DECLARED shape. Persisted next to the unit on the
 * medium so a backup can carry the declaration itself instead of guessing it
 * back from whichever rows happen to exist, and so a hand-edited `units` row
 * is detected instead of silently believed.
 */
export function descriptorFingerprint(descriptor) {
    return sha256(canonicalJson({ hasGlobal: descriptor.hasGlobal, name: descriptor.name, tables: [...descriptor.tables].sort(compareUtf8), version: descriptor.version }));
}
export function bundleRecordCount(bundle) {
    return bundle.domains.reduce((total, domain) => total + Object.values(domain.snapshot.tables).reduce((sum, table) => sum + Object.keys(table).length, 0), 0);
}
export function canonicalJson(value) {
    return JSON.stringify(sortValue(value));
}
export function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}
/** Byte order of the UTF-8 encoding: exactly what `COLLATE "C"` compares. */
export function compareUtf8(left, right) {
    return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}
function sortValue(value) {
    if (Array.isArray(value))
        return value.map(sortValue);
    if (value !== null && typeof value === 'object') {
        // UTF-8 BYTE order, locale-independent, and the same order PostgreSQL gives
        // under `COLLATE "C"` — the backup reads records straight from a cursor in
        // that order. `localeCompare` would depend on the machine's ICU, and JS `<`
        // compares UTF-16 code units, which disagrees with byte order for any key
        // outside the BMP: an emoji sorts one way here and the other way in the
        // database, and a single such key would seal a bundle that fails its own
        // validator.
        return Object.fromEntries(Object.entries(value).sort(([left], [right]) => compareUtf8(left, right))
            .map(([key, nested]) => [key, sortValue(nested)]));
    }
    return value;
}

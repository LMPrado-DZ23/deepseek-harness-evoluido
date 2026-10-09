import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { posix } from 'node:path';
import { isBuilderRuntimeScopeId, isInstallationId } from './runtime-scope.js';
const REGISTRY_KEYS = ['generation', 'installation_id', 'slots', 'version'];
const SLOT_KEYS = ['config_ref', 'config_sha256', 'scope_id', 'state'];
const MAX_REGISTRY_BYTES = 512 * 1024;
const MAX_SLOTS = 512;
export class BuilderRuntimeRegistryError extends Error {
    code = 'INVALID_RUNTIME_REGISTRY';
    constructor() { super('INVALID_RUNTIME_REGISTRY'); }
}
const DEFAULT_RUNTIME = {
    platform: process.platform,
    uid: process.getuid?.(),
    noFollowFlag: constants.O_NOFOLLOW,
    open,
    lstat,
    realpath,
};
export function builderRuntimeRegistryPath(roots) {
    if (!canonicalRoot(roots.configRoot))
        return invalid();
    return posix.join(roots.configRoot, 'manager', 'runtime-registry.json');
}
export async function loadBuilderRuntimeRegistry(registryReference, roots, runtime = DEFAULT_RUNTIME) {
    try {
        if (runtime.platform !== 'linux' || runtime.uid === undefined)
            invalid();
        const expectedPath = builderRuntimeRegistryPath(roots);
        const path = referencePath(registryReference);
        if (path !== expectedPath)
            invalid();
        const bytes = await readSecureManagerFile(path, MAX_REGISTRY_BYTES, runtime);
        return parseBuilderRuntimeRegistryBytes(bytes, roots);
    }
    catch (error) {
        if (error instanceof BuilderRuntimeRegistryError)
            throw error;
        throw new BuilderRuntimeRegistryError();
    }
}
export function parseBuilderRuntimeRegistryBytes(bytes, roots) {
    try {
        if (bytes.byteLength < 1 || bytes.byteLength > MAX_REGISTRY_BYTES || bytes.includes(0))
            invalid();
        const raw = decodeUtf8(bytes);
        const value = strictRecord(JSON.parse(raw), REGISTRY_KEYS);
        if (value.version !== 1 || !isInstallationId(value.installation_id) || !Number.isSafeInteger(value.generation) || Number(value.generation) < 0)
            invalid();
        if (!Array.isArray(value.slots) || value.slots.length > MAX_SLOTS)
            invalid();
        const scopes = new Set();
        const references = new Set();
        const slots = value.slots.map(item => {
            const slot = strictRecord(item, SLOT_KEYS);
            if (!isBuilderRuntimeScopeId(slot.scope_id) || typeof slot.config_sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(slot.config_sha256) || (slot.state !== 'active' && slot.state !== 'retiring'))
                invalid();
            const expectedConfig = posix.join(roots.configRoot, 'instances', slot.scope_id, 'supervisor.json');
            if (typeof slot.config_ref !== 'string' || referencePath(slot.config_ref) !== expectedConfig)
                invalid();
            if (scopes.has(slot.scope_id) || references.has(slot.config_ref))
                invalid();
            scopes.add(slot.scope_id);
            references.add(slot.config_ref);
            return { scopeId: slot.scope_id, configReference: slot.config_ref, configSha256: slot.config_sha256, state: slot.state };
        });
        return {
            version: 1,
            installationId: value.installation_id,
            generation: Number(value.generation),
            slots,
            sha256: createHash('sha256').update(bytes).digest('hex'),
        };
    }
    catch (error) {
        if (error instanceof BuilderRuntimeRegistryError)
            throw error;
        throw new BuilderRuntimeRegistryError();
    }
}
async function readSecureManagerFile(path, maximumBytes, runtime) {
    let handle;
    try {
        handle = await runtime.open(path, constants.O_RDONLY | runtime.noFollowFlag);
        const opened = await handle.stat();
        const linked = await runtime.lstat(path);
        if (!opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 1 || opened.size < 1 || opened.size > maximumBytes)
            invalid();
        if (!linked.isFile() || linked.isSymbolicLink() || linked.dev !== opened.dev || linked.ino !== opened.ino || linked.nlink !== opened.nlink || linked.uid !== opened.uid || linked.gid !== opened.gid || linked.mode !== opened.mode || await runtime.realpath(path) !== path)
            invalid();
        const mode = opened.mode & 0o7777;
        if ((opened.uid !== 0 && opened.uid !== runtime.uid) || (opened.mode & 0o022) !== 0 || (mode !== 0o400 && mode !== 0o600 && mode !== 0o640))
            invalid();
        const value = await handle.readFile();
        if (value.byteLength === 0 || value.includes(0))
            invalid();
        return value;
    }
    finally {
        await handle?.close();
    }
}
function decodeUtf8(value) {
    try {
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(value);
        return decoded;
    }
    catch {
        return invalid();
    }
}
function strictRecord(value, keys) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return invalid();
    const row = value;
    if (Object.keys(row).sort().join('\0') !== [...keys].sort().join('\0'))
        invalid();
    return row;
}
function referencePath(reference) {
    if (typeof reference !== 'string' || !reference.startsWith('file:'))
        return invalid();
    const path = reference.slice(5);
    if (!posix.isAbsolute(path) || path.includes('\\') || path.includes('\0') || path.includes('://') || posix.normalize(path) !== path || path.endsWith('/'))
        return invalid();
    return path;
}
function canonicalRoot(path) {
    return posix.isAbsolute(path) && path !== '/' && !path.includes('\\') && !path.includes('\0') && !path.includes('://') && posix.normalize(path) === path && !path.endsWith('/');
}
function invalid() { throw new BuilderRuntimeRegistryError(); }
//# sourceMappingURL=manager-registry.js.map
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, posix } from 'node:path';
import { isBuilderRuntimeScopeId } from './runtime-scope.js';
export class MemoryBuilderRuntimeHealthStore {
    values = new Map();
    async write(value) { this.values.set(value.scope_id, value); }
}
export class FileBuilderRuntimeHealthStore {
    root;
    uid;
    makeDirectory;
    constructor(root, uid = process.getuid?.(), makeDirectory = mkdir) {
        this.root = root;
        this.uid = uid;
        this.makeDirectory = makeDirectory;
    }
    async write(value) {
        if (process.platform !== 'linux' || this.uid === undefined || !isBuilderRuntimeScopeId(value.scope_id))
            throw new Error('INVALID_HEALTH_STORE');
        validateHealth(value);
        const directory = posix.join(this.root, value.scope_id);
        await ensurePrivateDirectory(this.root, this.uid, this.makeDirectory);
        await ensurePrivateDirectory(directory, this.uid, this.makeDirectory);
        const target = posix.join(directory, 'health.json');
        const temporary = posix.join(directory, `.health-${randomBytes(16).toString('hex')}`);
        let handle;
        try {
            handle = await open(temporary, 'wx', 0o600);
            await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
            await handle.sync();
            await handle.close();
            handle = undefined;
            await assertReplaceable(target, this.uid);
            await rename(temporary, target);
            await assertSafeFile(target, this.uid);
            const directoryHandle = await open(directory, 'r');
            try {
                await directoryHandle.sync();
            }
            finally {
                await directoryHandle.close();
            }
        }
        finally {
            await handle?.close();
            await unlink(temporary).catch(() => undefined);
        }
    }
}
export function runtimeHealth(scopeId, state, previous, code = 'NONE', now = new Date()) {
    const timestamp = now.toISOString();
    return { version: 1, scope_id: scopeId, state, since: previous?.state === state ? previous.since : timestamp, updated_at: timestamp, code };
}
export function sanitizeRuntimeHealthCode(error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
    if (code === 'BLOCKED_EXTERNAL' || code === 'EXTERNAL_DEPENDENCY' || code === 'SLOT_START_TIMEOUT' || code === 'LISTENER_INITIALIZATION_TIMEOUT')
        return { state: 'BLOCKED_EXTERNAL', code: 'EXTERNAL_DEPENDENCY' };
    if (code === 'INVALID_SUPERVISOR_CONFIGURATION' || code === 'INVALID_RUNTIME_REGISTRY')
        return { state: 'DEGRADED', code: 'CONFIG_INVALID' };
    return { state: 'DEGRADED', code: 'START_FAILED' };
}
function validateHealth(value) {
    const keys = Object.keys(value).sort().join('\0');
    if (keys !== ['code', 'scope_id', 'since', 'state', 'updated_at', 'version'].join('\0') || value.version !== 1 || !isBuilderRuntimeScopeId(value.scope_id))
        throw new Error('INVALID_HEALTH_RECORD');
    if (typeof value.state !== 'string' || typeof value.code !== 'string' || typeof value.since !== 'string' || typeof value.updated_at !== 'string' || !['STARTING', 'HEALTHY', 'DEGRADED', 'RETIRING', 'STOPPED', 'BLOCKED_EXTERNAL'].includes(value.state) || !['NONE', 'START_FAILED', 'CONFIG_INVALID', 'DRAIN_FAILED', 'SHUTDOWN_FAILED', 'EXTERNAL_DEPENDENCY'].includes(value.code))
        throw new Error('INVALID_HEALTH_RECORD');
    if (!validDate(value.since) || !validDate(value.updated_at))
        throw new Error('INVALID_HEALTH_RECORD');
}
async function ensurePrivateDirectory(path, uid, makeDirectory) {
    if (!posix.isAbsolute(path) || path === '/' || posix.normalize(path) !== path || path.includes('\\') || path.includes('\0'))
        throw new Error('INVALID_HEALTH_STORE');
    const missing = [];
    let current = path;
    while (true) {
        try {
            await lstat(current);
            break;
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw new Error('INVALID_HEALTH_STORE');
            missing.push(current);
            current = dirname(current);
        }
    }
    await validateDirectoryAncestors(current, uid);
    for (const directory of missing.reverse()) {
        try {
            await makeDirectory(directory, { mode: 0o700 });
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw new Error('INVALID_HEALTH_STORE');
        }
        await assertPrivateDirectory(directory, uid);
    }
    await assertPrivateDirectory(path, uid);
}
async function assertPrivateDirectory(path, uid) {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077) !== 0 || await realpath(path) !== path)
        throw new Error('INVALID_HEALTH_STORE');
}
async function validateDirectoryAncestors(path, uid) {
    let current = path;
    while (true) {
        const stat = await lstat(current);
        const stickyRoot = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
        if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.uid !== 0 && stat.uid !== uid) || ((stat.mode & 0o022) !== 0 && !stickyRoot))
            throw new Error('INVALID_HEALTH_STORE');
        const parent = dirname(current);
        if (parent === current)
            return;
        current = parent;
    }
}
async function assertReplaceable(path, uid) {
    try {
        await assertSafeFile(path, uid);
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw new Error('INVALID_HEALTH_STORE');
    }
}
async function assertSafeFile(path, uid) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const opened = await handle.stat();
        const linked = await lstat(path);
        if (!opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 1 || opened.uid !== uid || (opened.mode & 0o177) !== 0 || linked.dev !== opened.dev || linked.ino !== opened.ino || linked.nlink !== opened.nlink || linked.uid !== opened.uid || linked.mode !== opened.mode || await realpath(path) !== path || dirname(path) === path)
            throw new Error('INVALID_HEALTH_STORE');
    }
    finally {
        await handle.close();
    }
}
function validDate(value) {
    const parsed = new Date(value);
    return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
}
//# sourceMappingURL=manager-health.js.map
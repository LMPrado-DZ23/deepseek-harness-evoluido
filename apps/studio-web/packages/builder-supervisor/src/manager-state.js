import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, statfs, unlink } from 'node:fs/promises';
import { dirname, posix } from 'node:path';
import { isBuilderRuntimeScopeId, isInstallationId } from './runtime-scope.js';
const FLOCK_PATH = '/usr/bin/flock';
const FLOCK_BUSY_EXIT = 75;
const FLOCK_TIMEOUT_MS = 2_000;
const CHECKPOINT_MAX_BYTES = 512 * 1024;
const MAX_SLOTS = 512;
const FILESYSTEMS = new Set([0xef53, 0x58465342]);
const CHECKPOINT_KEYS = ['generation', 'installation_id', 'registry_sha256', 'slots', 'version'];
const SLOT_KEYS = ['config_ref', 'config_sha256', 'scope_id'];
export class BuilderManagerStateError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
    }
}
const DEFAULT_STATE_RUNTIME = { spawnFlock: spawn, getuid: () => process.getuid?.(), open, lstat, mkdir, readdir, realpath, rename, statfs, unlink };
export class MemoryBuilderManagerLeasePort {
    #held = false;
    async acquire() {
        if (this.#held)
            throw new BuilderManagerStateError('MANAGER_ALREADY_RUNNING');
        this.#held = true;
        return { close: async () => { this.#held = false; } };
    }
}
export class MemoryBuilderManagerCheckpointPort {
    value;
    async load() { return this.value; }
    async save(value) { this.value = structuredClone(value); }
}
export class FileBuilderManagerAuthority {
    #heldInstallation;
    #runtime;
    constructor(runtime = {}) { this.#runtime = { ...DEFAULT_STATE_RUNTIME, ...runtime }; }
    async acquire(installationId, roots) {
        try {
            if (this.#heldInstallation !== undefined)
                throw new BuilderManagerStateError('MANAGER_ALREADY_RUNNING');
            const { directory, guard } = managerPaths(installationId, roots);
            const uid = linuxUid(this.#runtime);
            assertNotWindowsMount(directory);
            await ensurePrivateDirectory(directory, uid, this.#runtime);
            await assertLocalFilesystem(directory, this.#runtime);
            await assertTrustedFlock(this.#runtime);
            const opened = await openPermanentGuard(guard, directory, uid, this.#runtime);
            try {
                await acquireFlock(opened.handle, this.#runtime.spawnFlock);
                await assertFileIdentity(guard, opened.identity, uid, 0o600, this.#runtime);
            }
            catch (error) {
                try {
                    await opened.handle.close();
                }
                catch {
                    this.#heldInstallation = installationId;
                    throw new BuilderManagerStateError('INVALID_MANAGER_STATE');
                }
                throw error;
            }
            this.#heldInstallation = installationId;
            let closed = false;
            let closing;
            return { close: async () => {
                    if (closed)
                        return;
                    closing ??= (async () => {
                        await assertFileIdentity(guard, opened.identity, uid, 0o600, this.#runtime);
                        await opened.handle.close();
                        closed = true;
                        this.#heldInstallation = undefined;
                    })();
                    try {
                        await closing;
                    }
                    catch {
                        closing = undefined;
                        throw new BuilderManagerStateError('INVALID_MANAGER_STATE');
                    }
                } };
        }
        catch (error) {
            if (error instanceof BuilderManagerStateError)
                throw error;
            throw new BuilderManagerStateError('INVALID_MANAGER_STATE');
        }
    }
    async load(installationId, roots) {
        try {
            if (this.#heldInstallation !== installationId)
                invalid();
            const { checkpoint } = managerPaths(installationId, roots);
            let handle;
            try {
                handle = await this.#runtime.open(checkpoint, constants.O_RDONLY | constants.O_NOFOLLOW);
            }
            catch (error) {
                if (error.code === 'ENOENT')
                    return undefined;
                throw error;
            }
            try {
                const bytes = await readSecure(handle, checkpoint, linuxUid(this.#runtime), CHECKPOINT_MAX_BYTES, this.#runtime);
                return parseCheckpoint(decodeUtf8(bytes), installationId, roots);
            }
            finally {
                await handle.close();
            }
        }
        catch (error) {
            if (error instanceof BuilderManagerStateError)
                throw error;
            throw new BuilderManagerStateError('INVALID_MANAGER_STATE');
        }
    }
    async save(value, roots) {
        try {
            if (this.#heldInstallation !== value.installationId)
                invalid();
            validateCheckpoint(value, roots);
            const { directory, checkpoint } = managerPaths(value.installationId, roots);
            const uid = linuxUid(this.#runtime);
            await ensurePrivateDirectory(directory, uid, this.#runtime);
            await assertExistingCheckpoint(checkpoint, uid, this.#runtime);
            const temporary = posix.join(directory, `.checkpoint-${randomBytes(16).toString('hex')}`);
            let handle;
            try {
                handle = await this.#runtime.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
                await handle.writeFile(`${JSON.stringify(serializeCheckpoint(value))}\n`, 'utf8');
                await handle.sync();
                await handle.close();
                handle = undefined;
                await this.#runtime.rename(temporary, checkpoint);
                const published = await this.#runtime.open(checkpoint, constants.O_RDONLY | constants.O_NOFOLLOW);
                try {
                    await readSecure(published, checkpoint, uid, CHECKPOINT_MAX_BYTES, this.#runtime);
                }
                finally {
                    await published.close();
                }
                await syncDirectory(directory, this.#runtime);
            }
            finally {
                await handle?.close();
                await this.#runtime.unlink(temporary).catch(() => undefined);
            }
        }
        catch (error) {
            if (error instanceof BuilderManagerStateError)
                throw error;
            throw new BuilderManagerStateError('INVALID_MANAGER_STATE');
        }
    }
}
function managerPaths(installationId, roots) {
    if (!isInstallationId(installationId) || !canonicalRoot(roots.stateRoot) || !canonicalRoot(roots.configRoot))
        invalid();
    const directory = posix.join(roots.stateRoot, 'manager', installationId);
    return { directory, guard: posix.join(directory, '.manager.guard'), checkpoint: posix.join(directory, 'checkpoint.json') };
}
async function openPermanentGuard(path, directory, uid, runtime) {
    let creator;
    let handle;
    try {
        try {
            handle = await runtime.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
            const entries = await runtime.readdir(directory);
            if (entries.length === 0) {
                try {
                    creator = await runtime.open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
                }
                catch (createError) {
                    if (createError.code !== 'EEXIST')
                        throw createError;
                }
                if (creator !== undefined) {
                    await creator.sync();
                    await creator.close();
                    creator = undefined;
                    await syncDirectory(directory, runtime);
                }
            }
            else if (!entries.includes(posix.basename(path)))
                invalid();
            handle = await runtime.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        }
        const identity = await handle.stat();
        await assertFileIdentity(path, identity, uid, 0o600, runtime);
        return { handle, identity };
    }
    catch (error) {
        let cleanupFailed = false;
        for (const opened of [creator, handle])
            if (opened !== undefined)
                try {
                    await opened.close();
                }
                catch {
                    cleanupFailed = true;
                }
        if (cleanupFailed)
            invalid();
        throw error;
    }
}
async function acquireFlock(handle, spawnFlock) {
    const outcome = await new Promise(resolve => {
        const child = spawnFlock(FLOCK_PATH, ['--exclusive', '--nonblock', '--conflict-exit-code', String(FLOCK_BUSY_EXIT), '3'], {
            env: {}, shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', handle.fd], timeout: FLOCK_TIMEOUT_MS, killSignal: 'SIGKILL',
        });
        let settled = false;
        const finish = (code, signal) => { if (settled)
            return; settled = true; resolve({ code, signal }); };
        child.once('error', () => finish(null, null));
        child.once('exit', finish);
    });
    if (outcome.code === 0 && outcome.signal === null)
        return;
    if (outcome.code === FLOCK_BUSY_EXIT && outcome.signal === null)
        throw new BuilderManagerStateError('MANAGER_ALREADY_RUNNING');
    invalid();
}
function parseCheckpoint(raw, installationId, roots) {
    const value = record(JSON.parse(raw), CHECKPOINT_KEYS);
    if (value.version !== 1 || value.installation_id !== installationId || !Number.isSafeInteger(value.generation) || Number(value.generation) < 0 || typeof value.registry_sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.registry_sha256) || !Array.isArray(value.slots) || value.slots.length > MAX_SLOTS)
        invalid();
    const scopes = new Set();
    const references = new Set();
    const slots = value.slots.map(item => {
        const slot = record(item, SLOT_KEYS);
        if (!isBuilderRuntimeScopeId(slot.scope_id) || typeof slot.config_sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(slot.config_sha256) || typeof slot.config_ref !== 'string')
            invalid();
        const expected = `file:${posix.join(roots.configRoot, 'instances', slot.scope_id, 'supervisor.json')}`;
        if (slot.config_ref !== expected || scopes.has(slot.scope_id) || references.has(slot.config_ref))
            invalid();
        scopes.add(slot.scope_id);
        references.add(slot.config_ref);
        return { scopeId: slot.scope_id, configReference: slot.config_ref, configSha256: slot.config_sha256 };
    });
    return { version: 1, installationId, generation: Number(value.generation), registrySha256: value.registry_sha256, slots };
}
function validateCheckpoint(value, roots) {
    record(value, ['generation', 'installationId', 'registrySha256', 'slots', 'version']);
    if (!Array.isArray(value.slots))
        invalid();
    for (const slot of value.slots)
        record(slot, ['configReference', 'configSha256', 'scopeId']);
    parseCheckpoint(JSON.stringify(serializeCheckpoint(value)), value.installationId, roots);
}
function serializeCheckpoint(value) {
    return { version: value.version, installation_id: value.installationId, generation: value.generation, registry_sha256: value.registrySha256, slots: value.slots.map(slot => ({ scope_id: slot.scopeId, config_ref: slot.configReference, config_sha256: slot.configSha256 })) };
}
async function readSecure(handle, path, uid, maximum, runtime) {
    const opened = await handle.stat();
    const linked = await runtime.lstat(path);
    if (!opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 1 || opened.uid !== uid || (opened.mode & 0o7777) !== 0o600 || opened.size < 1 || opened.size > maximum || !sameFile(opened, linked) || await runtime.realpath(path) !== path)
        invalid();
    const bytes = await handle.readFile();
    if (bytes.includes(0))
        invalid();
    return bytes;
}
async function assertExistingCheckpoint(path, uid, runtime) {
    let handle;
    try {
        handle = await runtime.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return;
        throw error;
    }
    try {
        await readSecure(handle, path, uid, CHECKPOINT_MAX_BYTES, runtime);
    }
    finally {
        await handle.close();
    }
}
async function assertFileIdentity(path, expected, uid, mode, runtime) {
    const linked = await runtime.lstat(path);
    if (!expected.isFile() || expected.isSymbolicLink() || expected.nlink !== 1 || expected.uid !== uid || expected.size !== 0 || (expected.mode & 0o7777) !== mode || !sameFile(expected, linked) || expected.size !== linked.size || expected.ctimeMs !== linked.ctimeMs || await runtime.realpath(path) !== path)
        invalid();
}
async function ensurePrivateDirectory(path, uid, runtime) {
    const missing = [];
    let current = path;
    while (true) {
        try {
            await runtime.lstat(current);
            break;
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
            missing.push(current);
            current = dirname(current);
        }
    }
    await validateAncestors(current, uid, runtime);
    for (const directory of missing.reverse()) {
        try {
            await runtime.mkdir(directory, { mode: 0o700 });
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
        }
        await assertPrivateDirectory(directory, uid, runtime);
    }
    await assertPrivateDirectory(path, uid, runtime);
}
async function assertPrivateDirectory(path, uid, runtime) {
    const stat = await runtime.lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077) !== 0 || await runtime.realpath(path) !== path)
        invalid();
}
async function validateAncestors(path, uid, runtime) {
    let current = path;
    while (true) {
        const stat = await runtime.lstat(current);
        const stickyRoot = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
        if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.uid !== 0 && stat.uid !== uid) || ((stat.mode & 0o022) !== 0 && !stickyRoot))
            invalid();
        const parent = dirname(current);
        if (parent === current)
            return;
        current = parent;
    }
}
function assertNotWindowsMount(path) { if (path === '/mnt' || path.startsWith('/mnt/'))
    invalid(); }
async function assertLocalFilesystem(path, runtime) {
    const type = (await runtime.statfs(path)).type;
    if (!FILESYSTEMS.has(Number(type)))
        invalid();
}
async function assertTrustedFlock(runtime) {
    const handle = await runtime.open(FLOCK_PATH, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const opened = await handle.stat();
        const linked = await runtime.lstat(FLOCK_PATH);
        if (!opened.isFile() || opened.isSymbolicLink() || opened.uid !== 0 || opened.nlink !== 1 || (opened.mode & 0o022) !== 0 || (opened.mode & 0o111) === 0 || !sameFile(opened, linked) || await runtime.realpath(FLOCK_PATH) !== FLOCK_PATH)
            invalid();
    }
    finally {
        await handle.close();
    }
}
async function syncDirectory(path, runtime) { const handle = await runtime.open(path, 'r'); try {
    await handle.sync();
}
finally {
    await handle.close();
} }
function decodeUtf8(value) { try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
}
catch {
    return invalid();
} }
function record(value, keys) { if (typeof value !== 'object' || value === null || Array.isArray(value))
    return invalid(); const row = value; if (Object.keys(row).sort().join('\0') !== [...keys].sort().join('\0'))
    invalid(); return row; }
function canonicalRoot(path) { return posix.isAbsolute(path) && path !== '/' && !path.includes('\\') && !path.includes('\0') && !path.includes('://') && posix.normalize(path) === path && !path.endsWith('/'); }
function sameFile(left, right) { return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.gid === right.gid && left.mode === right.mode && left.nlink === right.nlink; }
function linuxUid(runtime) { const uid = runtime.getuid(); if (uid === undefined)
    return invalid(); return uid; }
function invalid() { throw new BuilderManagerStateError('INVALID_MANAGER_STATE'); }
//# sourceMappingURL=manager-state.js.map
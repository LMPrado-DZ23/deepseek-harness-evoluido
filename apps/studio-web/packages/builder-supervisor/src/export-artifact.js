import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { BuilderSupervisorError } from './model.js';
const BLOCK = 512;
const PAX_MAX_BYTES = 64 * 1024;
/** Chaves PAX que só descrevem metadados que a extração ignora. */
const PAX_CHAVES_INOFENSIVAS = new Set(['mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname']);
const MAX_FILES = 20_000;
const MAX_BYTES = 512 * 1024 * 1024;
export function currentExportIdentity(platform, getuid) { return { platform, uid: getuid === undefined ? undefined : getuid() }; }
const DEFAULT_RUNTIME = { lstat, mkdir, open, readdir, realpath, rename, remove: rm, writeFile, noFollowFlag: constants.O_NOFOLLOW, ...currentExportIdentity(process.platform, process.getuid), randomHex: () => randomBytes(8).toString('hex') };
export async function openManagedExportArchive(exportRoot, buildRef, runtime = DEFAULT_RUNTIME) {
    if (!/^build_[a-f0-9]{32}$/u.test(buildRef))
        invalid();
    const root = resolve(exportRoot);
    await prepareExportDirectories(root, runtime);
    const path = resolve(root, `.archive-${buildRef}-${runtime.randomHex()}.tar`);
    assertExportPathBeneath(root, path);
    const handle = await runtime.open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | runtime.noFollowFlag, 0o600);
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1)
            invalid();
        return { path, handle, dev: stat.dev, ino: stat.ino };
    }
    catch (error) {
        await handle.close();
        await runtime.remove(path, { force: true }).catch(() => undefined);
        throw error;
    }
}
export async function readValidatedPublishedArtifact(exportRoot, buildRef, runtime = DEFAULT_RUNTIME) {
    if (!/^build_[a-f0-9]{32}$/u.test(buildRef))
        invalid();
    const root = resolve(exportRoot);
    await prepareExportDirectories(root, runtime);
    return readPublished(resolve(root, 'exports', buildRef), root, buildRef, runtime);
}
export async function listManagedExportArchives(exportRoot, runtime = DEFAULT_RUNTIME) {
    const root = resolve(exportRoot);
    await prepareExportDirectories(root, runtime);
    const refs = new Set();
    for (const entry of await runtime.readdir(root, { withFileTypes: true })) {
        const match = /^\.archive-(build_[a-f0-9]{32})-[a-f0-9]{16}\.tar$/u.exec(entry.name);
        if (match === null)
            continue;
        const path = resolve(root, entry.name);
        await assertManagedArchive(path, entry, runtime);
        refs.add(match[1]);
    }
    const parent = resolve(root, 'exports');
    for (const entry of await runtime.readdir(parent, { withFileTypes: true })) {
        const match = /^\.stage-(build_[a-f0-9]{32})-[a-f0-9]{16}$/u.exec(entry.name);
        if (match === null)
            continue;
        const path = resolve(parent, entry.name);
        if (!entry.isDirectory() || entry.isSymbolicLink())
            invalid();
        await assertOwnedDirectory(path, runtime);
        refs.add(match[1]);
    }
    return [...refs].sort();
}
export async function cleanupManagedExportResources(exportRoot, buildRef, signal, runtime = DEFAULT_RUNTIME) {
    if (buildRef !== undefined && !/^build_[a-f0-9]{32}$/u.test(buildRef))
        invalid();
    const root = resolve(exportRoot);
    await prepareExportDirectories(root, runtime);
    const parent = resolve(root, 'exports');
    for (const entry of await runtime.readdir(root, { withFileTypes: true })) {
        signal.throwIfAborted();
        const match = /^\.archive-(build_[a-f0-9]{32})-[a-f0-9]{16}\.tar$/u.exec(entry.name);
        if (match === null || (buildRef !== undefined && match[1] !== buildRef))
            continue;
        const path = resolve(root, entry.name);
        await assertManagedArchive(path, entry, runtime);
        await runtime.remove(path);
        await syncDirectory(root, runtime);
    }
    for (const entry of await runtime.readdir(parent, { withFileTypes: true })) {
        signal.throwIfAborted();
        const stage = /^\.stage-(build_[a-f0-9]{32})-[a-f0-9]{16}$/u.exec(entry.name);
        const orphan = /^\.orphan-[a-f0-9]{16}$/u.test(entry.name);
        if (!orphan && (stage === null || (buildRef !== undefined && stage[1] !== buildRef)))
            continue;
        const path = resolve(parent, entry.name);
        if (!entry.isDirectory() || entry.isSymbolicLink())
            invalid();
        await assertOwnedDirectory(path, runtime);
        const quarantine = orphan ? path : resolve(parent, `.orphan-${runtime.randomHex()}`);
        if (!orphan) {
            await runtime.rename(path, quarantine);
            await syncDirectory(parent, runtime);
        }
        await runtime.remove(quarantine, { recursive: true });
        await syncDirectory(parent, runtime);
    }
}
export async function publishValidatedDockerArchive(exportRoot, buildRef, archivePath, signal, runtime = DEFAULT_RUNTIME, expected) {
    if (!/^build_[a-f0-9]{32}$/u.test(buildRef))
        invalid();
    const root = resolve(exportRoot);
    await prepareExportDirectories(root, runtime);
    const final = resolve(root, 'exports', buildRef);
    const parent = dirname(final);
    await runtime.mkdir(parent, { recursive: true, mode: 0o700 });
    await assertOwnedDirectory(parent, runtime);
    const existing = await readPublished(final, root, buildRef, runtime);
    if (existing !== undefined)
        return existing;
    const stage = resolve(parent, `.stage-${buildRef}-${runtime.randomHex()}`);
    await runtime.mkdir(stage, { mode: 0o700 });
    try {
        const extracted = await extractTar(archivePath, stage, signal, runtime, expected);
        await assertRequiredExport(stage, runtime);
        const result = await verifyPublishedTree(stage, runtime);
        if (result.files !== extracted.files || result.bytes !== extracted.bytes)
            invalid();
        const published = { relative_path: `exports/${buildRef}`, ...result };
        const manifest = await runtime.open(resolve(stage, '.dz23-artifact.json'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | runtime.noFollowFlag, 0o600);
        try {
            await writeAll(manifest, Buffer.from(`${JSON.stringify({ build_ref: buildRef, ...published })}\n`, 'utf8'));
            await manifest.sync();
        }
        finally {
            await manifest.close();
        }
        await syncTreeDirectories(stage, runtime);
        await runtime.rename(stage, final);
        await syncDirectory(parent, runtime);
        return published;
    }
    catch (error) {
        const orphan = resolve(parent, `.orphan-${runtime.randomHex()}`);
        await runtime.rename(stage, orphan).then(async () => { await syncDirectory(parent, runtime); await runtime.remove(orphan, { recursive: true }); await syncDirectory(parent, runtime); }).catch(() => undefined);
        if (error.code === 'EEXIST')
            throw new BuilderSupervisorError('EXPORT_INVALID');
        throw error;
    }
}
export async function enforceExportRetention(exportRoot, currentBuildRef, pinnedBuildRefs, maximumExports, maximumBytes, signal, runtime = DEFAULT_RUNTIME) {
    if (!Number.isSafeInteger(maximumExports) || maximumExports < 1 || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1)
        throw new Error('INVALID_EXPORT_RETENTION');
    if (!/^build_[a-f0-9]{32}$/u.test(currentBuildRef))
        invalid();
    const root = resolve(exportRoot);
    const parent = resolve(root, 'exports');
    await assertOwnedDirectory(root, runtime);
    await assertOwnedDirectory(parent, runtime);
    const rows = [];
    for (const entry of await runtime.readdir(parent, { withFileTypes: true })) {
        signal.throwIfAborted();
        if (/^\.orphan-[a-f0-9]{16}$/u.test(entry.name)) {
            if (!entry.isDirectory() || entry.isSymbolicLink())
                invalid();
            const orphan = resolve(parent, entry.name);
            assertExportPathBeneath(root, orphan);
            await assertOwnedDirectory(orphan, runtime);
            await runtime.remove(orphan, { recursive: true });
            await syncDirectory(parent, runtime);
            continue;
        }
        if (/^\.stage-build_[a-f0-9]{32}-[a-f0-9]{16}$/u.test(entry.name)) {
            if (!entry.isDirectory() || entry.isSymbolicLink())
                invalid();
            const stage = resolve(parent, entry.name);
            assertExportPathBeneath(root, stage);
            const stat = await runtime.lstat(stage);
            if (!stat.isDirectory() || stat.isSymbolicLink() || await runtime.realpath(stage) !== stage)
                invalid();
            const quarantine = resolve(parent, `.orphan-${runtime.randomHex()}`);
            await runtime.rename(stage, quarantine);
            await syncDirectory(parent, runtime);
            await runtime.remove(quarantine, { recursive: true });
            await syncDirectory(parent, runtime);
            continue;
        }
        if (!entry.isDirectory() || entry.isSymbolicLink() || !/^build_[a-f0-9]{32}$/u.test(entry.name))
            invalid();
        const path = resolve(parent, entry.name);
        assertExportPathBeneath(root, path);
        const stat = await runtime.lstat(path);
        if (!stat.isDirectory() || stat.isSymbolicLink() || await runtime.realpath(path) !== path)
            invalid();
        if (await readPublished(path, root, entry.name, runtime) === undefined)
            invalid();
        rows.push({ path, buildRef: entry.name, bytes: await measuredDirectoryBytes(path, maximumBytes, signal, runtime), mtimeMs: stat.mtimeMs });
    }
    const current = rows.find(row => row.buildRef === currentBuildRef);
    if (current === undefined || current.bytes > maximumBytes)
        throw new BuilderSupervisorError('CAPACITY_EXCEEDED');
    let total = rows.reduce((sum, row) => sum + row.bytes, 0);
    let count = rows.length;
    for (const row of rows.filter(item => item.buildRef !== currentBuildRef && !pinnedBuildRefs.has(item.buildRef)).sort((left, right) => left.mtimeMs - right.mtimeMs || left.buildRef.localeCompare(right.buildRef))) {
        if (count <= maximumExports && total <= maximumBytes)
            break;
        const stat = await runtime.lstat(row.path);
        if (!stat.isDirectory() || stat.isSymbolicLink() || await runtime.realpath(row.path) !== row.path)
            invalid();
        await runtime.remove(row.path, { recursive: true });
        await syncDirectory(parent, runtime);
        total -= row.bytes;
        count -= 1;
    }
    if (count > maximumExports || total > maximumBytes)
        throw new BuilderSupervisorError('CAPACITY_EXCEEDED');
}
async function extractTar(archivePath, stage, signal, runtime, expected) {
    const archive = await runtime.open(archivePath, constants.O_RDONLY | runtime.noFollowFlag);
    const names = new Set();
    let offset = 0;
    let files = 0;
    let bytes = 0;
    let terminated = false;
    let paxPath;
    let paxPendente = false;
    try {
        const archiveBefore = await archive.stat();
        if (!archiveBefore.isFile() || archiveBefore.nlink !== 1)
            invalid();
        if (expected !== undefined) {
            if (archiveBefore.dev !== expected.dev || archiveBefore.ino !== expected.ino || archiveBefore.size !== expected.size || await hashFile(archive, archiveBefore.size, signal) !== expected.sha256)
                throw new BuilderSupervisorError('ARTIFACT_CHANGED_DURING_STAGE');
        }
        while (offset + BLOCK <= archiveBefore.size) {
            signal.throwIfAborted();
            const header = Buffer.alloc(BLOCK);
            if ((await archive.read(header, 0, BLOCK, offset)).bytesRead !== BLOCK)
                invalid();
            offset += BLOCK;
            if (header.every(byte => byte === 0)) {
                if (paxPendente)
                    invalid();
                const second = Buffer.alloc(BLOCK);
                if ((await archive.read(second, 0, BLOCK, offset)).bytesRead !== BLOCK || !second.every(byte => byte === 0))
                    invalid();
                offset += BLOCK;
                while (offset < archiveBefore.size) {
                    const trailing = Buffer.alloc(Math.min(64 * 1024, archiveBefore.size - offset));
                    const read = await archive.read(trailing, 0, trailing.byteLength, offset);
                    if (read.bytesRead !== trailing.byteLength)
                        invalid();
                    if (!trailing.every(byte => byte === 0))
                        invalid();
                    offset += trailing.byteLength;
                }
                terminated = true;
                break;
            }
            verifyChecksum(header);
            const size = parseOctal(header.subarray(124, 136));
            const type = String.fromCharCode(header[156] || 48);
            if (type === 'x') {
                // Cabeçalho PAX: o Docker o escreve antes de todo nome que não cabe
                // nos 255 bytes do ustar — e a saída `standalone` com pnpm tem vários
                // (`node_modules/.pnpm/next@16…_react@19…/node_modules/next/dist/…`).
                // Sem ler PAX, toda exportação real era `EXPORT_INVALID`.
                if (paxPendente || size < 1 || size > PAX_MAX_BYTES)
                    invalid();
                const corpo = Buffer.alloc(size);
                if ((await archive.read(corpo, 0, size, offset)).bytesRead !== size)
                    invalid();
                offset += size + (BLOCK - size % BLOCK) % BLOCK;
                paxPath = paxPathOf(corpo);
                paxPendente = true;
                continue;
            }
            const rawName = paxPath ?? `${cstring(header.subarray(345, 500))}${cstring(header.subarray(345, 500)) === '' ? '' : '/'}${cstring(header.subarray(0, 100))}`;
            paxPath = undefined;
            paxPendente = false;
            const name = normalizeTarName(rawName);
            if (name === undefined) {
                if (type !== '5' || size !== 0)
                    invalid();
            }
            else if (type === '5') {
                if (size !== 0 || !allowedExportPath(name, true))
                    invalid();
                await secureDirectory(stage, name, runtime);
            }
            else if (type === '0') {
                if (!allowedExportPath(name, false))
                    invalid();
                if (names.has(name.toLowerCase()))
                    invalid();
                names.add(name.toLowerCase());
                files += 1;
                bytes += size;
                if (files > MAX_FILES || bytes > MAX_BYTES || size > MAX_BYTES)
                    invalid();
                const parent = dirname(resolve(stage, ...name.split('/')));
                await secureDirectory(stage, relative(stage, parent).split(sep).join('/'), runtime);
                const target = resolve(stage, ...name.split('/'));
                assertExportPathBeneath(stage, target);
                const output = await runtime.open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | runtime.noFollowFlag, 0o600);
                try {
                    let remaining = size;
                    while (remaining > 0) {
                        signal.throwIfAborted();
                        const chunk = Buffer.alloc(Math.min(64 * 1024, remaining));
                        const read = await archive.read(chunk, 0, chunk.byteLength, offset);
                        if (read.bytesRead !== chunk.byteLength)
                            invalid();
                        await writeAll(output, chunk);
                        offset += chunk.byteLength;
                        remaining -= chunk.byteLength;
                    }
                    await output.sync();
                }
                finally {
                    await output.close();
                }
            }
            else
                invalid();
            offset += (BLOCK - size % BLOCK) % BLOCK;
        }
        if (files < 1 || !terminated)
            invalid();
        const archiveAfter = await archive.stat();
        if (archiveBefore.dev !== archiveAfter.dev || archiveBefore.ino !== archiveAfter.ino || archiveBefore.size !== archiveAfter.size || archiveBefore.mtimeMs !== archiveAfter.mtimeMs)
            throw new BuilderSupervisorError('ARTIFACT_CHANGED_DURING_STAGE');
        return { files, bytes };
    }
    finally {
        await archive.close();
    }
}
async function secureDirectory(root, name, runtime) {
    let current = root;
    for (const part of name.split('/')) {
        current = resolve(current, part);
        assertExportPathBeneath(root, current);
        try {
            const stat = await runtime.lstat(current);
            if (!stat.isDirectory() || stat.isSymbolicLink())
                invalid();
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
            await runtime.mkdir(current, { mode: 0o700 });
        }
    }
}
async function readPublished(path, root, buildRef, runtime) {
    try {
        assertExportPathBeneath(root, path);
        const stat = await runtime.lstat(path);
        if (!stat.isDirectory() || stat.isSymbolicLink())
            invalid();
        const manifestPath = resolve(path, '.dz23-artifact.json');
        const handle = await runtime.open(manifestPath, constants.O_RDONLY | runtime.noFollowFlag);
        try {
            const value = JSON.parse(await handle.readFile('utf8'));
            if (value.build_ref !== buildRef || value.relative_path !== `exports/${buildRef}` || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256) || !Number.isSafeInteger(value.files) || Number(value.files) < 1 || !Number.isSafeInteger(value.bytes) || Number(value.bytes) < 0)
                invalid();
            const verified = await verifyPublishedTree(path, runtime);
            if (verified.sha256 !== value.sha256 || verified.files !== value.files || verified.bytes !== value.bytes)
                invalid();
            return { relative_path: value.relative_path, sha256: value.sha256, files: Number(value.files), bytes: Number(value.bytes) };
        }
        finally {
            await handle.close();
        }
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    }
}
async function assertOwnedDirectory(path, runtime) {
    if (await runtime.realpath(path) !== path)
        invalid();
    const stat = await runtime.lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink())
        invalid();
    if (runtime.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || (runtime.uid !== undefined && stat.uid !== runtime.uid)))
        invalid();
}
async function assertManagedArchive(path, entry, runtime) { const stat = await runtime.lstat(path); if (!entry.isFile() || entry.isSymbolicLink() || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || await runtime.realpath(path) !== path)
    invalid(); }
async function prepareExportDirectories(root, runtime) { await runtime.mkdir(root, { recursive: true, mode: 0o700 }); await assertOwnedDirectory(root, runtime); const parent = resolve(root, 'exports'); await runtime.mkdir(parent, { recursive: true, mode: 0o700 }); await assertOwnedDirectory(parent, runtime); }
async function hashFile(handle, size, signal) { const hash = createHash('sha256'); let offset = 0; const chunk = Buffer.allocUnsafe(64 * 1024); while (offset < size) {
    signal.throwIfAborted();
    const read = await handle.read(chunk, 0, Math.min(chunk.byteLength, size - offset), offset);
    if (read.bytesRead === 0)
        invalid();
    hash.update(chunk.subarray(0, read.bytesRead));
    offset += read.bytesRead;
} return hash.digest('hex'); }
async function measuredDirectoryBytes(path, maximum, signal, runtime) {
    let total = 0;
    async function walk(directory) {
        for (const entry of await runtime.readdir(directory, { withFileTypes: true })) {
            signal.throwIfAborted();
            const child = resolve(directory, entry.name);
            assertExportPathBeneath(path, child);
            const stat = await runtime.lstat(child);
            if (entry.isSymbolicLink() || stat.isSymbolicLink())
                invalid();
            if (entry.isDirectory() && stat.isDirectory())
                await walk(child);
            else if (entry.isFile() && stat.isFile() && stat.nlink === 1) {
                total += stat.size;
                if (total > maximum)
                    return;
            }
            else
                invalid();
        }
    }
    await walk(path);
    return total;
}
async function verifyPublishedTree(path, runtime) {
    const names = [];
    const folded = new Set();
    async function collect(directory, prefix) {
        for (const entry of (await runtime.readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
            if (prefix === '' && entry.name === '.dz23-artifact.json')
                continue;
            const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
            const child = resolve(directory, entry.name);
            assertExportPathBeneath(path, child);
            const stat = await runtime.lstat(child);
            if (entry.isSymbolicLink() || stat.isSymbolicLink())
                invalid();
            if (entry.isDirectory() && stat.isDirectory()) {
                if (!allowedExportPath(name, true))
                    invalid();
                await collect(child, name);
            }
            else if (entry.isFile() && stat.isFile() && stat.nlink === 1) {
                if (!allowedExportPath(name, false) || folded.has(name.toLowerCase()))
                    invalid();
                folded.add(name.toLowerCase());
                names.push(name);
            }
            else
                invalid();
        }
    }
    await collect(path, '');
    const hash = createHash('sha256');
    let bytes = 0;
    for (const name of names.sort()) {
        const handle = await runtime.open(resolve(path, ...name.split('/')), constants.O_RDONLY | runtime.noFollowFlag);
        try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.nlink !== 1)
                invalid();
            bytes += stat.size;
            hash.update(name).update('\0');
            let position = 0;
            const chunk = Buffer.allocUnsafe(64 * 1024);
            while (position < stat.size) {
                const read = await handle.read(chunk, 0, Math.min(chunk.byteLength, stat.size - position), position);
                if (read.bytesRead === 0)
                    invalid();
                hash.update(chunk.subarray(0, read.bytesRead));
                position += read.bytesRead;
            }
            const after = await handle.stat();
            if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
                invalid();
            hash.update('\0');
        }
        finally {
            await handle.close();
        }
    }
    if (names.length < 1)
        invalid();
    return { sha256: hash.digest('hex'), files: names.length, bytes };
}
async function syncTreeDirectories(path, runtime) {
    if (runtime.platform === 'win32')
        return;
    for (const entry of await runtime.readdir(path, { withFileTypes: true })) {
        const child = resolve(path, entry.name);
        assertExportPathBeneath(path, child);
        const stat = await runtime.lstat(child);
        if (entry.isSymbolicLink() || stat.isSymbolicLink())
            invalid();
        if (entry.isDirectory() && stat.isDirectory())
            await syncTreeDirectories(child, runtime);
        else if (!(entry.isFile() && stat.isFile() && stat.nlink === 1))
            invalid();
    }
    await syncDirectory(path, runtime);
}
function normalizeTarName(value) {
    const name = value.replace(/^\.\//u, '').replace(/\/$/u, '');
    if (name === '' || name === '.')
        return undefined;
    if (name.startsWith('/') || name.includes('\\') || name.includes('\0') || name.split('/').some(part => part === '' || part === '.' || part === '..'))
        invalid();
    return name;
}
function allowedExportPath(name, directory) {
    if (directory && (name === '.next' || name === 'evidence'))
        return true;
    if (name === '.next/standalone' || name.startsWith('.next/standalone/'))
        return directory || name !== '.next/standalone';
    if (name === '.next/static' || name.startsWith('.next/static/'))
        return directory || name !== '.next/static';
    if (name === 'public' || name.startsWith('public/'))
        return directory || name !== 'public';
    return !directory && name === 'evidence/appspec-report.json';
}
async function assertRequiredExport(stage, runtime) {
    const required = [
        [resolve(stage, '.next', 'standalone', 'server.js'), 'file'],
        [resolve(stage, '.next', 'static'), 'directory'],
        [resolve(stage, 'evidence', 'appspec-report.json'), 'file'],
    ];
    for (const [path, kind] of required) {
        const stat = await runtime.lstat(path).catch(() => undefined);
        if (stat === undefined || stat.isSymbolicLink() || (kind === 'file' ? !stat.isFile() : !stat.isDirectory()))
            invalid();
    }
}
/**
 * O NOME de um cabeçalho PAX, e só ele. Qualquer outra chave que mude o
 * sentido da entrada seguinte (`size`, `linkpath`, esparsos do GNU…) é
 * recusa: aceitá-la desalinharia a leitura ou traria um link por outra porta.
 * @param corpo - os registros `<tamanho> <chave>=<valor>\n`.
 * @returns o caminho, ou `undefined` quando o cabeçalho só traz metadados
 *   (a data com fração de segundo, por exemplo) e o nome vem do ustar.
 */
export function paxPathOf(corpo) {
    let posicao = 0;
    let caminho;
    while (posicao < corpo.length) {
        const espaco = corpo.indexOf(0x20, posicao);
        if (espaco < 0)
            invalid();
        const textoDoTamanho = corpo.subarray(posicao, espaco).toString('ascii');
        if (!/^[1-9][0-9]{0,5}$/u.test(textoDoTamanho))
            invalid();
        const tamanho = Number(textoDoTamanho);
        const fim = posicao + tamanho;
        if (fim > corpo.length || corpo[fim - 1] !== 0x0a)
            invalid();
        const registro = corpo.subarray(espaco + 1, fim - 1).toString('utf8');
        const igual = registro.indexOf('=');
        if (igual < 1)
            invalid();
        const chave = registro.slice(0, igual);
        const valor = registro.slice(igual + 1);
        if (chave === 'path') {
            if (caminho !== undefined || valor === '' || valor.includes('\0'))
                invalid();
            caminho = valor;
        }
        else if (!PAX_CHAVES_INOFENSIVAS.has(chave))
            invalid();
        posicao = fim;
    }
    return caminho;
}
function verifyChecksum(header) {
    const expected = parseOctal(header.subarray(148, 156));
    const copy = Buffer.from(header);
    copy.fill(0x20, 148, 156);
    if (copy.reduce((sum, byte) => sum + byte, 0) !== expected)
        invalid();
}
function parseOctal(value) { const text = cstring(value).trim(); if (!/^[0-7]+$/u.test(text))
    invalid(); return Number.parseInt(text, 8); }
function cstring(value) { const zero = value.indexOf(0); return value.subarray(0, zero < 0 ? value.length : zero).toString('utf8'); }
export function assertExportPathBeneath(root, path) { if (path === root || !path.startsWith(root + sep))
    invalid(); }
async function writeAll(handle, value) { let offset = 0; while (offset < value.byteLength) {
    const written = await handle.write(value, offset, value.byteLength - offset);
    if (written.bytesWritten === 0)
        invalid();
    offset += written.bytesWritten;
} }
function invalid() { throw new BuilderSupervisorError('EXPORT_INVALID'); }
async function syncDirectory(path, runtime) { if (runtime.platform === 'win32')
    return; const handle = await runtime.open(path, constants.O_RDONLY); try {
    await handle.sync();
}
finally {
    await handle.close();
} }
//# sourceMappingURL=export-artifact.js.map
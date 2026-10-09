import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, resolve, sep } from 'node:path';
import { BuilderSupervisorError } from './model.js';
const MAX_FILES = 20_000;
const MAX_BYTES = 256 * 1024 * 1024;
export async function createVerifiedBuildArchive(artifactRoot, relativePath, expectedSha256, signal) {
    signal?.throwIfAborted();
    const root = await realpath(artifactRoot);
    await assertNoSymlinkBeneath(root, relativePath);
    const source = await realpath(resolve(root, ...relativePath.split('/')));
    if (!inside(root, source))
        throw new BuilderSupervisorError('ARTIFACT_OUTSIDE_ROOT');
    const sourceBefore = await lstat(source);
    if (!sourceBefore.isDirectory() || sourceBefore.isSymbolicLink())
        throw new BuilderSupervisorError('ARTIFACT_UNSAFE_ENTRY');
    // A ORDEM e a do VALIDADOR, e nao a do idioma de quem roda o build.
    //
    // `walk` ordenava com `localeCompare`, por diretorio; `artifact-ingress`
    // exige que o caminho COMPLETO seja estritamente crescente em unidades
    // UTF-16, e recusa com `ARTIFACT_INVALID` o que chegar fora de ordem. As duas
    // regras discordam para nomes comuns:
    //
    // - `a.js` e `B.js` no mesmo diretorio: `localeCompare` emite `a.js` antes de
    //   `B.js`, e o validador compara `'B.js' <= 'a.js'` (0x42 < 0x61) e recusa;
    // - um diretorio `a/` irmao de um arquivo `a.txt`: a caminhada emite `a/x`
    //   antes de `a.txt`, e `'a.txt' <= 'a/x'` (0x2E < 0x2F) tambem recusa.
    //
    // Falha FECHADA, entao nao e brecha — mas e o caminho de ingestao inteiro
    // recusando artefatos LEGITIMOS, com um erro (`ARTIFACT_INVALID`) que aponta
    // para 'artefato malicioso' e nao para 'ordenacao divergente'. Quem visse
    // isso iria procurar um ataque que nao existe.
    //
    // A ordenacao final e sobre o caminho COMPLETO, e nao por diretorio: so assim
    // o caso `a/` contra `a.txt` sai na ordem que o validador exige.
    const paths = (await walk(source, '', signal)).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    if (paths.length === 0 || paths.length > MAX_FILES)
        throw new BuilderSupervisorError('ARTIFACT_UNSAFE_ENTRY');
    // NFC tambem e exigencia do validador, e um nome criado no macOS costuma
    // chegar em NFD. Recusar AQUI, na producao do artefato, diz onde o problema
    // esta; deixar passar faria o mesmo nome ser recusado la na frente como
    // 'artefato invalido'.
    const denormalized = paths.find(name => name.normalize('NFC') !== name);
    if (denormalized !== undefined)
        throw new BuilderSupervisorError('ARTIFACT_UNSAFE_ENTRY');
    const folded = new Set();
    const hash = createHash('sha256');
    const wireHash = createHash('sha256');
    let total = 0;
    const stage = await mkdtemp(join(tmpdir(), 'dz23-builder-stage-'));
    const archivePath = join(stage, 'input.tar');
    let archive;
    let archiveBytes = 0;
    try {
        archive = await open(archivePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow(), 0o600);
        const directories = new Set();
        for (const name of paths) {
            let current = posix.dirname(name);
            while (current !== '.') {
                directories.add(`${current}/`);
                current = posix.dirname(current);
            }
        }
        const writeArchive = async (value) => {
            wireHash.update(value);
            archiveBytes += await writeAll(archive, value);
        };
        for (const directory of [...directories].sort())
            await writeArchive(tarHeader(directory, 0, '5'));
        for (const name of paths) {
            signal?.throwIfAborted();
            const normalized = name.toLocaleLowerCase('en-US');
            if (folded.has(normalized))
                throw new BuilderSupervisorError('ARTIFACT_UNSAFE_ENTRY');
            folded.add(normalized);
            const path = resolve(source, ...name.split('/'));
            const handle = await open(path, constants.O_RDONLY | noFollow());
            try {
                const before = await handle.stat();
                if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
                    throw new BuilderSupervisorError('ARTIFACT_UNSAFE_ENTRY');
                total += before.size;
                if (total > MAX_BYTES)
                    throw new BuilderSupervisorError('ARTIFACT_UNSAFE_ENTRY');
                hash.update(name).update('\0');
                await writeArchive(tarHeader(name, before.size, '0'));
                const chunk = Buffer.allocUnsafe(64 * 1024);
                let position = 0;
                while (position < before.size) {
                    signal?.throwIfAborted();
                    const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.byteLength, before.size - position), position);
                    if (bytesRead === 0)
                        throw new BuilderSupervisorError('ARTIFACT_CHANGED_DURING_STAGE');
                    const value = chunk.subarray(0, bytesRead);
                    hash.update(value);
                    await writeArchive(value);
                    position += bytesRead;
                }
                hash.update('\0');
                const after = await handle.stat();
                if (position !== before.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
                    throw new BuilderSupervisorError('ARTIFACT_CHANGED_DURING_STAGE');
                const padding = (512 - before.size % 512) % 512;
                if (padding > 0)
                    await writeArchive(Buffer.alloc(padding));
            }
            finally {
                await handle.close();
            }
        }
        const sourceAfter = await lstat(source);
        if (sourceBefore.dev !== sourceAfter.dev || sourceBefore.ino !== sourceAfter.ino || sourceBefore.mtimeMs !== sourceAfter.mtimeMs)
            throw new BuilderSupervisorError('ARTIFACT_CHANGED_DURING_STAGE');
        const sha256 = hash.digest('hex');
        if (expectedSha256 !== undefined && sha256 !== expectedSha256)
            throw new BuilderSupervisorError('ARTIFACT_HASH_MISMATCH');
        await writeArchive(Buffer.alloc(1_024));
        await archive.sync();
        await archive.close();
        archive = undefined;
        return { archivePath, archiveBytes, wireSha256: wireHash.digest('hex'), sha256, files: paths.length, bytes: total, dispose: async () => { await rm(stage, { recursive: true, force: true }); } };
    }
    catch (error) {
        await archive?.close().catch(() => undefined);
        await rm(stage, { recursive: true, force: true });
        throw error;
    }
}
async function walk(root, prefix, signal) {
    signal?.throwIfAborted();
    const before = await lstat(root);
    if (!before.isDirectory() || before.isSymbolicLink() || await realpath(root) !== root)
        throw new BuilderSupervisorError('ARTIFACT_UNSAFE_ENTRY');
    const entries = await readdir(root, { withFileTypes: true });
    const result = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        signal?.throwIfAborted();
        if (entry.isSymbolicLink())
            throw new BuilderSupervisorError('ARTIFACT_UNSAFE_ENTRY');
        const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (!safePath(name))
            throw new BuilderSupervisorError('ARTIFACT_UNSAFE_ENTRY');
        const path = resolve(root, entry.name);
        if (entry.isDirectory())
            result.push(...await walk(path, name, signal));
        else if (entry.isFile())
            result.push(name);
        else
            throw new BuilderSupervisorError('ARTIFACT_UNSAFE_ENTRY');
        if (result.length > MAX_FILES)
            throw new BuilderSupervisorError('ARTIFACT_UNSAFE_ENTRY');
    }
    const after = await lstat(root);
    if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs)
        throw new BuilderSupervisorError('ARTIFACT_CHANGED_DURING_STAGE');
    return result;
}
function tarHeader(name, size, type) {
    const split = splitTarPath(name);
    const header = Buffer.alloc(512);
    text(header, 0, 100, split.name);
    octal(header, 100, 8, type === '5' ? 0o755 : 0o644);
    octal(header, 108, 8, 10_001);
    octal(header, 116, 8, 10_001);
    octal(header, 124, 12, size);
    octal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = type.charCodeAt(0);
    text(header, 257, 6, 'ustar');
    text(header, 263, 2, '00');
    text(header, 345, 155, split.prefix);
    octal(header, 148, 8, header.reduce((sum, byte) => sum + byte, 0));
    return header;
}
function splitTarPath(value) {
    if (Buffer.byteLength(value) <= 100)
        return { name: value, prefix: '' };
    for (let at = value.lastIndexOf('/'); at > 0; at = value.lastIndexOf('/', at - 1)) {
        const prefix = value.slice(0, at);
        const name = value.slice(at + 1);
        if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100)
            return { name, prefix };
    }
    throw new BuilderSupervisorError('ARTIFACT_UNSAFE_ENTRY');
}
function text(target, offset, length, value) {
    const bytes = Buffer.from(value, 'utf8');
    if (bytes.byteLength > length)
        throw new BuilderSupervisorError('ARTIFACT_UNSAFE_ENTRY');
    bytes.copy(target, offset);
}
function octal(target, offset, length, value) {
    const valueText = `${value.toString(8).padStart(length - 1, '0')}\0`;
    text(target, offset, length, valueText);
}
function safePath(value) {
    return value !== '' && !value.startsWith('/') && !value.includes('\\') && !value.includes('\0') && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}
function inside(root, candidate) { return candidate.startsWith(`${root}${sep}`); }
async function assertNoSymlinkBeneath(root, relativePath) {
    let current = root;
    for (const part of relativePath.split('/')) {
        current = resolve(current, part);
        const stat = await lstat(current);
        if (stat.isSymbolicLink())
            throw new BuilderSupervisorError('ARTIFACT_UNSAFE_ENTRY');
    }
}
function noFollow() { return process.platform === 'linux' ? constants.O_NOFOLLOW : 0; }
async function writeAll(handle, value) {
    let offset = 0;
    while (offset < value.byteLength) {
        const { bytesWritten } = await handle.write(value, offset, value.byteLength - offset);
        if (bytesWritten === 0)
            throw new Error('ARCHIVE_WRITE_FAILED');
        offset += bytesWritten;
    }
    return offset;
}
//# sourceMappingURL=artifact.js.map
import { timingSafeEqual } from 'node:crypto';
import { ARTIFACT_UPLOAD_MAX_WIRE_BYTES, ArtifactIngressError, validateUploadRef } from './artifact-ingress.js';
const CONTROL_PATH = '/v1/artifacts/rpc';
const CONTROL_MAX_BYTES = 4 * 1024;
const UPLOAD_PATH = /^\/v1\/artifacts\/(upload_[a-f0-9]{32})$/u;
export function createArtifactIngressHttpHandler(options) {
    if (!/^[A-Za-z0-9_-]{43,200}$/u.test(options.bearerToken))
        throw new Error('INVALID_SUPERVISOR_TOKEN');
    const idleTimeoutMs = timeout(options.idleTimeoutMs ?? 30_000);
    const totalTimeoutMs = timeout(options.totalTimeoutMs ?? 15 * 60_000);
    if (idleTimeoutMs > totalTimeoutMs)
        throw new Error('INVALID_ARTIFACT_TIMEOUT');
    return { handle: async (input) => {
            if (!constantBearer(single(input.headers.authorization), options.bearerToken))
                return json(401, { error: 'UNAUTHORIZED' });
            try {
                if (input.path === CONTROL_PATH) {
                    if (input.method !== 'POST')
                        return json(405, { error: 'METHOD_NOT_ALLOWED' });
                    if (input.headers['transfer-encoding'] !== undefined || input.headers['content-encoding'] !== undefined)
                        return json(400, { error: 'INVALID_REQUEST' });
                    if (single(input.headers['content-type']) !== 'application/json; charset=utf-8')
                        return json(415, { error: 'UNSUPPORTED_MEDIA_TYPE' });
                    const length = contentLength(input.headers['content-length'], CONTROL_MAX_BYTES);
                    const body = await readSmall(input.body, length, input.signal);
                    const command = parseControl(body);
                    if (command.operation === 'artifact.begin') {
                        const result = await options.ingress.begin({ buildId: command.build_id, contentLength: command.content_length, wireSha256: command.wire_sha256 });
                        return json(200, { ok: true, upload_ref: result.uploadRef, state: result.state, idempotent: result.idempotent });
                    }
                    await options.ingress.abort(command.upload_ref);
                    return json(200, { ok: true, state: 'FAILED' });
                }
                const match = UPLOAD_PATH.exec(input.path);
                if (match === null)
                    return json(404, { error: 'NOT_FOUND' });
                if (input.method !== 'PUT')
                    return json(405, { error: 'METHOD_NOT_ALLOWED' });
                if (input.headers['transfer-encoding'] !== undefined || input.headers['content-encoding'] !== undefined)
                    return json(400, { error: 'INVALID_REQUEST' });
                const mediaType = single(input.headers['content-type']);
                if (mediaType !== 'application/x-tar')
                    return json(415, { error: 'UNSUPPORTED_MEDIA_TYPE' });
                const length = contentLength(input.headers['content-length'], ARTIFACT_UPLOAD_MAX_WIRE_BYTES);
                const uploadRef = match[1];
                validateUploadRef(uploadRef);
                const controller = new AbortController();
                const combined = AbortSignal.any([input.signal, controller.signal]);
                const total = setTimeout(() => controller.abort(new Error('ARTIFACT_TOTAL_TIMEOUT')), totalTimeoutMs);
                let idle = setTimeout(() => controller.abort(new Error('ARTIFACT_IDLE_TIMEOUT')), idleTimeoutMs);
                const touch = () => { clearTimeout(idle); idle = setTimeout(() => controller.abort(new Error('ARTIFACT_IDLE_TIMEOUT')), idleTimeoutMs); };
                try {
                    const result = await options.ingress.upload(uploadRef, observed(input.body, touch, combined), length, combined);
                    return json(200, { ok: true, upload_ref: result.uploadRef, state: result.state, idempotent: result.idempotent });
                }
                catch (error) {
                    if (combined.aborted) {
                        await options.ingress.abort(uploadRef);
                        if (!input.signal.aborted)
                            throw new ArtifactIngressError('ARTIFACT_TIMEOUT');
                    }
                    throw error;
                }
                finally {
                    clearTimeout(total);
                    clearTimeout(idle);
                }
            }
            catch (error) {
                if (error instanceof ArtifactIngressError)
                    return json(statusFor(error.code), { ok: false, error: { code: error.code } });
                if (input.signal.aborted)
                    return json(503, { ok: false, error: { code: 'SUPERVISOR_SHUTTING_DOWN' } });
                return json(500, { ok: false, error: { code: 'INTERNAL' } });
            }
        } };
}
function parseControl(bytes) {
    let value;
    try {
        value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes));
    }
    catch {
        throw new ArtifactIngressError('ARTIFACT_INVALID');
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new ArtifactIngressError('ARTIFACT_INVALID');
    const row = value;
    if (row.operation === 'artifact.begin') {
        exact(row, ['build_id', 'content_length', 'operation', 'request_id', 'wire_sha256']);
        if (typeof row.request_id !== 'string' || !/^req_[a-f0-9]{32}$/u.test(row.request_id) || typeof row.build_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u.test(row.build_id) || !Number.isSafeInteger(row.content_length) || Number(row.content_length) < 1 || Number(row.content_length) > ARTIFACT_UPLOAD_MAX_WIRE_BYTES || typeof row.wire_sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(row.wire_sha256))
            throw new ArtifactIngressError('ARTIFACT_INVALID');
        return row;
    }
    if (row.operation === 'artifact.abort') {
        exact(row, ['operation', 'request_id', 'upload_ref']);
        if (typeof row.request_id !== 'string' || !/^req_[a-f0-9]{32}$/u.test(row.request_id) || typeof row.upload_ref !== 'string')
            throw new ArtifactIngressError('ARTIFACT_INVALID');
        validateUploadRef(row.upload_ref);
        return row;
    }
    throw new ArtifactIngressError('ARTIFACT_INVALID');
}
function exact(row, keys) { if (Object.keys(row).sort().join('\0') !== [...keys].sort().join('\0'))
    throw new ArtifactIngressError('ARTIFACT_INVALID'); }
function single(value) { return typeof value === 'string' ? value : undefined; }
function contentLength(value, max) {
    const text = single(value);
    if (text === undefined || !/^(?:0|[1-9][0-9]*)$/u.test(text))
        throw new ArtifactIngressError('ARTIFACT_INVALID');
    const length = Number(text);
    if (!Number.isSafeInteger(length) || length < 1 || length > max)
        throw new ArtifactIngressError(length > max ? 'ARTIFACT_QUOTA_EXCEEDED' : 'ARTIFACT_INVALID');
    return length;
}
async function readSmall(source, expected, signal) {
    const body = new Uint8Array(expected);
    let offset = 0;
    for await (const chunk of source) {
        signal.throwIfAborted();
        if (offset + chunk.byteLength > expected)
            throw new ArtifactIngressError('ARTIFACT_INVALID');
        body.set(chunk, offset);
        offset += chunk.byteLength;
    }
    if (offset !== expected)
        throw new ArtifactIngressError('ARTIFACT_INVALID');
    return body;
}
async function* observed(source, touch, signal) {
    const iterator = source[Symbol.asyncIterator]();
    while (true) {
        const next = await nextOrAbort(iterator, signal);
        if (next.done === true)
            return;
        touch();
        yield next.value;
    }
}
async function nextOrAbort(iterator, signal) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        let settled = false;
        const abort = () => { settled = true; observeIteratorReturn(iterator); reject(signal.reason); };
        signal.addEventListener('abort', abort, { once: true });
        void iterator.next().then(value => { if (!settled) {
            settled = true;
            signal.removeEventListener('abort', abort);
            resolve(value);
        } }, error => { if (!settled) {
            settled = true;
            signal.removeEventListener('abort', abort);
            reject(error);
        } });
    });
}
function observeIteratorReturn(iterator) {
    try {
        const pending = iterator.return?.();
        if (pending !== undefined)
            void Promise.resolve(pending).catch(() => undefined);
    }
    catch { /* The abort reason remains authoritative. */ }
}
function constantBearer(value, expected) {
    if (value === undefined || !value.startsWith('Bearer '))
        return false;
    const supplied = Buffer.from(value.slice(7));
    const wanted = Buffer.from(expected);
    return supplied.byteLength === wanted.byteLength && timingSafeEqual(supplied, wanted);
}
function timeout(value) { if (!Number.isSafeInteger(value) || value < 1 || value > 60 * 60_000)
    throw new Error('INVALID_ARTIFACT_TIMEOUT'); return value; }
function statusFor(code) { return code === 'ARTIFACT_NOT_FOUND' ? 404 : code === 'ARTIFACT_QUOTA_EXCEEDED' ? 413 : code === 'CLEANUP_INCOMPLETE' || code === 'ARTIFACT_TIMEOUT' ? 503 : 409; }
function json(status, value) { const body = Buffer.from(JSON.stringify(value), 'utf8'); return { status, headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.byteLength), 'cache-control': 'no-store' }, body }; }
//# sourceMappingURL=artifact-ingress-http.js.map
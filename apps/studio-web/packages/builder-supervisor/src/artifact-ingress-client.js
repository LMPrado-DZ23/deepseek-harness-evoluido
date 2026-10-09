import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { posix } from 'node:path';
import { ARTIFACT_UPLOAD_MAX_WIRE_BYTES, validateUploadRef } from './artifact-ingress.js';
import { isBuilderCredentialReference } from './protocol.js';
const MAX_RESPONSE_BYTES = 4 * 1024;
export class ArtifactIngressUnixClientError extends Error {
    code;
    status;
    constructor(code, status) {
        super(code);
        this.code = code;
        this.status = status;
        this.name = 'ArtifactIngressUnixClientError';
    }
}
export function classifyArtifactIngressUnixClientFailure(error) {
    if (!(error instanceof ArtifactIngressUnixClientError))
        return { state: 'INTERNAL', code: 'UNKNOWN' };
    if (error.code === 'ABORTED')
        return { state: 'CANCELLED', code: error.code };
    if (error.code === 'ARTIFACT_INVALID')
        return { state: 'BUILD_FAILED', code: error.code };
    if (error.code === 'INVALID_CONFIGURATION' || error.code === 'INVALID_REQUEST' || error.code === 'ARTIFACT_CONFLICT' || error.code === 'ARTIFACT_NOT_READY' || error.code === 'UNSUPPORTED_MEDIA_TYPE') {
        return { state: 'INTERNAL', code: error.code };
    }
    return { state: 'BLOCKED_EXTERNAL', code: error.code };
}
export function createArtifactIngressUnixClient(options) {
    if (!posix.isAbsolute(options.socketPath) || posix.normalize(options.socketPath) !== options.socketPath || options.socketPath.includes('\\') || options.socketPath.includes('\0') || Buffer.byteLength(options.socketPath, 'utf8') > 107 || !isBuilderCredentialReference(options.credentialRef))
        throw new ArtifactIngressUnixClientError('INVALID_CONFIGURATION');
    const timeoutMs = options.timeoutMs ?? 15 * 60_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60 * 60_000)
        throw new ArtifactIngressUnixClientError('INVALID_CONFIGURATION');
    const transport = options.request ?? httpRequest;
    const authorize = async (callerSignal) => {
        const timeout = AbortSignal.timeout(timeoutMs);
        const signal = callerSignal === undefined ? timeout : AbortSignal.any([callerSignal, timeout]);
        let token;
        try {
            signal.throwIfAborted();
            token = await resolveCredential(options.credentials, options.credentialRef, signal);
        }
        catch {
            if (callerSignal?.aborted === true)
                throw new ArtifactIngressUnixClientError('ABORTED');
            if (timeout.aborted)
                throw new ArtifactIngressUnixClientError('DEADLINE_EXCEEDED');
            throw new ArtifactIngressUnixClientError('CREDENTIAL_UNAVAILABLE');
        }
        if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43,200}$/u.test(token))
            throw new ArtifactIngressUnixClientError('CREDENTIAL_UNAVAILABLE');
        return { token, signal, timeout };
    };
    const control = async (body, callerSignal) => {
        const encoded = Buffer.from(JSON.stringify(body), 'utf8');
        const auth = await authorize(callerSignal);
        try {
            return await exchange(transport, { socketPath: options.socketPath, path: '/v1/artifacts/rpc', method: 'POST', token: auth.token, contentLength: encoded.byteLength, contentType: 'application/json; charset=utf-8', source: one(encoded), signal: auth.signal });
        }
        catch (error) {
            throw classify(error, callerSignal, auth.timeout);
        }
    };
    return {
        begin: async (input, signal) => {
            if (!/^req_[a-f0-9]{32}$/u.test(input.requestId) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u.test(input.buildId) || !Number.isSafeInteger(input.contentLength) || input.contentLength < 1 || input.contentLength > ARTIFACT_UPLOAD_MAX_WIRE_BYTES || !/^[a-f0-9]{64}$/u.test(input.wireSha256))
                throw new ArtifactIngressUnixClientError('INVALID_REQUEST');
            const row = await control({ operation: 'artifact.begin', request_id: input.requestId, build_id: input.buildId, content_length: input.contentLength, wire_sha256: input.wireSha256 }, signal);
            return parseResult(row);
        },
        upload: async (input, callerSignal) => {
            try {
                validateUploadRef(input.uploadRef);
            }
            catch {
                throw new ArtifactIngressUnixClientError('INVALID_REQUEST');
            }
            if (!Number.isSafeInteger(input.contentLength) || input.contentLength < 1 || input.contentLength > ARTIFACT_UPLOAD_MAX_WIRE_BYTES)
                throw new ArtifactIngressUnixClientError('INVALID_REQUEST');
            const auth = await authorize(callerSignal);
            try {
                return parseResult(await exchange(transport, { socketPath: options.socketPath, path: `/v1/artifacts/${input.uploadRef}`, method: 'PUT', token: auth.token, contentLength: input.contentLength, contentType: 'application/x-tar', source: input.source, signal: auth.signal }));
            }
            catch (error) {
                throw classify(error, callerSignal, auth.timeout);
            }
        },
        abort: async (input, signal) => {
            if (!/^req_[a-f0-9]{32}$/u.test(input.requestId))
                throw new ArtifactIngressUnixClientError('INVALID_REQUEST');
            try {
                validateUploadRef(input.uploadRef);
            }
            catch {
                throw new ArtifactIngressUnixClientError('INVALID_REQUEST');
            }
            const row = await control({ operation: 'artifact.abort', request_id: input.requestId, upload_ref: input.uploadRef }, signal);
            if (row.ok !== true || row.state !== 'FAILED' || Object.keys(row).sort().join('\0') !== ['ok', 'state'].join('\0'))
                throw new ArtifactIngressUnixClientError('INVALID_RESPONSE');
        },
    };
}
async function resolveCredential(credentials, reference, signal) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const abort = () => { settled = true; reject(signal.reason); };
        signal.addEventListener('abort', abort, { once: true });
        let pending;
        try {
            pending = credentials.resolve(reference, signal);
        }
        catch (error) {
            settled = true;
            signal.removeEventListener('abort', abort);
            reject(error);
            return;
        }
        void pending.then(value => { if (!settled) {
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
async function exchange(request, options) {
    const peer = new AbortController();
    const operationSignal = AbortSignal.any([options.signal, peer.signal]);
    let responseResolve;
    let responseReject;
    const responseResult = new Promise((resolve, reject) => { responseResolve = resolve; responseReject = reject; });
    let client;
    try {
        client = request({ socketPath: options.socketPath, path: options.path, method: options.method, signal: operationSignal, headers: { authorization: `Bearer ${options.token}`, 'content-type': options.contentType, 'content-length': String(options.contentLength), 'cache-control': 'no-store' } }, response => {
            void readResponse(response).then(responseResolve, error => { peer.abort(error); responseReject(error); });
        });
    }
    catch (error) {
        throw error;
    }
    client.once('error', error => { peer.abort(error); responseReject(error); });
    const uploadResult = writeStreaming(client, options.source, options.contentLength, operationSignal).catch(error => {
        peer.abort(error);
        client.destroy(error instanceof Error ? error : new Error('ARTIFACT_UPLOAD_FAILED'));
        throw error;
    });
    const settled = await Promise.allSettled([responseResult, uploadResult]);
    const response = settled[0];
    const upload = settled[1];
    if (upload.status === 'rejected')
        throw upload.reason;
    if (response.status === 'rejected')
        throw response.reason;
    return response.value;
}
async function writeStreaming(request, source, expected, signal) {
    let bytes = 0;
    const iterator = source[Symbol.asyncIterator]();
    while (true) {
        const next = await nextOrAbort(iterator, signal);
        if (next.done === true)
            break;
        const raw = next.value;
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
        bytes += chunk.byteLength;
        if (bytes > expected)
            throw new ArtifactIngressUnixClientError('INVALID_REQUEST');
        if (!request.write(chunk))
            await once(request, 'drain', { signal });
    }
    if (bytes !== expected)
        throw new ArtifactIngressUnixClientError('INVALID_REQUEST');
    request.end();
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
async function readResponse(response) {
    const declared = response.headers['content-length'];
    if (Array.isArray(declared) || typeof declared !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES) {
        response.destroy();
        throw new ArtifactIngressUnixClientError('INVALID_RESPONSE');
    }
    const contentType = response.headers['content-type'];
    if (typeof contentType !== 'string' || !/^application\/json(?:; charset=utf-8)?$/iu.test(contentType)) {
        response.destroy();
        throw new ArtifactIngressUnixClientError('INVALID_RESPONSE');
    }
    const body = new Uint8Array(Number(declared));
    let offset = 0;
    for await (const raw of response) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        if (offset + chunk.byteLength > body.byteLength)
            throw new ArtifactIngressUnixClientError('INVALID_RESPONSE');
        body.set(chunk, offset);
        offset += chunk.byteLength;
    }
    if (offset !== body.byteLength)
        throw new ArtifactIngressUnixClientError('INVALID_RESPONSE');
    let value;
    try {
        value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(body));
    }
    catch {
        throw new ArtifactIngressUnixClientError('INVALID_RESPONSE');
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new ArtifactIngressUnixClientError('INVALID_RESPONSE');
    const row = value;
    if ((response.statusCode ?? 0) === 200)
        return row;
    const error = row.error;
    const code = typeof error === 'string' ? error : typeof error === 'object' && error !== null && typeof error.code === 'string' ? error.code : 'INVALID_RESPONSE';
    if (!REMOTE_ERRORS.has(code))
        throw new ArtifactIngressUnixClientError('INVALID_RESPONSE', response.statusCode);
    throw new ArtifactIngressUnixClientError(code, response.statusCode);
}
const REMOTE_ERRORS = new Set(['ARTIFACT_CONFLICT', 'ARTIFACT_INVALID', 'ARTIFACT_NOT_FOUND', 'ARTIFACT_NOT_READY', 'ARTIFACT_QUOTA_EXCEEDED', 'ARTIFACT_TIMEOUT', 'CLEANUP_INCOMPLETE', 'INTERNAL', 'SUPERVISOR_SHUTTING_DOWN', 'UNAUTHORIZED', 'NOT_FOUND', 'METHOD_NOT_ALLOWED', 'UNSUPPORTED_MEDIA_TYPE']);
function parseResult(row) {
    if (Object.keys(row).sort().join('\0') !== ['idempotent', 'ok', 'state', 'upload_ref'].join('\0') || row.ok !== true || typeof row.upload_ref !== 'string' || !/^upload_[a-f0-9]{32}$/u.test(row.upload_ref) || typeof row.state !== 'string' || !['RECEIVING', 'READY', 'CONSUMING', 'CONSUMED'].includes(row.state) || typeof row.idempotent !== 'boolean')
        throw new ArtifactIngressUnixClientError('INVALID_RESPONSE');
    return { uploadRef: row.upload_ref, state: row.state, idempotent: row.idempotent };
}
function classify(error, callerSignal, timeout) { if (callerSignal?.aborted === true)
    return new ArtifactIngressUnixClientError('ABORTED'); if (timeout.aborted)
    return new ArtifactIngressUnixClientError('DEADLINE_EXCEEDED'); return error instanceof ArtifactIngressUnixClientError ? error : new ArtifactIngressUnixClientError('TRANSPORT_ERROR'); }
async function* one(value) { yield value; }
//# sourceMappingURL=artifact-ingress-client.js.map
import { createHash, timingSafeEqual } from 'node:crypto';
import { BUILD_STEPS, BuilderSupervisorError } from './model.js';
import { RpcReplayGuard } from './replay.js';
import { isBuilderRuntimeScopeId } from './runtime-scope.js';
export const BUILDER_RPC_PATH = '/v1/rpc';
export const BUILDER_RPC_MAX_BODY_BYTES = 64 * 1024;
export const BUILDER_RPC_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const BUILDER_CREDENTIAL_REFERENCE_MAX_BYTES = 4 * 1024;
export function parseBuilderRpcRequest(value) {
    const envelope = strictRecord(value, ['operation', 'body']);
    const operation = envelope.operation;
    if (operation === 'preflight')
        return { operation, body: parseIdentity(envelope.body) };
    if (operation === 'listManaged')
        return { operation, body: parseListManaged(envelope.body) };
    if (operation === 'prepare') {
        const body = strictRecord(envelope.body, ['request_id', 'build_id', 'upload_ref']);
        const request_id = requestId(body.request_id);
        if (!validBuildId(body.build_id))
            invalid();
        if (typeof body.upload_ref !== 'string' || !/^upload_[a-f0-9]{32}$/u.test(body.upload_ref))
            invalid();
        return { operation, body: { request_id, build_id: body.build_id, upload_ref: body.upload_ref } };
    }
    if (operation === 'execute') {
        const body = strictRecord(envelope.body, ['request_id', 'build_ref', 'step']);
        if (typeof body.step !== 'string' || !BUILD_STEPS.includes(body.step))
            invalid();
        return { operation, body: { request_id: requestId(body.request_id), build_ref: buildReference(body.build_ref), step: body.step } };
    }
    if (operation === 'cancel' || operation === 'finish') {
        const body = parseBuildReference(envelope.body);
        return { operation, body };
    }
    return invalid();
}
export function createBuilderRpcHandler(options) {
    if (!isBuilderCredentialReference(options.credentialRef))
        throw new Error('INVALID_CREDENTIAL_REFERENCE');
    const replay = options.replay ?? new RpcReplayGuard();
    return { handle: async (input) => {
            if (input.path !== BUILDER_RPC_PATH)
                return response(404, { error: 'NOT_FOUND' });
            if (input.method !== 'POST')
                return response(405, { error: 'METHOD_NOT_ALLOWED' });
            const expected = await options.credentials.resolve(options.credentialRef);
            if (!constantBearer(input.headers.authorization, expected))
                return response(401, { error: 'UNAUTHORIZED' });
            if (input.body.byteLength > BUILDER_RPC_MAX_BODY_BYTES)
                return response(413, { error: 'REQUEST_TOO_LARGE' });
            let request;
            try {
                request = parseBuilderRpcRequest(JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(input.body)));
            }
            catch {
                return rpcError(400, 'INVALID_REQUEST');
            }
            const fingerprint = createHash('sha256').update(input.body).digest('hex');
            try {
                return await replay.run(request.body.request_id, fingerprint, async () => {
                    try {
                        const result = await dispatch(options.methods, request, input.signal);
                        if (!isValidBuilderRpcResult(request, result))
                            throw new Error('INVALID_METHOD_RESULT');
                        return response(200, { ok: true, result });
                    }
                    catch (error) {
                        if (input.signal.aborted)
                            throw input.signal.reason;
                        if (error instanceof BuilderSupervisorError)
                            return rpcError(409, error.code);
                        throw error;
                    }
                });
            }
            catch (error) {
                if (input.signal.aborted)
                    throw input.signal.reason;
                if (error instanceof BuilderSupervisorError)
                    return rpcError(409, error.code);
                return rpcError(500, 'INTERNAL');
            }
        } };
}
async function dispatch(methods, request, signal) {
    signal.throwIfAborted();
    switch (request.operation) {
        case 'preflight': return methods.preflight(request.body, signal);
        case 'prepare': return methods.prepare(request.body, signal);
        case 'execute': return methods.execute(request.body, signal);
        case 'cancel': return methods.cancel(request.body, signal);
        case 'finish': return methods.finish(request.body, signal);
        case 'listManaged': return methods.listManaged(request.body, signal);
    }
}
export function isValidBuilderRpcResult(request, value) {
    if (request.operation === 'preflight') {
        const row = exact(value, ['state', 'protocol_version', 'scope_id', 'image_id', 'policy_sha256']);
        return row !== undefined && (row.state === 'OK' || row.state === 'BLOCKED_EXTERNAL') && row.protocol_version === 1 &&
            isBuilderRuntimeScopeId(row.scope_id) &&
            typeof row.image_id === 'string' && /^sha256:[a-f0-9]{64}$/u.test(row.image_id) &&
            typeof row.policy_sha256 === 'string' && /^[a-f0-9]{64}$/u.test(row.policy_sha256);
    }
    if (request.operation === 'prepare') {
        const row = exact(value, ['build_ref', 'state']);
        return row?.state === 'PREPARED' && validBuildRef(row.build_ref);
    }
    if (request.operation === 'execute') {
        const row = exact(value, ['build_ref', 'state', 'step', 'result']);
        if (row === undefined || row.build_ref !== request.body.build_ref || row.step !== request.body.step || !validBuildState(row.state) || !validStepResult(row.result))
            return false;
        const result = row.result;
        const expected = { install: 'INSTALL_OK', build: 'BUILD_OK', test: 'TEST_OK', e2e: 'E2E_OK' }[request.body.step];
        return row.state === 'CANCELLED' ? result.exit_code === -1 : row.state === 'FAILED' ? result.exit_code !== 0 : row.state === expected && result.exit_code === 0 && result.termination_reason === null;
    }
    if (request.operation === 'cancel') {
        const row = exact(value, ['build_ref', 'state']);
        return row?.state === 'CANCELLED' && row.build_ref === request.body.build_ref;
    }
    if (request.operation === 'finish') {
        const row = exact(value, ['build_ref', 'final_state', 'exported', 'cleanup_pending', 'cleaned']);
        if (row === undefined || row.build_ref !== request.body.build_ref || (row.final_state !== 'E2E_OK' && row.final_state !== 'FAILED' && row.final_state !== 'CANCELLED'))
            return false;
        if (row.cleanup_pending !== false || row.cleaned !== true || !validExported(row.exported))
            return false;
        return row.final_state === 'E2E_OK'
            ? row.exported !== null && row.exported.relative_path === `exports/${request.body.build_ref}`
            : row.exported === null;
    }
    const row = exact(value, ['builds']);
    const body = request.body;
    return row !== undefined && Array.isArray(row.builds) && row.builds.length <= 1_000 && row.builds.every(item => validManagedBuild(item) && (body.build_id === undefined || item.build_id === body.build_id));
}
export function isBuilderCredentialReference(value) {
    return Buffer.byteLength(value, 'utf8') <= BUILDER_CREDENTIAL_REFERENCE_MAX_BYTES &&
        /^file:\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/u.test(value) && !value.split('/').includes('..');
}
function validStepResult(value) {
    const row = exact(value, ['exit_code', 'stdout', 'stderr', 'timed_out', 'termination_reason', 'output_limit_exceeded']);
    if (row === undefined || !Number.isSafeInteger(row.exit_code) || typeof row.stdout !== 'string' || typeof row.stderr !== 'string' || Buffer.byteLength(row.stdout) + Buffer.byteLength(row.stderr) > 524_288 || typeof row.timed_out !== 'boolean' || typeof row.output_limit_exceeded !== 'boolean')
        return false;
    if (row.termination_reason !== null && row.termination_reason !== 'timeout' && row.termination_reason !== 'output_limit')
        return false;
    return row.timed_out === (row.termination_reason === 'timeout') && row.output_limit_exceeded === (row.termination_reason === 'output_limit') && (row.termination_reason === null || row.exit_code === -1);
}
function validManagedBuild(value) {
    const row = exact(value, ['build_ref', 'build_id', 'state', 'exported', 'cleanup_pending']);
    return row !== undefined && validBuildRef(row.build_ref) && validBuildId(row.build_id) && validBuildState(row.state) && typeof row.exported === 'boolean' && typeof row.cleanup_pending === 'boolean';
}
function validExported(value) {
    if (value === null)
        return true;
    const row = exact(value, ['relative_path', 'sha256', 'files', 'bytes']);
    return row !== undefined && typeof row.relative_path === 'string' && /^exports\/build_[a-f0-9]{32}$/u.test(row.relative_path) &&
        typeof row.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(row.sha256) && Number.isSafeInteger(row.files) && Number(row.files) > 0 && Number.isSafeInteger(row.bytes) && Number(row.bytes) >= 0;
}
function validBuildState(value) {
    return typeof value === 'string' && new Set(['PREPARED', 'INSTALLING', 'INSTALL_OK', 'BUILDING', 'BUILD_OK', 'TEST_RUNNING', 'TEST_OK', 'E2E_RUNNING', 'E2E_OK', 'FAILED', 'CANCELLED']).has(value);
}
function parseIdentity(value) { const row = strictRecord(value, ['request_id']); return { request_id: requestId(row.request_id) }; }
function parseListManaged(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return invalid();
    const keys = Object.keys(value).sort().join('\0');
    if (keys !== 'request_id' && keys !== 'build_id\0request_id')
        return invalid();
    const row = value;
    const request_id = requestId(row.request_id);
    if (row.build_id === undefined)
        return { request_id };
    if (!validBuildId(row.build_id))
        return invalid();
    return { request_id, build_id: row.build_id };
}
function parseBuildReference(value) {
    const row = strictRecord(value, ['request_id', 'build_ref']);
    return { request_id: requestId(row.request_id), build_ref: buildReference(row.build_ref) };
}
function requestId(value) { if (typeof value !== 'string' || !/^req_[a-f0-9]{32}$/u.test(value))
    invalid(); return value; }
function buildReference(value) { if (!validBuildRef(value))
    invalid(); return value; }
function validBuildRef(value) { return typeof value === 'string' && /^build_[a-f0-9]{32}$/u.test(value); }
function validBuildId(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u.test(value); }
function strictRecord(value, keys) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return invalid();
    const row = value;
    if (Object.keys(row).sort().join('\0') !== [...keys].sort().join('\0'))
        return invalid();
    return row;
}
function exact(value, keys) { try {
    return strictRecord(value, keys);
}
catch {
    return undefined;
} }
function constantBearer(value, expected) {
    if (typeof value !== 'string' || typeof expected !== 'string' || !/^[A-Za-z0-9_-]{43,200}$/u.test(expected) || !value.startsWith('Bearer '))
        return false;
    const supplied = Buffer.from(value.slice(7), 'utf8');
    const wanted = Buffer.from(expected, 'utf8');
    return supplied.byteLength === wanted.byteLength && timingSafeEqual(supplied, wanted);
}
function rpcError(status, code) { return response(status, { ok: false, error: { code } }); }
function response(status, value) {
    return { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: Buffer.from(JSON.stringify(value), 'utf8') };
}
function invalid() { throw new Error('INVALID_REQUEST'); }
//# sourceMappingURL=protocol.js.map
import { createHash, randomUUID } from 'node:crypto';
export { GitWorktreeManager, assertInsideWorktree } from './git.js';
export class DelegationError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
const DEFAULT_TIMEOUT_MS = 20 * 60_000;
const MAX_TIMEOUT_MS = 60 * 60_000;
const DEFAULT_MAX_FILES = 50;
const DEFAULT_MAX_DIFF_BYTES = 2 * 1024 * 1024;
function requiredTier(request) {
    return request.touchesDeploy || request.touchesSecrets || request.usesExternalNetwork ? 'T3' : 'T2';
}
function normalizeLeasePath(value) {
    const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
    if (normalized === '' || normalized === '.' || normalized === '*')
        return '*';
    if (normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
        throw new DelegationError('INVALID_PATH', `Caminho de delegação inválido: ${value}`);
    }
    return normalized;
}
function pathsOverlap(left, right) {
    return left.some(a => right.some(b => a === '*' || b === '*' || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)));
}
function terminalText(result) {
    return result.output.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim();
}
export class StudioAgentService {
    dependencies;
    #activePaths = new Map();
    #applyingWorkspaces = new Set();
    constructor(dependencies) {
        this.dependencies = dependencies;
    }
    start(request) {
        const tier = requiredTier(request);
        if (!request.approval.approved || request.approval.tier !== tier) {
            throw new DelegationError('APPROVAL_REQUIRED', tier === 'T3'
                ? 'Esta tarefa sensível precisa de confirmação reforçada antes de começar.'
                : 'Confirme antes de o assistente trabalhar numa cópia do projeto.');
        }
        const paths = request.intendedPaths.map(normalizeLeasePath);
        if (paths.length === 0)
            throw new DelegationError('INVALID_PATH', 'Declare ao menos um caminho que o assistente pretende alterar.');
        for (const active of this.#activePaths.values()) {
            if (pathsOverlap(active, paths)) {
                throw new DelegationError('WRITE_CONFLICT', 'Outro assistente já está trabalhando nos mesmos arquivos.');
            }
        }
        const runId = this.dependencies.createId?.() ?? randomUUID();
        this.#activePaths.set(runId, paths);
        const controller = new AbortController();
        const done = this.#execute(runId, request, paths, controller.signal)
            .finally(() => { this.#activePaths.delete(runId); });
        try {
            const jobId = this.dependencies.jobs.start({
                kind: 'studio-agent',
                label: `Assistente ${request.provider}: ${request.prompt.slice(0, 80)}`,
                owner: request.parent,
                run: () => ({
                    cancel: reason => controller.abort(reason ?? 'cancelled-by-user'),
                    done,
                }),
            });
            return { runId, jobId, requiredTier: tier };
        }
        catch (error) {
            controller.abort('job-registration-failed');
            this.#activePaths.delete(runId);
            throw error;
        }
    }
    async applyProposal(runId, approval) {
        if (!approval.approved || approval.tier !== 'T2') {
            throw new DelegationError('APPROVAL_REQUIRED', 'Confirme antes de aplicar a proposta ao seu projeto.');
        }
        const record = this.dependencies.repository.runs().find(candidate => candidate.run_id === runId);
        if (record === undefined || record.status !== 'PROPOSED') {
            throw new DelegationError('INVALID_STATE', 'Esta proposta não está disponível para aplicação.');
        }
        const workspaceKey = `${record.org_id}:${record.tenant_id}:${record.workspace_id}`;
        if (this.#applyingWorkspaces.has(workspaceKey)) {
            throw new DelegationError('WRITE_CONFLICT', 'Outra proposta está sendo aplicada neste espaço de trabalho.');
        }
        this.#applyingWorkspaces.add(workspaceKey);
        try {
            await this.dependencies.worktrees.applyProposal(record);
            const updatedAt = (this.dependencies.now?.() ?? new Date()).toISOString();
            await this.dependencies.repository.putRun({ ...record, status: 'APPLIED', diagnostic: null, updated_at: updatedAt });
            return { runId, status: 'APPLIED', changedFiles: record.changed_files };
        }
        finally {
            this.#applyingWorkspaces.delete(workspaceKey);
        }
    }
    async #execute(runId, request, paths, signal) {
        const now = this.dependencies.now ?? (() => new Date());
        const timeoutMs = Math.min(request.budget?.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
        const maxFiles = request.budget?.maxFiles ?? DEFAULT_MAX_FILES;
        const maxDiffBytes = request.budget?.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES;
        const parentSessionId = request.parent.session.id;
        let snapshot;
        let coordinator;
        let child;
        let timeout;
        const timed = new AbortController();
        const forwardAbort = () => timed.abort(signal.reason);
        signal.addEventListener('abort', forwardAbort, { once: true });
        timeout = setTimeout(() => timed.abort('timeout'), timeoutMs);
        const createdAt = now().toISOString();
        try {
            snapshot = await this.dependencies.worktrees.create(request.repositoryPath, runId);
            coordinator = await this.dependencies.coordinators.create(snapshot.worktreePath, parentSessionId, request.provider, requiredTier(request));
            const lease = {
                lease_id: `lease-${runId}`, run_id: runId,
                org_id: request.orgId, tenant_id: request.tenantId, workspace_id: request.workspaceId,
                repository_path: snapshot.repositoryPath, paths: [...paths], active: true,
                created_at: createdAt, released_at: null,
            };
            await this.dependencies.repository.putLease(lease);
            await this.dependencies.repository.putRun({
                run_id: runId, org_id: request.orgId, tenant_id: request.tenantId,
                workspace_id: request.workspaceId, parent_session_id: String(parentSessionId),
                coordinator_session_id: String(coordinator.sessionId), provider: request.provider,
                worktree_path: snapshot.worktreePath, repository_path: snapshot.repositoryPath, base_commit: snapshot.baseCommit,
                status: 'RUNNING', changed_files: [], diff_bytes: 0, diff_sha256: createHash('sha256').update('').digest('hex'), diagnostic: null,
                created_at: createdAt, updated_at: createdAt,
            });
            child = await this.dependencies.subagents.start(request.provider, {
                parent: coordinator.agent,
                prompt: [{ type: 'text', text: request.prompt }],
                signal: timed.signal,
                ...(request.provider === 'spawn-in-process' && request.inProcess !== undefined
                    ? { inProcess: request.inProcess }
                    : {}),
            });
            const result = await child.result;
            if (timed.signal.aborted) {
                const timedOut = timed.signal.reason === 'timeout';
                return await this.#finish(runId, request, snapshot, coordinator, lease, timedOut ? 'BUDGET_EXCEEDED' : 'CANCELLED', String(timed.signal.reason), now);
            }
            if (result.stopReason !== 'completed') {
                return await this.#finish(runId, request, snapshot, coordinator, lease, 'FAILED', result.diagnostic ?? result.stopReason, now);
            }
            const diff = await this.dependencies.worktrees.diff(snapshot);
            const mainAfter = await this.dependencies.worktrees.mainFingerprint(snapshot.repositoryPath);
            const outsideChanged = mainAfter !== snapshot.mainFingerprint;
            const pathViolation = diff.files.some(file => !pathsOverlap(paths, [file]));
            const measuredTokens = this.dependencies.usage?.tokensFor(child);
            const tokenExceeded = request.budget?.maxTokens !== undefined
                && measuredTokens !== undefined && measuredTokens > request.budget.maxTokens;
            if (outsideChanged || pathViolation || diff.files.length > maxFiles || diff.bytes > maxDiffBytes || tokenExceeded) {
                const reason = outsideChanged ? 'alteração detectada fora do worktree'
                    : pathViolation ? 'arquivo fora dos caminhos aprovados'
                        : tokenExceeded ? 'limite de tokens excedido'
                            : diff.files.length > maxFiles ? 'limite de arquivos excedido' : 'limite de bytes do diff excedido';
                return await this.#finish(runId, request, snapshot, coordinator, lease, 'BUDGET_EXCEEDED', reason, now, diff);
            }
            return await this.#finish(runId, request, snapshot, coordinator, lease, 'PROPOSED', terminalText(result), now, diff);
        }
        catch (error) {
            if (snapshot === undefined || coordinator === undefined) {
                return { status: signal.aborted || timed.signal.aborted ? 'killed' : 'failed', detail: String(error) };
            }
            const lease = this.dependencies.repository.leases().find(item => item.run_id === runId);
            if (lease === undefined)
                return { status: 'failed', detail: String(error) };
            const timedOut = timed.signal.reason === 'timeout';
            return this.#finish(runId, request, snapshot, coordinator, lease, timedOut ? 'BUDGET_EXCEEDED' : signal.aborted || timed.signal.aborted ? 'CANCELLED' : 'FAILED', String(error), now);
        }
        finally {
            clearTimeout(timeout);
            signal.removeEventListener('abort', forwardAbort);
            await child?.dispose().catch(() => undefined);
            await coordinator?.dispose().catch(() => undefined);
        }
    }
    async #finish(runId, request, snapshot, coordinator, lease, status, diagnostic, now, diff = { text: '', bytes: 0, files: [] }) {
        const updatedAt = now().toISOString();
        await this.dependencies.repository.putRun({
            run_id: runId, org_id: request.orgId, tenant_id: request.tenantId,
            workspace_id: request.workspaceId, parent_session_id: String(request.parent.session.id),
            coordinator_session_id: String(coordinator.sessionId), provider: request.provider,
            worktree_path: snapshot.worktreePath, repository_path: snapshot.repositoryPath, base_commit: snapshot.baseCommit,
            status, changed_files: [...diff.files], diff_bytes: diff.bytes,
            diff_sha256: createHash('sha256').update(diff.text).digest('hex'), diagnostic,
            created_at: this.dependencies.repository.runs().find(record => record.run_id === runId)?.created_at ?? updatedAt,
            updated_at: updatedAt,
        });
        await this.dependencies.repository.putLease({ ...lease, active: false, released_at: updatedAt });
        if (status === 'PROPOSED')
            return { status: 'completed', output: diff.text };
        if (status === 'CANCELLED')
            return { status: 'killed', detail: diagnostic };
        return { status: 'failed', detail: diagnostic };
    }
}

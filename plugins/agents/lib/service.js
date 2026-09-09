import { createHash, randomUUID } from 'node:crypto';
import { t } from './i18n.js';
export { GitWorktreeManager } from './git.js';
/**
 * Prazo para o encerramento ativo. O que continuar vivo depois disso nao e
 * declarado morto: fica para a reconciliacao do proximo inicio.
 */
export const SHUTDOWN_DEADLINE_MS = 15_000;
/**
 * `spawn-in-process` morre junto com o Studio, entao um reinicio ja e prova de
 * que terminou. `codex` e `claude-code` sao processos do sistema operacional
 * com vida propria: o pin do Harness nao entrega identidade de processo pelo
 * seam publico, entao o Studio NAO consegue provar que eles morreram - e nao
 * vai fingir que consegue.
 */
export function survivesRestart(provider) {
    return provider !== 'spawn-in-process';
}
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
export function normalizeDelegationPath(value, allowWildcard = true, invalid = path => new DelegationError('INVALID_PATH', t('delegation.invalidPath', { path }))) {
    if (value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
        throw invalid(value);
    }
    const normalized = value.replaceAll('\\', '/');
    if (allowWildcard && normalized === '*')
        return '*';
    if (normalized === '' || normalized === '*' || normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized)) {
        throw invalid(value);
    }
    const segments = normalized.split('/');
    if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
        throw invalid(value);
    }
    return normalized;
}
function pathsOverlap(left, right) {
    return left.some(a => right.some(b => a === '*' || b === '*' || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)));
}
/** A cerca que uma reserva carrega. Reserva antiga, sem o campo, vale como 0 — a mais fraca. */
export function leaseFence(lease) {
    return lease.fence ?? 0;
}
/**
 * O próximo número de cerca para um repositório dentro de um espaço de trabalho.
 *
 * Derivado do MAIOR já visto ali, e não de um contador em memória: um contador
 * em memória voltaria a zero no reinício, e a primeira reserva depois de um
 * reinício receberia um número menor do que o da reserva que ela precisa
 * superar — exatamente o zumbi que a cerca existe para barrar, com os papéis
 * trocados. Reservas liberadas continuam contando: elas são liberadas, nunca
 * apagadas.
 * @param leases - todas as reservas conhecidas.
 * @param scope - o espaço de trabalho e o repositório.
 * @returns o número a gravar na reserva nova.
 */
export function nextFence(leases, scope) {
    let highest = 0;
    for (const lease of leases) {
        if (lease.workspace_id !== scope.workspaceId || lease.repository_path !== scope.repositoryPath)
            continue;
        if (leaseFence(lease) > highest)
            highest = leaseFence(lease);
    }
    return highest + 1;
}
/**
 * A cerca que TORNOU VELHA a desta execução, quando existe.
 *
 * Só conta reserva de OUTRA execução, no mesmo repositório do mesmo espaço de
 * trabalho, que toque algum dos mesmos caminhos e que tenha número MAIOR.
 * Empate não supera: duas reservas com o mesmo número seriam um defeito de
 * `nextFence`, e tratar empate como superação faria uma execução barrar a si
 * mesma numa releitura.
 * @param leases - todas as reservas conhecidas.
 * @param runId - a execução que quer escrever.
 * @returns o número que a superou, ou `undefined` quando ela ainda é a mais nova.
 */
export function supersedingFence(leases, runId) {
    const own = leases.find(lease => lease.run_id === runId);
    // Reserva AUSENTE não é caminho livre. Este é o mesmo raciocínio que faz
    // `leaseFence` tratar cerca ausente como 0: "não sei" tem de decidir para o
    // lado seguro. Uma reserva que sumiu — poda, migração de domínio, journal
    // truncado, `putLease` que não durou — deixaria de haver com que comparar, e
    // devolver `undefined` aqui significaria "não fui superado, pode escrever".
    // Devolvemos a MAIOR cerca que existe no repositório: quem não tem reserva
    // não escreve por cima de quem tem.
    if (own === undefined) {
        let highest;
        for (const lease of leases) {
            if (highest === undefined || leaseFence(lease) > highest)
                highest = leaseFence(lease);
        }
        return highest ?? 0;
    }
    let superseding;
    for (const lease of leases) {
        // A própria reserva não precisa ser pulada: `leaseFence(own) <= leaseFence(own)`
        // já a descarta logo abaixo. Um `continue` a mais aqui seria código que
        // nenhuma mutação consegue matar — ou seja, código que não decide nada.
        if (lease.workspace_id !== own.workspace_id || lease.repository_path !== own.repository_path)
            continue;
        if (!pathsOverlap(lease.paths, own.paths))
            continue;
        if (leaseFence(lease) <= leaseFence(own))
            continue;
        if (superseding === undefined || leaseFence(lease) > superseding)
            superseding = leaseFence(lease);
    }
    return superseding;
}
function terminalText(result) {
    return result.output.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim();
}
export class StudioAgentService {
    dependencies;
    #activePaths = new Map();
    #inFlight = new Map();
    #applyingWorkspaces = new Set();
    #ready;
    #reconciliation;
    constructor(dependencies) {
        this.dependencies = dependencies;
        this.#ready = !this.#hasPersistedWork() && !dependencies.jobs.hasLiveJobs();
    }
    reconcileInterruptedRuns() {
        if (this.#reconciliation !== undefined)
            return this.#reconciliation;
        const reconciliation = this.#performRestartReconciliation();
        this.#reconciliation = reconciliation;
        void reconciliation.finally(() => {
            this.#reconciliation = undefined;
        }).catch(() => undefined);
        return reconciliation;
    }
    start(request) {
        // Antes da recuperação, antes da aprovação, antes da reserva de caminhos:
        // um escopo parado não delega nada, e descobrir isso só depois de reservar
        // arquivos deixaria a reserva presa a um trabalho que nunca começou.
        this.dependencies.emergencyStop?.assertRunning({ orgId: request.orgId, tenantId: request.tenantId });
        if (!this.#ready) {
            throw new DelegationError('INVALID_STATE', t('recovery.required'));
        }
        const tier = requiredTier(request);
        if (!request.approval.approved || request.approval.tier !== tier) {
            throw new DelegationError('APPROVAL_REQUIRED', tier === 'T3'
                ? t('delegation.sensitiveNeedsStrongConfirmation')
                : t('delegation.confirmBeforeIsolatedCopy'));
        }
        if (tier === 'T3' && !this.dependencies.identity.strongIdentityVerified(request.parent.session.id)) {
            throw new DelegationError('APPROVAL_REQUIRED', t('delegation.confirmWithPasskey'));
        }
        const paths = request.intendedPaths.map(path => normalizeDelegationPath(path));
        if (paths.length === 0)
            throw new DelegationError('INVALID_PATH', t('delegation.pathsRequired'));
        // O conflito é do espaço de trabalho e do repositório. Sem esse recorte,
        // duas organizações diferentes que por acaso editam `src` bloqueariam uma
        // à outra - e cada uma saberia que a outra está trabalhando ali.
        for (const active of this.#activePaths.values()) {
            if (active.workspaceId !== request.workspaceId || active.repositoryPath !== request.repositoryPath)
                continue;
            if (pathsOverlap(active.paths, paths)) {
                throw new DelegationError('WRITE_CONFLICT', t('delegation.filesAlreadyLeased'));
            }
        }
        // A reserva durável também vale. Sem esta checagem, uma reserva preservada
        // por uma execução em estado desconhecido não protegeria nada: bastaria
        // reiniciar o Studio para que a memória esquecesse o conflito.
        for (const lease of this.dependencies.repository.leases()) {
            if (!lease.active)
                continue;
            if (lease.workspace_id !== request.workspaceId || lease.repository_path !== request.repositoryPath)
                continue;
            if (pathsOverlap(lease.paths, paths)) {
                throw new DelegationError('WRITE_CONFLICT', t('recovery.blockedByUnknown'));
            }
        }
        const runId = this.dependencies.createId?.() ?? randomUUID();
        this.#activePaths.set(runId, { workspaceId: request.workspaceId, repositoryPath: request.repositoryPath, paths });
        const controller = new AbortController();
        const done = this.#execute(runId, request, paths, controller.signal)
            .finally(() => { this.#activePaths.delete(runId); this.#inFlight.delete(runId); });
        this.#inFlight.set(runId, {
            cancel: reason => { controller.abort(reason); }, done,
            orgId: request.orgId, tenantId: request.tenantId, provider: request.provider,
        });
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
    /** Recompute and verify a proposal without applying it or persisting its body. */
    async reviewProposal(runId) {
        const record = this.dependencies.repository.runs().find(candidate => candidate.run_id === runId);
        if (record === undefined || record.status !== 'PROPOSED') {
            throw new DelegationError('INVALID_STATE', t('delegation.onlyPendingReviewable'));
        }
        const snapshot = {
            repositoryPath: record.repository_path,
            worktreePath: record.worktree_path,
            baseCommit: record.base_commit,
            mainFingerprint: '',
        };
        const current = await this.dependencies.worktrees.diff(snapshot);
        const currentHash = createHash('sha256').update(current.text).digest('hex');
        if (currentHash !== record.diff_sha256
            || current.bytes !== record.diff_bytes
            || JSON.stringify([...current.files].sort()) !== JSON.stringify([...record.changed_files].sort())) {
            throw new DelegationError('PROPOSAL_TAMPERED', 'PROPOSAL_TAMPERED');
        }
        return current;
    }
    async applyProposal(runId, approval) {
        if (!approval.approved || approval.tier !== 'T2') {
            throw new DelegationError('APPROVAL_REQUIRED', t('delegation.confirmBeforeApply'));
        }
        const record = this.dependencies.repository.runs().find(candidate => candidate.run_id === runId);
        if (record === undefined || record.status !== 'PROPOSED') {
            throw new DelegationError('INVALID_STATE', t('delegation.proposalNotApplicable'));
        }
        const workspaceKey = `${record.org_id}:${record.tenant_id}:${record.workspace_id}`;
        if (this.#applyingWorkspaces.has(workspaceKey)) {
            throw new DelegationError('WRITE_CONFLICT', t('delegation.anotherProposalApplying'));
        }
        this.#applyingWorkspaces.add(workspaceKey);
        // A CERCA (A-03). Uma proposta pronta de antes do reinício pode chegar aqui
        // depois de outra execução já ter mexido nos mesmos arquivos: a reserva
        // antiga foi liberada na reconciliação, a nova pegou os caminhos, e aplicar
        // a antiga escreveria conteúdo velho por cima do novo sem conflito nenhum
        // aparecer. Quem escreve apresenta o seu número; o recurso recusa o menor.
        const superseded = supersedingFence(this.dependencies.repository.leases(), runId);
        if (superseded !== undefined) {
            this.#applyingWorkspaces.delete(workspaceKey);
            throw new DelegationError('WRITE_CONFLICT', t('delegation.proposalSuperseded'));
        }
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
    async #performRestartReconciliation() {
        this.#ready = false;
        if (this.dependencies.jobs.hasLiveJobs()) {
            throw new DelegationError('INVALID_STATE', t('recovery.liveJobs'));
        }
        const interrupted = this.dependencies.repository.runs()
            .filter(run => run.status === 'RUNNING')
            .sort((left, right) => left.run_id.localeCompare(right.run_id));
        if (this.dependencies.jobs.hasLiveJobs()) {
            throw new DelegationError('INVALID_STATE', t('recovery.liveJobs'));
        }
        const reconciledAt = (this.dependencies.now?.() ?? new Date()).toISOString();
        const unresolved = new Set();
        for (const run of interrupted) {
            const provable = !survivesRestart(run.provider);
            if (!provable)
                unresolved.add(run.run_id);
            await this.dependencies.repository.putRun({
                ...run,
                status: provable ? 'FAILED' : 'UNKNOWN',
                diagnostic: provable ? t('recovery.interrupted') : t('recovery.unknownExternal'),
                // A marca é ESTRUTURAL, e só é posta no caminho provável: `UNKNOWN`
                // pode estar rodando por fora, e marcá-lo como interrompido abriria a
                // retomada justamente para o caso que não pode ser retomado.
                ...(provable ? { interrupted_by_restart: true } : {}),
                updated_at: reconciledAt,
            });
        }
        // A reserva de arquivos so e liberada quando ha prova de encerramento. Sem
        // prova ela FICA: liberar aqui seria abrir caminho para dois processos
        // escrevendo no mesmo lugar, com o registro dizendo que o primeiro falhou.
        let released = 0;
        let kept = 0;
        for (const lease of this.dependencies.repository.leases()
            .filter(item => item.active)
            .sort((left, right) => left.lease_id.localeCompare(right.lease_id))) {
            if (unresolved.has(lease.run_id)) {
                kept += 1;
                continue;
            }
            released += 1;
            await this.dependencies.repository.putLease({ ...lease, active: false, released_at: reconciledAt });
        }
        if (this.#hasPersistedWork() || this.dependencies.jobs.hasLiveJobs()) {
            throw new DelegationError('INVALID_STATE', t('recovery.incomplete'));
        }
        this.#ready = true;
        return {
            interruptedRuns: interrupted.length - unresolved.size,
            releasedLeases: released,
            unresolvedRuns: unresolved.size,
            keptLeases: kept,
            reconciledAt,
        };
    }
    /**
     * Se este trabalho pode ser RETOMADO (A-03).
     *
     * Duas condições, e as duas são recusas de segurança, não de conveniência:
     *
     * - o Studio tem que ter PROVADO que ele parou. `UNKNOWN` significa
     *   "pode estar rodando por fora agora"; retomar ali seria colocar dois
     *   trabalhadores escrevendo na mesma cópia, e o segundo nem saberia do
     *   primeiro. `survivesRestart` é a mesma regra que a reconciliação usa;
     * - ele tem que ter sido interrompido por um reinício, e não ter falhado
     *   sozinho, estourado o orçamento ou sido cancelado por alguém. Retomar um
     *   trabalho que a pessoa CANCELOU seria desfazer o cancelamento dela.
     * @param run - o registro.
     * @returns se `resumeRun` aceitaria este trabalho.
     */
    static resumable(run) {
        if (run.status !== 'FAILED')
            return false;
        if (survivesRestart(run.provider))
            return false;
        // Ausente vale como `false`: um registro de antes desta marca não tem como
        // provar que parou por reinício, e "não sei" tem que valer como "não retoma".
        return run.interrupted_by_restart === true;
    }
    /**
     * Retoma um trabalho interrompido por um reinício, NA CÓPIA QUE SOBROU.
     *
     * O que é retomado é o trabalho, não o processo: o processo antigo morreu com
     * o Studio (é a condição para chegar aqui). O que sobrevive e é aproveitado é
     * a cópia isolada com o que já tinha sido escrito — e é por isso que a
     * retomada usa `worktrees.resume`, que confere e devolve, em vez de `create`,
     * que faria `reset --hard` e apagaria justamente aquilo.
     *
     * A retomada é um ato da PESSOA e pede a mesma confirmação da delegação
     * original: ela vai fazer um assistente escrever de novo nos arquivos dela.
     *
     * A reserva nova recebe uma CERCA nova, maior. Se enquanto isso outro
     * trabalho pegou os mesmos arquivos, quem perde é o mais velho — inclusive
     * este, se ele for o mais velho na hora de aplicar.
     * @param runId - o trabalho interrompido.
     * @param request - o pedido, com a confirmação da pessoa.
     * @returns o identificador do trabalho novo e o do trabalho retomado.
     */
    resume(runId, request) {
        const record = this.dependencies.repository.runs().find(candidate => candidate.run_id === runId);
        if (record === undefined)
            throw new DelegationError('INVALID_STATE', t('recovery.resumeNotInterrupted'));
        if (record.status === 'UNKNOWN' || survivesRestart(record.provider)) {
            throw new DelegationError('INVALID_STATE', t('recovery.resumeNotResumable'));
        }
        if (!StudioAgentService.resumable(record))
            throw new DelegationError('INVALID_STATE', t('recovery.resumeNotInterrupted'));
        // O escopo vem do REGISTRO, não do pedido: aceitar o escopo de quem chama
        // deixaria retomar para dentro de outro espaço de trabalho o trabalho de um
        // repositório que não é dele.
        const accepted = this.start({
            ...request,
            orgId: record.org_id, tenantId: record.tenant_id, workspaceId: record.workspace_id,
            repositoryPath: record.repository_path,
            resumeFrom: record,
        });
        return { ...accepted, resumedFrom: runId };
    }
    /**
     * Uma pessoa confirma que o programa externo terminou. E a unica saida do
     * estado UNKNOWN, e exige motivo: o registro precisa dizer quem decidiu e
     * por que, porque nenhuma prova tecnica sustentou essa conclusao.
     */
    async resolveUnknownRun(runId, reason) {
        const trimmed = reason.trim();
        if (trimmed === '')
            throw new DelegationError('INVALID_STATE', t('recovery.resolveReason'));
        const run = this.dependencies.repository.runs().find(candidate => candidate.run_id === runId);
        if (run === undefined || run.status !== 'UNKNOWN') {
            throw new DelegationError('INVALID_STATE', t('recovery.resolveNotUnknown'));
        }
        const now = (this.dependencies.now?.() ?? new Date()).toISOString();
        await this.dependencies.repository.putRun({
            ...run, status: 'FAILED', diagnostic: `${t('recovery.resolved')}${trimmed}`, updated_at: now,
        });
        for (const lease of this.dependencies.repository.leases().filter(item => item.active && item.run_id === runId)) {
            await this.dependencies.repository.putLease({ ...lease, active: false, released_at: now });
        }
    }
    /**
     * Cancela toda delegação em voo de UM escopo, para uma parada de emergência.
     *
     * O que o Studio consegue provar morto entra em `cancelled`; o que ele não
     * consegue entra em `unproven` com o provedor pelo nome. A regra é a mesma de
     * `survivesRestart`: `spawn-in-process` morre junto com o processo do Studio,
     * enquanto `codex` e `claude-code` são processos do sistema operacional com
     * vida própria - o pedido de parada sai, e o Studio NÃO tem como provar que
     * eles pararam. Contá-los como cancelados seria a mentira que a tela de
     * emergência não pode contar.
     * @param scope - a organização e o inquilino parados.
     * @returns o que parou e o que não pôde ser provado morto.
     */
    cancelScope(scope) {
        let cancelled = 0;
        const unproven = [];
        for (const [runId, entry] of [...this.#inFlight.entries()]) {
            if (entry.orgId !== scope.orgId || entry.tenantId !== scope.tenantId)
                continue;
            entry.cancel('emergency-stop');
            if (survivesRestart(entry.provider))
                unproven.push({ runId, provider: entry.provider });
            else
                cancelled += 1;
        }
        return { cancelled, unproven };
    }
    /**
     * Encerramento ativo com prazo. Pede cancelamento a tudo que esta em voo e
     * espera ate `SHUTDOWN_DEADLINE_MS`. O que sobreviver ao prazo NAO e
     * declarado morto - fica para a reconciliacao do proximo inicio.
     */
    async shutdown(deadlineMs = SHUTDOWN_DEADLINE_MS) {
        const inFlight = [...this.#inFlight.entries()];
        for (const [, entry] of inFlight)
            entry.cancel('shutdown');
        let stopped = 0;
        await Promise.all(inFlight.map(async ([runId, entry]) => {
            const finished = await Promise.race([
                /* v8 ignore start -- o braço de rejeição não é alcançável hoje (#execute sempre resolve); existe para que uma rejeição futura não vire unhandled rejection nem prenda o encerramento até o prazo. */
                entry.done.then(() => true, () => true),
                /* v8 ignore stop */
                new Promise(resolve => { setTimeout(() => { resolve(false); }, deadlineMs).unref?.(); }),
            ]);
            if (finished) {
                stopped += 1;
                this.#inFlight.delete(runId);
            }
        }));
        return { stopped, pending: inFlight.length - stopped };
    }
    #hasPersistedWork() {
        if (this.dependencies.repository.runs().some(run => run.status === 'RUNNING'))
            return true;
        const active = this.dependencies.repository.leases().filter(lease => lease.active);
        if (active.length === 0)
            return false;
        // O conjunto é construído UMA vez. Dentro do predicado, ele seria
        // reconstruído sobre todas as execuções a cada reserva ativa.
        const unknown = this.#unknownRunIds();
        return active.some(lease => !unknown.has(lease.run_id));
    }
    #unknownRunIds() {
        return new Set(this.dependencies.repository.runs()
            .filter(run => run.status === 'UNKNOWN')
            .map(run => run.run_id));
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
            snapshot = request.resumeFrom === undefined
                ? await this.dependencies.worktrees.create(request.repositoryPath, runId)
                : await this.dependencies.worktrees.resume(request.resumeFrom);
            coordinator = await this.dependencies.coordinators.create(snapshot.worktreePath, parentSessionId, request.provider, requiredTier(request));
            const lease = {
                lease_id: `lease-${runId}`, run_id: runId,
                org_id: request.orgId, tenant_id: request.tenantId, workspace_id: request.workspaceId,
                repository_path: snapshot.repositoryPath, paths: [...paths], active: true,
                // A cerca é calculada com o caminho REAL do repositório resolvido pelo
                // worktree, e não com o que veio no pedido: dois pedidos escrevendo o
                // mesmo repositório por caminhos diferentes receberiam cercas de séries
                // separadas, e nenhuma superaria a outra.
                fence: nextFence(this.dependencies.repository.leases(), { workspaceId: request.workspaceId, repositoryPath: snapshot.repositoryPath }),
                created_at: createdAt, released_at: null,
            };
            await this.dependencies.repository.putLease(lease);
            await this.dependencies.repository.putRun({
                run_id: runId, org_id: request.orgId, tenant_id: request.tenantId,
                workspace_id: request.workspaceId, parent_session_id: String(parentSessionId),
                coordinator_session_id: String(coordinator.sessionId), provider: request.provider,
                worktree_path: snapshot.worktreePath, repository_path: snapshot.repositoryPath, base_commit: snapshot.baseCommit,
                status: 'RUNNING', changed_files: [], diff_bytes: 0, diff_sha256: createHash('sha256').update('').digest('hex'), diagnostic: null,
                main_changed_during_run: false, approved_by: request.approval.approvedBy, approved_at: createdAt,
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
            if (pathViolation || diff.files.length > maxFiles || diff.bytes > maxDiffBytes || tokenExceeded) {
                const reason = pathViolation ? t('delegation.pathOutsideApproved')
                    : tokenExceeded ? 'limite de tokens excedido'
                        : diff.files.length > maxFiles ? 'limite de arquivos excedido' : t('git.diffByteLimit');
                return await this.#finish(runId, request, snapshot, coordinator, lease, 'BUDGET_EXCEEDED', reason, now, diff, outsideChanged, measuredTokens);
            }
            const diagnostic = outsideChanged
                ? t('delegation.projectChangedDuringRun')
                : terminalText(result);
            return await this.#finish(runId, request, snapshot, coordinator, lease, 'PROPOSED', diagnostic, now, diff, outsideChanged, measuredTokens);
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
    async #finish(runId, request, snapshot, coordinator, lease, status, diagnostic, now, diff = { text: '', bytes: 0, files: [] }, mainChangedDuringRun = false, tokensUsed = undefined) {
        const updatedAt = now().toISOString();
        await this.dependencies.repository.putRun({
            run_id: runId, org_id: request.orgId, tenant_id: request.tenantId,
            workspace_id: request.workspaceId, parent_session_id: String(request.parent.session.id),
            coordinator_session_id: String(coordinator.sessionId), provider: request.provider,
            worktree_path: snapshot.worktreePath, repository_path: snapshot.repositoryPath, base_commit: snapshot.baseCommit,
            status, changed_files: [...diff.files], diff_bytes: diff.bytes,
            diff_sha256: createHash('sha256').update(diff.text).digest('hex'), diagnostic,
            main_changed_during_run: mainChangedDuringRun,
            // `null` quando não houve medição. O campo existe SEMPRE para que a
            // ausência de medida seja visível, em vez de virar um campo que sumiu.
            tokens_used: tokensUsed ?? null,
            approved_by: request.approval.approvedBy,
            approved_at: this.dependencies.repository.runs().find(record => record.run_id === runId)?.approved_at ?? updatedAt,
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

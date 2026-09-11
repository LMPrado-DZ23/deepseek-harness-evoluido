import { SessionId } from '@deepseek-ai/dsh-session';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { delimiter, extname, join, resolve } from 'node:path';
import { accessSync, constants, existsSync } from 'node:fs';
import { t } from './i18n.js';
import { studioAgentLeasesDomainSpec, studioAgentRunsDomainSpec, } from './model.js';
import { GitWorktreeManager, StudioAgentService, nextFence, } from './service.js';
// A chave `tokenUsage` da projeção de sessão é DECLARADA pelo medidor de tokens
// do Harness (augmentação de `SessionProjectionMap`). Sem importar o pacote, o
// tipo não existe para quem compila este plugin e `snapshot(session, ['tokenUsage'])`
// não passa no typecheck — o consumo aparecia como se ninguém o publicasse.
import '@deepseek-ai/dsh-token-meter';
export * from './model.js';
export * from './service.js';
export const name = 'dz23-studio-agents';
export const inject = ['agentPresets', 'agents', 'jobs', 'storageDomain', 'studioIdentity', 'studioPolicy', 'subagents'];
class DomainAgentRepository {
    runTable;
    leaseTable;
    constructor(runTable, leaseTable) {
        this.runTable = runTable;
        this.leaseTable = leaseTable;
    }
    runs() { return [...this.runTable.entries()].map(([, value]) => value); }
    leases() { return [...this.leaseTable.entries()].map(([, value]) => value); }
    putRun(record) { return this.runTable.put(record.run_id, record); }
    putLease(record) { return this.leaseTable.put(record.lease_id, record); }
}
function providerState(ctx, name) {
    if (ctx.subagents.getProvider(name) === undefined)
        return 'NOT_CONFIGURED';
    const executable = name === 'claude-code' ? 'claude' : 'codex';
    const extensions = process.platform === 'win32'
        ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
        : [''];
    const present = (process.env.PATH ?? '').split(delimiter).filter(Boolean).some(directory => extensions.some(extension => {
        const candidate = join(directory, process.platform === 'win32' && extname(executable) === '' ? `${executable}${extension}` : executable);
        try {
            accessSync(candidate, constants.X_OK);
            return true;
        }
        catch {
            return false;
        }
    }));
    if (!present)
        return 'NOT_PRESENT';
    const configured = name === 'codex'
        ? existsSync(join(homedir(), '.codex', 'auth.json'))
        : existsSync(join(homedir(), '.claude', '.credentials.json')) || existsSync(join(homedir(), '.claude.json'));
    return configured ? 'OK' : 'NOT_CONFIGURED';
}
/** Mount the Studio-only delegation gate. Generic tool-subagent is deliberately not exposed. */
export async function apply(ctx, config = {}) {
    const presetService = ctx.agentPresets;
    const runsDomain = await ctx.storageDomain.open(studioAgentRunsDomainSpec);
    const leasesDomain = await ctx.storageDomain.open(studioAgentLeasesDomainSpec);
    // Um disposer só, na ordem certa. O cordis dispara os disposers com
    // `Promise.all`: dois efeitos separados rodariam CONCORRENTEMENTE, e o
    // fechamento do domínio (que passa a recusar escritas assim que começa)
    // corria contra o encerramento ativo, que ainda precisa gravar o desfecho
    // das execuções em voo. Registrar dois efeitos e confiar na ordem inversa
    // era uma suposição errada sobre o runtime.
    let shutdownAgents;
    ctx.effect(() => async () => {
        if (shutdownAgents !== undefined)
            await shutdownAgents();
        await Promise.all([runsDomain.close(), leasesDomain.close()]);
    }, 'studio-agents.shutdownThenClose');
    const repository = new DomainAgentRepository(runsDomain.table('runs'), leasesDomain.table('leases'));
    const coordinatorPreset = config.coordinatorPreset ?? 'dz23-coordinator';
    const inProcessCoordinatorPreset = config.inProcessCoordinatorPreset ?? 'dz23-coordinator-in-process';
    const approvedCoordinators = new Map();
    const unsetDelegationGrant = ctx.studioPolicy.setDelegationGrantResolver((execution) => {
        if (execution.agent === undefined)
            return undefined;
        return approvedGrantFor(ctx, execution.agent, approvedCoordinators);
    });
    ctx.effect(() => unsetDelegationGrant, 'studio-agents.delegationGrant');
    const worktreeRoot = resolve(config.worktreeRoot
        ?? process.env.DZ23_AGENT_WORKTREE_ROOT
        ?? resolve(homedir(), '.dz23-studio', 'worktrees'));
    const service = new StudioAgentService({
        repository,
        worktrees: new GitWorktreeManager(worktreeRoot),
        coordinators: {
            async create(cwd, parentSessionId, provider, approvedTier) {
                const selectedPreset = provider === 'spawn-in-process' ? inProcessCoordinatorPreset : coordinatorPreset;
                const coordinatorSessionId = SessionId(`studio-coordinator-${randomUUID()}`);
                const handle = await ctx.agents.create({
                    sessionId: coordinatorSessionId,
                    meta: {
                        cwd,
                        parentSession: parentSessionId,
                        origin: 'subagent',
                        delegationDepth: 1,
                        agentPreset: selectedPreset,
                    },
                    ...(provider === 'spawn-in-process' && config.inProcessProvider !== undefined && config.inProcessModel !== undefined
                        ? { agentOptions: { provider: config.inProcessProvider, model: config.inProcessModel } }
                        : {}),
                    setup: agentCtx => presetService.mount(agentCtx, selectedPreset).then(() => undefined),
                });
                const agent = handle.agent;
                if (agent.session.header.cwd !== cwd)
                    throw new Error(t('delegation.coordinatorCwdLost'));
                if (String(parentSessionId) === String(coordinatorSessionId))
                    throw new Error(t('delegation.coordinatorIsPersonSession'));
                approvedCoordinators.set(String(coordinatorSessionId), { tier: approvedTier, worktreePath: cwd });
                return {
                    sessionId: coordinatorSessionId,
                    agent,
                    async dispose() { approvedCoordinators.delete(String(coordinatorSessionId)); await handle.dispose(); },
                };
            },
        },
        subagents: {
            start(provider, request) {
                const inProcess = request.inProcess;
                return ctx.subagents.start(provider, {
                    parent: request.parent, prompt: request.prompt, signal: request.signal,
                    ...(provider === 'spawn-in-process' && inProcess?.toolFilter !== undefined
                        ? { toolFilter: { ...inProcess.toolFilter } }
                        : {}),
                    ...(provider === 'spawn-in-process' && inProcess?.persona !== undefined
                        ? { persona: inProcess.persona }
                        : {}),
                });
            },
        },
        /**
         * O consumo REAL de tokens da execução, quando ele existe.
         *
         * Vem da projeção `tokenUsage` do Harness, que soma o que o PROVEDOR
         * relatou por chamada - entrada, saída e o tráfego de cache. Não é uma
         * estimativa nossa, e não é a pressão de contexto do momento: é o que foi
         * consumido até aqui.
         *
         * `undefined` quando não há como medir, e nunca `0`. Um provedor externo
         * (`codex`, `claude-code`) roda em outro processo e não publica sessão
         * aqui; um `0` faria o Studio afirmar que uma execução não consumiu nada,
         * e o teto por tokens passaria a "não estourar" por falta de medição em
         * vez de por estar dentro do combinado.
         *
         * Resolvido a CADA uso e fora de `inject`: a projeção é opcional no perfil.
         */
        usage: {
            tokensFor(run) {
                const session = run.localAgent?.session;
                if (session === undefined)
                    return undefined;
                const projections = ctx.get('sessionProjections');
                if (projections === undefined)
                    return undefined;
                const value = projections.snapshot(session, ['tokenUsage']).values.tokenUsage;
                if (value === undefined)
                    return undefined;
                return value.uncachedInputTokens + value.outputTokens + value.cacheReadTokens + value.cacheWriteTokens;
            },
        },
        identity: {
            strongIdentityVerified(parentSessionId) {
                return ctx.studioIdentity.service
                    .strongIdentityForHarnessSession(String(parentSessionId));
            },
        },
        // Resolvido a CADA delegação, nunca capturado aqui, e fora de `inject`: o
        // botão de emergência é opcional no perfil, e um plugin que monte depois
        // deste não pode encontrar um consumidor surdo.
        emergencyStop: {
            assertRunning(scope) {
                const runtime = ctx.get('studioEmergencyStop');
                if (runtime !== undefined)
                    runtime.service.assertRunning(scope);
            },
        },
        jobs: {
            hasLiveJobs() {
                const seen = new Set();
                for (const agent of ctx.agents.list()) {
                    for (const job of ctx.jobs.list(agent)) {
                        if (seen.has(String(job.id)))
                            continue;
                        seen.add(String(job.id));
                        if (String(job.kind) === 'studio-agent' && (job.status === 'running' || job.status === 'stopping'))
                            return true;
                    }
                }
                return false;
            },
            start(spec) {
                return ctx.jobs.start(spec);
            },
        },
    });
    const restartReconciliation = await service.reconcileInterruptedRuns();
    ctx.jobs.attachController('dz23-studio-agents');
    // Encerramento ATIVO, ligado ao disposer único acima para que aconteça
    // ANTES do fechamento dos domínios. O que sobreviver ao prazo não é
    // declarado morto: fica para a reconciliação do próximo início.
    shutdownAgents = async () => {
        const outcome = await service.shutdown();
        if (outcome.pending > 0) {
            ctx.logger.warn(t('recovery.shutdownPending', { count: outcome.pending }));
        }
    };
    ctx.provide('studioAgents', {
        service,
        restartReconciliation,
        runs: () => repository.runs(),
        leases: () => repository.leases(),
        resumable: run => StudioAgentService.resumable(run),
        nextFence: scope => nextFence(repository.leases(), scope),
        providerStates: () => ({ codex: providerState(ctx, 'codex'), 'claude-code': providerState(ctx, 'claude-code') }),
    });
}
// `hasApprovedAncestor` foi REMOVIDA em 11/09/2026, e a remocao e o ponto:
// ela decidia autorizacao SO pela linhagem de sessoes, sem conferir o
// diretorio de trabalho. `approvedGrantFor`, logo abaixo, faz a mesma busca e
// ainda exige que o agente e o portador da concessao estejam no MESMO
// worktree. As duas ficavam lado a lado, exportadas, com nomes igualmente
// plausiveis - e a mais curta era a insegura. Ninguem chamava a insegura; o
// risco era o proximo leitor escolher pelo nome. Nao ha substituicao a fazer:
// `approvedGrantFor` ja e a versao correta e ja e a unica usada.
export function approvedGrantFor(ctx, agent, approved) {
    const seen = new Set();
    let current = agent;
    while (current !== undefined && !seen.has(String(current.session.id))) {
        const id = String(current.session.id);
        const grant = approved.get(id);
        if (grant !== undefined) {
            if (agent.session.header.cwd !== grant.worktreePath || current.session.header.cwd !== grant.worktreePath)
                return undefined;
            return {
                approvedTier: grant.tier,
                reason: t('delegation.coveredByIsolatedGrant'),
            };
        }
        seen.add(id);
        const parent = current.session.header.parentSession;
        current = parent === undefined ? undefined : ctx.agents.get(parent);
    }
    return undefined;
}
// `startDelegation` foi REMOVIDA em 11/09/2026: era um repasse de uma linha
// para `ctx.studioAgents.service.start(request)`, exportado, sem nenhum
// chamador e sem nenhum teste. Quem precisa iniciar uma delegacao chama o
// servico, que e onde as guardas moram. Uma porta de entrada publica que
// ninguem exercita e a que apodrece primeiro.

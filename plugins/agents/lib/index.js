import { SessionId } from '@deepseek-ai/dsh-session';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { delimiter, extname, join, resolve } from 'node:path';
import { accessSync, constants, existsSync } from 'node:fs';
import { studioAgentLeasesDomainSpec, studioAgentRunsDomainSpec, } from './model.js';
import { GitWorktreeManager, StudioAgentService, } from './service.js';
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
    ctx.effect(() => async () => { await Promise.all([runsDomain.close(), leasesDomain.close()]); }, 'studio-agents.domainClose');
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
                    throw new Error('O Harness não preservou o cwd isolado da sessão coordenadora.');
                if (String(parentSessionId) === String(coordinatorSessionId))
                    throw new Error('A sessão coordenadora não pode ser a sessão da pessoa.');
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
                        ? { toolFilter: inProcess.toolFilter }
                        : {}),
                    ...(provider === 'spawn-in-process' && inProcess?.persona !== undefined
                        ? { persona: inProcess.persona }
                        : {}),
                });
            },
        },
        identity: {
            strongIdentityVerified(parentSessionId) {
                return ctx.studioIdentity.service
                    .strongIdentityForHarnessSession(String(parentSessionId));
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
    ctx.provide('studioAgents', {
        service,
        restartReconciliation,
        runs: () => repository.runs(),
        leases: () => repository.leases(),
        providerStates: () => ({ codex: providerState(ctx, 'codex'), 'claude-code': providerState(ctx, 'claude-code') }),
    });
}
export function hasApprovedAncestor(ctx, agent, approved) {
    const seen = new Set();
    let current = agent;
    while (current !== undefined && !seen.has(String(current.session.id))) {
        const id = String(current.session.id);
        if (approved.has(id))
            return true;
        seen.add(id);
        const parent = current.session.header.parentSession;
        current = parent === undefined ? undefined : ctx.agents.get(parent);
    }
    return false;
}
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
                reason: 'Ação incluída na delegação isolada já confirmada pela pessoa.',
            };
        }
        seen.add(id);
        const parent = current.session.header.parentSession;
        current = parent === undefined ? undefined : ctx.agents.get(parent);
    }
    return undefined;
}
export function startDelegation(ctx, request) {
    return ctx.studioAgents.service.start(request);
}

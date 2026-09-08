import { normalizeDelegationPath } from '@dz23-studio/agents';
import { roleAllows } from '@dz23-studio/policy';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { t } from './i18n.js';
import { ASSISTANT_ALLOWED_PROVIDERS } from './catalog.js';
import { approvalFingerprint, approvalSubjectId, requireTier3Approval, } from './approval.js';
export class AssistantBridgeError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
export class StudioAssistantBridge {
    dependencies;
    #repositories;
    #jobs = new Map();
    #runsByJob = new Map();
    constructor(dependencies, repositories) {
        this.dependencies = dependencies;
        this.#repositories = repositories;
    }
    static async create(dependencies, repositories) {
        const validated = await Promise.all(repositories.map(validateAssistantRepository));
        const keys = new Set();
        for (const repository of validated) {
            const key = scopeKey(repository);
            if (keys.has(key))
                throw new AssistantBridgeError('INVALID_REQUEST', t('errors.duplicateRepository', { scope: key }));
            keys.add(key);
        }
        return new StudioAssistantBridge(dependencies, validated);
    }
    async start(agent, input, sensitive) {
        const principal = this.#principal(agent, 'project.write');
        const repository = this.#repository(principal);
        const prompt = input.prompt.trim();
        if (prompt.length < 3 || prompt.length > 20_000) {
            throw new AssistantBridgeError('INVALID_REQUEST', t('errors.promptLength'));
        }
        if (!isAssistantProvider(input.provider)) {
            throw new AssistantBridgeError('NOT_CONFIGURED', t('errors.externalProviderNotConfigured'));
        }
        const maxPaths = repository.maxPaths;
        if (input.intendedPaths.length === 0 || input.intendedPaths.length > maxPaths) {
            throw new AssistantBridgeError('INVALID_REQUEST', t('errors.pathCount', { max: maxPaths }));
        }
        const intendedPaths = [...new Set(input.intendedPaths.map(normalizeRelativePath))];
        if (intendedPaths.some(path => !repository.allowedPaths.some(allowed => withinAllowedPath(path, allowed)))) {
            throw new AssistantBridgeError('FORBIDDEN', t('errors.pathForbidden'));
        }
        const tier = sensitive === undefined ? 'T2' : 'T3';
        const approvedBy = sensitive === undefined
            ? principal.userId
            : await this.#tier3(principal, repository, `studio.agent.start.${sensitive}`, [input.provider, prompt, ...intendedPaths]);
        const accepted = this.dependencies.studioAgents.service.start({
            orgId: principal.orgId,
            tenantId: principal.tenantId,
            workspaceId: repository.workspaceId,
            repositoryPath: repository.repositoryPath,
            parent: agent,
            provider: input.provider,
            prompt,
            intendedPaths,
            approval: { approved: true, tier, approvedBy },
            ...(sensitive === 'secrets' ? { touchesSecrets: true } : {}),
            ...(sensitive === 'external-network' ? { usesExternalNetwork: true } : {}),
            ...(repository.budget === undefined ? {} : { budget: repository.budget }),
            ...(input.provider === 'spawn-in-process' && sensitive !== 'external-network'
                ? { inProcess: { toolFilter: { deny: ['network'] }, persona: t('runtime.persona') } }
                : {}),
        });
        this.#jobs.set(accepted.runId, { jobId: accepted.jobId, owner: agent, userId: principal.userId });
        this.#runsByJob.set(String(accepted.jobId), accepted.runId);
        return { run_id: accepted.runId, job_id: String(accepted.jobId), status: 'RUNNING', required_tier: accepted.requiredTier };
    }
    async startTeam(agent, input, sensitive) {
        const principal = this.#principal(agent, 'project.write');
        const repository = this.#repository(principal);
        if (!isAssistantProvider(input.provider)) {
            throw new AssistantBridgeError('NOT_CONFIGURED', t('errors.externalProviderNotConfigured'));
        }
        const tasks = input.tasks.map(task => ({
            ...task,
            intendedPaths: this.#validatedPaths(task.intendedPaths, repository),
        }));
        const teamApprovedBy = sensitive === undefined
            ? principal.userId
            : await this.#tier3(principal, repository, `studio.team.start.${sensitive}`, [
                input.provider,
                input.name,
                ...tasks.map(task => [task.taskId, task.title, task.role, task.prompt, ...task.intendedPaths].join('\u0001')),
            ]);
        const snapshot = await this.#teamsRuntime().service.start({
            orgId: principal.orgId,
            tenantId: principal.tenantId,
            workspaceId: repository.workspaceId,
            repositoryPath: repository.repositoryPath,
            parent: agent,
            provider: input.provider,
            name: input.name,
            tasks,
            approval: {
                approved: true,
                tier: sensitive === undefined ? 'T2' : 'T3',
                approvedBy: teamApprovedBy,
            },
            ...(sensitive === undefined ? {} : { sensitive }),
            ...(repository.budget === undefined ? {} : { budget: repository.budget }),
        });
        return this.#summarizeTeam(snapshot, principal, repository);
    }
    /**
     * Traduz uma operação sensível em confirmação humana real. O descritor é
     * derivado AQUI, no servidor: o modelo não escolhe nível, ação, sujeito nem
     * impressão digital.
     */
    async #tier3(principal, repository, action, parts) {
        const authority = this.dependencies.approvalAuthority;
        if (authority === undefined) {
            throw new AssistantBridgeError('NOT_CONFIGURED', t('errors.approvalNotConfigured'));
        }
        const granted = await requireTier3Approval(authority, {
            principal: {
                userId: principal.userId,
                orgId: principal.orgId,
                tenantId: principal.tenantId,
                sessionId: principal.sessionId,
            },
            action,
            subjectId: approvalSubjectId(repository.workspaceId, repository.repositoryPath),
            fingerprint: approvalFingerprint([action, repository.workspaceId, repository.repositoryPath, ...parts]),
        });
        return granted.approvedBy;
    }
    listTeams(agent) {
        const principal = this.#principal(agent, 'project.read');
        const repository = this.#repository(principal);
        const runtime = this.#teamsRuntime();
        return runtime.teams()
            .filter(team => teamBelongsToRepository(team, principal, repository))
            .map(team => this.#summarizeTeam({
            team,
            tasks: runtime.tasks().filter(task => task.team_id === team.team_id),
        }, principal, repository));
    }
    async teamStatus(agent, teamId) {
        const principal = this.#principal(agent, 'project.read');
        const repository = this.#repository(principal);
        this.#scopedTeam(teamId, principal, repository);
        return this.#summarizeTeam(await this.#teamsRuntime().service.status(teamId), principal, repository);
    }
    async continueTeam(agent, teamId, sensitive) {
        const principal = this.#principal(agent, 'project.write');
        const repository = this.#repository(principal);
        const team = this.#scopedTeam(teamId, principal, repository);
        const expectedTier = sensitive ? 'T3' : 'T2';
        if (team.required_tier !== expectedTier) {
            throw new AssistantBridgeError('INVALID_REQUEST', t('errors.teamTier'));
        }
        const approvedBy = sensitive
            ? await this.#tier3(principal, repository, 'studio.team.continue.sensitive', [teamId])
            : principal.userId;
        return this.#summarizeTeam(await this.#teamsRuntime().service.continue(teamId, agent, {
            approved: true,
            tier: expectedTier,
            approvedBy,
        }, repository.budget), principal, repository);
    }
    async cancelTeam(agent, teamId, reason) {
        const principal = this.#principal(agent, 'project.write');
        const repository = this.#repository(principal);
        this.#scopedTeam(teamId, principal, repository);
        return this.#summarizeTeam(await this.#teamsRuntime().service.cancel(teamId, principal.userId, reason), principal, repository);
    }
    list(agent) {
        const principal = this.#principal(agent, 'project.read');
        const repository = this.#repository(principal);
        return this.dependencies.studioAgents.runs()
            .filter(run => runBelongsToRepository(run, principal, repository))
            .map(summarize);
    }
    async review(agent, runId) {
        const principal = this.#principal(agent, 'project.read');
        const repository = this.#repository(principal);
        const run = this.#scopedRun(runId, principal, repository);
        const diff = await this.dependencies.studioAgents.service.reviewProposal(runId).catch((error) => {
            if (isErrorCode(error, 'PROPOSAL_TAMPERED')) {
                throw new AssistantBridgeError('INVALID_REQUEST', t('errors.proposalTampered'));
            }
            throw error;
        });
        return { ...summarize(run), diff_text: diff.text, main_changed_during_run: run.main_changed_during_run };
    }
    cancel(agent, runId, reason) {
        const principal = this.#principal(agent, 'project.write');
        const repository = this.#repository(principal);
        const run = this.#scopedRun(runId, principal, repository);
        if (run.approved_by !== principal.userId)
            throw new AssistantBridgeError('FORBIDDEN', t('errors.cancelOwner'));
        const active = this.#jobs.get(runId);
        if (active === undefined) {
            if (run.status !== 'RUNNING') {
                return { run_id: runId, outcome: 'already-finished', limitation: t('runtime.cancelReconciled') };
            }
            throw new AssistantBridgeError('CANCEL_UNAVAILABLE', t('errors.cancelUnavailable'));
        }
        if (active.userId !== principal.userId)
            throw new AssistantBridgeError('FORBIDDEN', t('errors.cancelOwner'));
        const outcome = this.dependencies.killJob(active.jobId, active.owner, reason?.trim() || t('runtime.cancelReason'));
        if (outcome === 'already-finished')
            this.releaseJob(active.jobId);
        return { run_id: runId, outcome, limitation: t('runtime.cancelBeta') };
    }
    /** Called by the authoritative Harness job lifecycle; it never changes a persisted run. */
    releaseJob(jobId) {
        const key = String(jobId);
        const runId = this.#runsByJob.get(key);
        if (runId === undefined)
            return;
        this.#runsByJob.delete(key);
        this.#jobs.delete(runId);
    }
    /** Bounded diagnostic used by the runtime proof to detect stale cancel handles. */
    activeJobCount() {
        return this.#jobs.size;
    }
    async apply(agent, runId) {
        const principal = this.#principal(agent, 'project.write');
        const repository = this.#repository(principal);
        this.#scopedRun(runId, principal, repository);
        return this.dependencies.studioAgents.service.applyProposal(runId, {
            approved: true,
            tier: 'T2',
            approvedBy: principal.userId,
        });
    }
    #principal(agent, permission) {
        if (agent === undefined)
            throw new AssistantBridgeError('UNAUTHENTICATED', t('errors.sessionRequired'));
        if (agent.session.header.agentPreset !== 'dz23-assistant'
            || agent.session.header.origin === 'subagent'
            || (agent.session.header.delegationDepth ?? 0) > 0) {
            throw new AssistantBridgeError('FORBIDDEN', t('errors.directPresetOnly'));
        }
        const principal = this.dependencies.resolvePrincipal(agent);
        if (principal === undefined)
            throw new AssistantBridgeError('UNAUTHENTICATED', t('errors.identityRequired'));
        const authorization = this.dependencies.authorizationFor(principal.userId, principal.orgId, principal.tenantId);
        if (authorization === undefined || !roleAllows(authorization.role, permission)) {
            throw new AssistantBridgeError('FORBIDDEN', t('errors.roleForbidden'));
        }
        return { ...principal, role: authorization.role };
    }
    #repository(principal) {
        const repository = this.#repositories.find(candidate => candidate.orgId === principal.orgId
            && candidate.tenantId === principal.tenantId && candidate.workspaceId === principal.tenantId);
        if (repository === undefined)
            throw new AssistantBridgeError('NOT_CONFIGURED', t('errors.repositoryMissing'));
        return repository;
    }
    #scopedRun(runId, principal, repository) {
        const run = this.dependencies.studioAgents.runs().find(candidate => candidate.run_id === runId);
        if (run === undefined || !runBelongsToRepository(run, principal, repository)) {
            throw new AssistantBridgeError('NOT_FOUND', t('errors.runMissing'));
        }
        return run;
    }
    #scopedTeam(teamId, principal, repository) {
        const team = this.#teamsRuntime().teams().find(candidate => candidate.team_id === teamId);
        if (team === undefined || !teamBelongsToRepository(team, principal, repository)) {
            throw new AssistantBridgeError('NOT_FOUND', t('errors.teamMissing'));
        }
        return team;
    }
    #validatedPaths(paths, repository) {
        if (!Array.isArray(paths) || paths.length === 0 || paths.length > repository.maxPaths) {
            throw new AssistantBridgeError('INVALID_REQUEST', t('errors.pathCount', { max: repository.maxPaths }));
        }
        const normalized = [...new Set(paths.map(normalizeRelativePath))];
        if (normalized.some(path => !repository.allowedPaths.some(allowed => withinAllowedPath(path, allowed)))) {
            throw new AssistantBridgeError('FORBIDDEN', t('errors.pathForbidden'));
        }
        return normalized;
    }
    #summarizeTeam(snapshot, principal, repository) {
        if (!teamBelongsToRepository(snapshot.team, principal, repository)
            || snapshot.tasks.some(task => !taskBelongsToTeam(task, snapshot.team))) {
            throw new AssistantBridgeError('NOT_FOUND', t('errors.teamMissing'));
        }
        return summarizeTeam(snapshot);
    }
    #teamsRuntime() {
        if (this.dependencies.studioAgentTeams === undefined) {
            throw new AssistantBridgeError('NOT_CONFIGURED', t('errors.teamNotConfigured'));
        }
        return this.dependencies.studioAgentTeams;
    }
}
export async function validateAssistantRepository(input) {
    assertExactObject(input, ['orgId', 'tenantId', 'workspaceId', 'repositoryPath', 'allowedPaths', 'providers', 'budget', 'maxPaths'], 'repository');
    if (![input.orgId, input.tenantId, input.workspaceId, input.repositoryPath].every(value => typeof value === 'string')) {
        throw new AssistantBridgeError('INVALID_REQUEST', t('errors.repositoryStrings'));
    }
    if (![input.orgId, input.tenantId, input.workspaceId].every(value => /^\S+$/.test(value))) {
        throw new AssistantBridgeError('INVALID_REQUEST', t('errors.scopeRequired'));
    }
    if (input.workspaceId !== input.tenantId) {
        throw new AssistantBridgeError('INVALID_REQUEST', t('errors.workspaceConstraint'));
    }
    if (!isAbsolute(input.repositoryPath))
        throw new AssistantBridgeError('INVALID_REQUEST', t('errors.absoluteRepository'));
    const repositoryPath = await realpath(resolve(input.repositoryPath));
    const info = await stat(repositoryPath);
    if (!info.isDirectory())
        throw new AssistantBridgeError('INVALID_REQUEST', t('errors.repositoryDirectory'));
    await validateGitBoundary(repositoryPath);
    if (!Array.isArray(input.allowedPaths) || input.allowedPaths.some(value => typeof value !== 'string')) {
        throw new AssistantBridgeError('INVALID_REQUEST', t('errors.allowedPathsType'));
    }
    const allowedPaths = input.allowedPaths.map(normalizeRelativePath);
    if (allowedPaths.length === 0)
        throw new AssistantBridgeError('INVALID_REQUEST', t('errors.allowedPathsType'));
    if (new Set(allowedPaths).size !== allowedPaths.length)
        throw new AssistantBridgeError('INVALID_REQUEST', t('errors.duplicatePaths'));
    const validProviders = ['spawn-in-process', 'codex', 'claude-code'];
    if (!Array.isArray(input.providers) || input.providers.some(provider => typeof provider !== 'string')) {
        throw new AssistantBridgeError('INVALID_REQUEST', t('errors.providersType'));
    }
    if (input.providers.some(provider => !validProviders.includes(provider))) {
        throw new AssistantBridgeError('INVALID_REQUEST', t('errors.unknownProvider'));
    }
    if (input.providers.some(provider => !isAssistantProvider(provider))) {
        throw new AssistantBridgeError('NOT_CONFIGURED', t('errors.externalProviderNotConfigured'));
    }
    const providers = new Set(input.providers);
    if (providers.size === 0)
        throw new AssistantBridgeError('INVALID_REQUEST', t('errors.providerRequired'));
    if (providers.size !== input.providers.length)
        throw new AssistantBridgeError('INVALID_REQUEST', t('errors.duplicateProviders'));
    const maxPaths = input.maxPaths ?? 20;
    if (!Number.isSafeInteger(maxPaths) || maxPaths < 1 || maxPaths > 50) {
        throw new AssistantBridgeError('INVALID_REQUEST', t('errors.maxPaths'));
    }
    validateBudget(input.budget);
    return { ...input, repositoryPath, allowedPaths, providers, maxPaths };
}
export function normalizeRelativePath(value) {
    return normalizeDelegationPath(value, false, path => new AssistantBridgeError('INVALID_REQUEST', t('errors.invalidPath', { path })));
}
function withinAllowedPath(candidate, allowed) {
    return candidate === allowed || candidate.startsWith(`${allowed}/`);
}
function validateBudget(budget) {
    if (budget === undefined)
        return;
    assertExactObject(budget, ['timeoutMs', 'maxFiles', 'maxDiffBytes', 'maxTokens'], 'budget');
    const limits = [
        ['timeoutMs', 60 * 60_000],
        ['maxFiles', 50],
        ['maxDiffBytes', 2 * 1024 * 1024],
        ['maxTokens', 2_000_000],
    ];
    for (const [key, maximum] of limits) {
        const value = budget[key];
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 0 || value > maximum)) {
            throw new AssistantBridgeError('INVALID_REQUEST', t('errors.budget', { field: key, max: maximum }));
        }
    }
}
async function validateGitBoundary(repositoryPath) {
    const gitMarker = resolve(repositoryPath, '.git');
    const marker = await lstat(gitMarker).catch(() => undefined);
    if (marker === undefined || marker.isSymbolicLink()) {
        throw new AssistantBridgeError('INVALID_REQUEST', t('errors.gitRoot'));
    }
    if (marker.isDirectory()) {
        await validateGitEntries(gitMarker, gitMarker);
        return;
    }
    if (!marker.isFile() || marker.size < 8 || marker.size > 4_096) {
        throw new AssistantBridgeError('INVALID_REQUEST', t('errors.gitRoot'));
    }
    const descriptor = await readFile(gitMarker, 'utf8');
    const match = /^gitdir: ([^\r\n\0]+)\r?\n?$/u.exec(descriptor);
    if (match === null)
        throw new AssistantBridgeError('INVALID_REQUEST', t('errors.gitRoot'));
    const adminDeclared = resolve(repositoryPath, match[1]);
    const adminDeclaredInfo = await lstat(adminDeclared).catch(() => undefined);
    if (adminDeclaredInfo === undefined || adminDeclaredInfo.isSymbolicLink()) {
        throw new AssistantBridgeError('INVALID_REQUEST', t('errors.gitRoot'));
    }
    const adminPath = await realpath(adminDeclared);
    const admin = await lstat(adminPath);
    if (admin.isSymbolicLink() || !admin.isDirectory())
        throw new AssistantBridgeError('INVALID_REQUEST', t('errors.gitRoot'));
    const commonDescriptor = await readFile(resolve(adminPath, 'commondir'), 'utf8').catch(() => '');
    if (commonDescriptor.length === 0 || commonDescriptor.length > 1_024 || /[\r\n\0]/u.test(commonDescriptor.trim())) {
        throw new AssistantBridgeError('INVALID_REQUEST', t('errors.gitRoot'));
    }
    const commonDeclared = resolve(adminPath, commonDescriptor.trim());
    const commonDeclaredInfo = await lstat(commonDeclared).catch(() => undefined);
    if (commonDeclaredInfo === undefined || commonDeclaredInfo.isSymbolicLink()) {
        throw new AssistantBridgeError('INVALID_REQUEST', t('errors.gitRoot'));
    }
    const commonPath = await realpath(commonDeclared);
    const worktreesPath = resolve(commonPath, 'worktrees');
    const worktreesInfo = await lstat(worktreesPath).catch(() => undefined);
    if (worktreesInfo === undefined || worktreesInfo.isSymbolicLink() || !worktreesInfo.isDirectory()) {
        throw new AssistantBridgeError('INVALID_REQUEST', t('errors.gitRoot'));
    }
    const canonicalWorktrees = await realpath(worktreesPath);
    if (!sameCanonicalPath(dirname(adminPath), canonicalWorktrees)) {
        throw new AssistantBridgeError('INVALID_REQUEST', t('errors.gitRoot'));
    }
    const reciprocalDescriptor = await readFile(resolve(adminPath, 'gitdir'), 'utf8').catch(() => '');
    if (reciprocalDescriptor.length === 0 || reciprocalDescriptor.length > 4_096 || /[\r\n\0]/u.test(reciprocalDescriptor.trim())) {
        throw new AssistantBridgeError('INVALID_REQUEST', t('errors.gitRoot'));
    }
    const reciprocalPath = await realpath(resolve(adminPath, reciprocalDescriptor.trim())).catch(() => undefined);
    // repositoryPath is already canonical and .git was lstat-verified as a
    // regular file, so resolving the marker again only introduced a TOCTOU gap.
    if (reciprocalPath === undefined || !sameCanonicalPath(reciprocalPath, gitMarker)) {
        throw new AssistantBridgeError('INVALID_REQUEST', t('errors.gitRoot'));
    }
    await validateGitEntries(adminPath, commonPath);
}
function sameCanonicalPath(left, right) {
    return relative(resolve(left), resolve(right)) === '';
}
function isAssistantProvider(provider) {
    return ASSISTANT_ALLOWED_PROVIDERS.includes(provider);
}
async function validateGitEntries(adminPath, commonPath) {
    const head = await lstat(resolve(adminPath, 'HEAD')).catch(() => undefined);
    if (head === undefined || head.isSymbolicLink() || !head.isFile()) {
        throw new AssistantBridgeError('INVALID_REQUEST', t('errors.gitRoot'));
    }
    for (const name of ['objects', 'refs']) {
        const entry = await lstat(resolve(commonPath, name)).catch(() => undefined);
        if (entry === undefined || entry.isSymbolicLink() || !entry.isDirectory()) {
            throw new AssistantBridgeError('INVALID_REQUEST', t('errors.gitRoot'));
        }
    }
    for (const name of ['config', 'index']) {
        const path = resolve(name === 'config' ? commonPath : adminPath, name);
        const entry = await lstat(path).catch(() => undefined);
        if (entry !== undefined && (entry.isSymbolicLink() || !entry.isFile())) {
            throw new AssistantBridgeError('INVALID_REQUEST', t('errors.gitRoot'));
        }
    }
}
function assertExactObject(value, allowedKeys, label) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new AssistantBridgeError('INVALID_REQUEST', t('errors.objectRequired', { label }));
    }
    const allowed = new Set(allowedKeys);
    const unexpected = Object.keys(value).filter(key => !allowed.has(key));
    if (unexpected.length > 0) {
        throw new AssistantBridgeError('INVALID_REQUEST', t('errors.unknownFields', { label, fields: unexpected.join(', ') }));
    }
}
function scopeKey(config) {
    return `${config.orgId}:${config.tenantId}:${config.workspaceId}`;
}
function belongsTo(run, principal, workspaceId) {
    return run.org_id === principal.orgId && run.tenant_id === principal.tenantId && run.workspace_id === workspaceId;
}
function summarize(run) {
    return {
        run_id: run.run_id,
        status: run.status,
        provider: run.provider,
        changed_files: run.changed_files,
        diagnostic: run.diagnostic,
        created_at: run.created_at,
        updated_at: run.updated_at,
    };
}
function isErrorCode(error, code) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
function runBelongsToRepository(run, principal, repository) {
    if (!belongsTo(run, principal, repository.workspaceId)
        || !isAssistantProvider(run.provider)
        || typeof run.repository_path !== 'string'
        || !sameCanonicalPath(run.repository_path, repository.repositoryPath)
        || !Array.isArray(run.changed_files)) {
        return false;
    }
    return run.changed_files.every(path => {
        if (typeof path !== 'string')
            return false;
        try {
            const normalized = normalizeRelativePath(path);
            return normalized === path && repository.allowedPaths.some(allowed => withinAllowedPath(normalized, allowed));
        }
        catch {
            return false;
        }
    });
}
function teamBelongsToRepository(team, principal, repository) {
    return team.org_id === principal.orgId
        && team.tenant_id === principal.tenantId
        && team.workspace_id === repository.workspaceId
        && team.provider === 'spawn-in-process'
        && sameCanonicalPath(team.repository_path, repository.repositoryPath);
}
function taskBelongsToTeam(task, team) {
    return task.team_id === team.team_id
        && task.org_id === team.org_id
        && task.tenant_id === team.tenant_id
        && task.workspace_id === team.workspace_id;
}
function summarizeTeam(snapshot) {
    return {
        team_id: snapshot.team.team_id,
        name: snapshot.team.name,
        status: snapshot.team.status,
        required_tier: snapshot.team.required_tier,
        diagnostic: snapshot.team.diagnostic,
        tasks: snapshot.tasks.map(task => ({
            task_id: task.task_id,
            title: task.title,
            role: task.role,
            status: task.status,
            run_id: task.run_id,
            depends_on: task.depends_on,
            diagnostic: task.diagnostic,
        })),
        created_at: snapshot.team.created_at,
        updated_at: snapshot.team.updated_at,
    };
}

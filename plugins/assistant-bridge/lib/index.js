import { defineTool } from '@deepseek-ai/dsh-tools';
import { principalForAgent } from '@dz23-studio/identity';
import { ASSISTANT_ALLOWED_PROVIDERS, ASSISTANT_TOOL_NAMES, assertAssistantToolCatalog } from './catalog.js';
import { StudioAssistantBridge, } from './service.js';
import { t } from './i18n.js';
import { closedTool } from './closed-tool.js';
export * from './catalog.js';
export * from './approval.js';
export * from './closed-tool.js';
export * from './service.js';
export const name = 'dz23-studio-assistant-bridge';
export const inject = ['agents', 'jobs', 'studioAgents', 'studioAgentTeams', 'studioIdentity', 'studioTenancy', 'tools'];
const jsonOutput = {
    schema: {
        type: 'object',
        additionalProperties: false,
        properties: { json: { type: 'string', required: true } },
    },
    render: (_args, value) => [{ type: 'text', text: value.json }],
};
export function createAssistantTools(bridge) {
    const taskParameters = {
        prompt: { type: 'string', required: true, description: t('tools.prompt') },
        intended_paths: {
            type: 'array', required: true, items: { type: 'string' },
            description: t('tools.paths'),
        },
    };
    const teamTaskItems = {
        type: 'object',
        additionalProperties: false,
        properties: {
            task_id: { type: 'string', required: true, description: t('tools.taskId') },
            title: { type: 'string', required: true, description: t('tools.taskTitle') },
            role: {
                type: 'string', required: true, enum: ['implementer', 'reviewer', 'tester', 'synthesizer'],
                description: t('tools.taskRole'),
            },
            prompt: { type: 'string', required: true, description: t('tools.prompt') },
            intended_paths: { type: 'array', required: true, items: { type: 'string' }, description: t('tools.paths') },
            depends_on: { type: 'array', required: true, items: { type: 'string' }, description: t('tools.taskDependencies') },
        },
    };
    const teamParameters = {
        provider: {
            type: 'string', required: true, enum: [...ASSISTANT_ALLOWED_PROVIDERS],
            description: t('tools.localProvider'),
        },
        name: { type: 'string', required: true, description: t('tools.teamName') },
        tasks: { type: 'array', required: true, items: teamTaskItems, description: t('tools.teamTasks') },
    };
    return [
        closedTool(defineTool({
            name: 'studio_agent_start',
            description: t('tools.start'),
            parameters: {
                provider: {
                    type: 'string', required: true, enum: [...ASSISTANT_ALLOWED_PROVIDERS],
                    description: t('tools.localProvider'),
                },
                ...taskParameters,
            },
            output: jsonOutput,
            async execute(args, exec) {
                return { json: JSON.stringify(await bridge.start(asAssistantAgent(exec.agent), {
                        provider: args.provider,
                        prompt: args.prompt,
                        intendedPaths: args.intended_paths,
                    })) };
            },
        }), ['provider', 'prompt', 'intended_paths']),
        closedTool(defineTool({
            name: 'studio_agent_start_sensitive',
            description: t('tools.startSensitive'),
            parameters: {
                provider: {
                    type: 'string', required: true, enum: [...ASSISTANT_ALLOWED_PROVIDERS],
                    description: t('tools.sensitiveProvider'),
                },
                ...taskParameters,
                operation: {
                    type: 'string', required: true, enum: ['secrets', 'external-network'],
                    description: t('tools.operation'),
                },
            },
            output: jsonOutput,
            async execute(args, exec) {
                return { json: JSON.stringify(await bridge.start(asAssistantAgent(exec.agent), {
                        provider: args.provider,
                        prompt: args.prompt,
                        intendedPaths: args.intended_paths,
                    }, args.operation)) };
            },
        }), ['provider', 'prompt', 'intended_paths', 'operation']),
        closedTool(defineTool({
            name: 'studio_agent_resolve_unknown',
            description: t('tools.resolveUnknown'),
            parameters: {
                run_id: { type: 'string', required: true, description: t('tools.runId') },
                reason: { type: 'string', required: true, description: t('tools.resolveReason') },
            },
            output: jsonOutput,
            async execute(args, exec) {
                return { json: JSON.stringify(await bridge.resolveUnknownRun(asAssistantAgent(exec.agent), args.run_id, args.reason)) };
            },
        }), ['run_id', 'reason']),
        closedTool(defineTool({
            name: 'studio_agent_resume',
            description: t('tools.resume'),
            parameters: {
                run_id: { type: 'string', required: true, description: t('tools.runId') },
                prompt: { type: 'string', required: true, description: t('tools.resumePrompt') },
            },
            output: jsonOutput,
            async execute(args, exec) {
                return { json: JSON.stringify(await bridge.resume(asAssistantAgent(exec.agent), args.run_id, args.prompt)) };
            },
        }), ['run_id', 'prompt']),
        closedTool(defineTool({
            name: 'studio_agent_list',
            description: t('tools.list'),
            parameters: {},
            output: jsonOutput,
            async execute(_args, exec) { return { json: JSON.stringify(bridge.list(asAssistantAgent(exec.agent))) }; },
        }), []),
        closedTool(defineTool({
            name: 'studio_agent_review',
            description: t('tools.review'),
            parameters: { run_id: { type: 'string', required: true, description: t('tools.runId') } },
            output: jsonOutput,
            async execute(args, exec) { return { json: JSON.stringify(await bridge.review(asAssistantAgent(exec.agent), args.run_id)) }; },
        }), ['run_id']),
        closedTool(defineTool({
            name: 'studio_agent_cancel',
            description: t('tools.cancel'),
            parameters: {
                run_id: { type: 'string', required: true },
                reason: { type: 'string', description: t('tools.reason') },
            },
            output: jsonOutput,
            async execute(args, exec) { return { json: JSON.stringify(bridge.cancel(asAssistantAgent(exec.agent), args.run_id, args.reason)) }; },
        }), ['run_id', 'reason']),
        closedTool(defineTool({
            name: 'studio_agent_apply',
            description: t('tools.apply'),
            parameters: { run_id: { type: 'string', required: true, description: t('tools.proposedRun') } },
            output: jsonOutput,
            async execute(args, exec) { return { json: JSON.stringify(await bridge.apply(asAssistantAgent(exec.agent), args.run_id)) }; },
        }), ['run_id']),
        closedTool(defineTool({
            name: 'studio_team_start',
            description: t('tools.teamStart'),
            parameters: teamParameters,
            output: jsonOutput,
            async execute(args, exec) {
                return { json: JSON.stringify(await bridge.startTeam(asAssistantAgent(exec.agent), {
                        provider: args.provider,
                        name: args.name,
                        tasks: args.tasks.map(task => ({
                            taskId: task.task_id, title: task.title, role: task.role, prompt: task.prompt,
                            intendedPaths: task.intended_paths, dependsOn: task.depends_on,
                        })),
                    })) };
            },
        }), ['provider', 'name', 'tasks']),
        closedTool(defineTool({
            name: 'studio_team_start_sensitive',
            description: t('tools.teamStartSensitive'),
            parameters: {
                ...teamParameters,
                operation: {
                    type: 'string', required: true, enum: ['secrets', 'external-network', 'deploy'],
                    description: t('tools.operation'),
                },
            },
            output: jsonOutput,
            async execute(args, exec) {
                return { json: JSON.stringify(await bridge.startTeam(asAssistantAgent(exec.agent), {
                        provider: args.provider,
                        name: args.name,
                        tasks: args.tasks.map(task => ({
                            taskId: task.task_id, title: task.title, role: task.role, prompt: task.prompt,
                            intendedPaths: task.intended_paths, dependsOn: task.depends_on,
                        })),
                    }, args.operation)) };
            },
        }), ['provider', 'name', 'tasks', 'operation']),
        closedTool(defineTool({
            name: 'studio_team_list',
            description: t('tools.teamList'),
            parameters: {},
            output: jsonOutput,
            async execute(_args, exec) { return { json: JSON.stringify(bridge.listTeams(asAssistantAgent(exec.agent))) }; },
        }), []),
        closedTool(defineTool({
            name: 'studio_team_status',
            description: t('tools.teamStatus'),
            parameters: { team_id: { type: 'string', required: true, description: t('tools.teamId') } },
            output: jsonOutput,
            async execute(args, exec) { return { json: JSON.stringify(await bridge.teamStatus(asAssistantAgent(exec.agent), args.team_id)) }; },
        }), ['team_id']),
        closedTool(defineTool({
            name: 'studio_team_continue',
            description: t('tools.teamContinue'),
            parameters: { team_id: { type: 'string', required: true, description: t('tools.teamId') } },
            output: jsonOutput,
            async execute(args, exec) { return { json: JSON.stringify(await bridge.continueTeam(asAssistantAgent(exec.agent), args.team_id, false)) }; },
        }), ['team_id']),
        closedTool(defineTool({
            name: 'studio_team_continue_sensitive',
            description: t('tools.teamContinueSensitive'),
            parameters: { team_id: { type: 'string', required: true, description: t('tools.teamId') } },
            output: jsonOutput,
            async execute(args, exec) { return { json: JSON.stringify(await bridge.continueTeam(asAssistantAgent(exec.agent), args.team_id, true)) }; },
        }), ['team_id']),
        closedTool(defineTool({
            name: 'studio_team_cancel',
            description: t('tools.teamCancel'),
            parameters: {
                team_id: { type: 'string', required: true, description: t('tools.teamId') },
                reason: { type: 'string', description: t('tools.reason') },
            },
            output: jsonOutput,
            async execute(args, exec) { return { json: JSON.stringify(await bridge.cancelTeam(asAssistantAgent(exec.agent), args.team_id, args.reason)) }; },
        }), ['team_id', 'reason']),
    ];
}
function asAssistantAgent(agent) {
    return agent;
}
export async function apply(ctx, config) {
    validatePluginConfig(config);
    const agentLookup = {
        getBySessionId: sessionId => ctx.agents.get(sessionId),
    };
    const bridge = await StudioAssistantBridge.create({
        resolvePrincipal: agent => principalForAgent(ctx.studioIdentity.service, agentLookup, agent),
        authorizationFor: (userId, orgId, tenantId) => ctx.studioTenancy.service.authorizationFor(userId, orgId, tenantId),
        studioAgents: ctx.studioAgents,
        studioAgentTeams: ctx.studioAgentTeams,
        // Lido a cada uso, nunca capturado na montagem: a ordem de montagem entre
        // plugins não é garantida, e uma autoridade que sobe depois deste plugin
        // precisa ser encontrada mesmo assim. Sem ela no momento do uso, T3 recusa.
        approvalAuthority: () => ctx.get('studioActionApproval')?.service,
        killJob: (jobId, owner, reason) => ctx.jobs.kill(jobId, owner, reason),
    }, config.repositories ?? []);
    const tools = createAssistantTools(bridge);
    assertAssistantToolCatalog(tools.map(tool => tool.name), config.exposedTools);
    const disposers = tools.map(tool => ctx.tools.register(tool));
    const detachJobDone = ctx.jobs.onJobDone(snapshot => bridge.releaseJob(snapshot.id));
    ctx.effect(() => () => {
        detachJobDone();
        for (const dispose of disposers.reverse())
            dispose();
    }, 'dz23-studio-assistant-bridge.tools');
    ctx.provide('studioAssistant', {
        bridge,
        tools: tools.map(tool => tool.name),
        automaticSessionCreation: 'NOT_PRESENT',
        teamCoordination: 'BETA_MANUAL_DEPENDENCY_CONTINUE',
    });
}
function validatePluginConfig(config) {
    if (typeof config !== 'object' || config === null || Array.isArray(config))
        throw new Error(t('errors.pluginObject'));
    const unknown = Object.keys(config).filter(key => key !== 'exposedTools' && key !== 'repositories');
    if (unknown.length > 0)
        throw new Error(t('errors.pluginUnknown', { fields: unknown.join(', ') }));
    if (!Array.isArray(config.exposedTools) || config.exposedTools.some(name => typeof name !== 'string')) {
        throw new Error(t('errors.pluginTools'));
    }
    if (config.repositories !== undefined && !Array.isArray(config.repositories)) {
        throw new Error(t('errors.pluginRepositories'));
    }
}

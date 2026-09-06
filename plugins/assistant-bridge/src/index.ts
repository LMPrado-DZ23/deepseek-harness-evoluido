import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-jobs'
import type { DelegationAccepted, DelegationRequest } from '@dz23-studio/agents'
import { principalForAgent } from '@dz23-studio/identity'
import type {} from '@dz23-studio/tenancy'
import { ASSISTANT_ALLOWED_PROVIDERS, ASSISTANT_TOOL_NAMES, assertAssistantToolCatalog } from './catalog.js'
import {
  StudioAssistantBridge,
  type AssistantRepositoryConfig,
} from './service.js'
import { t } from './i18n.js'
import { closedTool } from './closed-tool.js'

export * from './catalog.js'
export * from './closed-tool.js'
export * from './service.js'

export const name = 'dz23-studio-assistant-bridge'
export const inject = ['agents', 'jobs', 'studioAgents', 'studioIdentity', 'studioTenancy', 'tools']

export interface Config {
  readonly exposedTools: readonly string[]
  readonly repositories?: readonly AssistantRepositoryConfig[]
}

export interface StudioAssistantRuntime {
  readonly bridge: StudioAssistantBridge
  readonly tools: readonly string[]
  readonly automaticSessionCreation: 'NOT_PRESENT'
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    studioAssistant: StudioAssistantRuntime
  }
}

const jsonOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { json: { type: 'string', required: true } },
  },
  render: (_args: unknown, value: { readonly json: string }) => [{ type: 'text' as const, text: value.json }],
} as const

export function createAssistantTools(bridge: StudioAssistantBridge): readonly ToolDefinition[] {
  const taskParameters = {
    prompt: { type: 'string', required: true, description: t('tools.prompt') },
    intended_paths: {
      type: 'array', required: true, items: { type: 'string' },
      description: t('tools.paths'),
    },
  } as const

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
        return { json: JSON.stringify(bridge.start(asAssistantAgent(exec.agent), {
          provider: args.provider,
          prompt: args.prompt,
          intendedPaths: args.intended_paths,
        })) }
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
        return { json: JSON.stringify(bridge.start(asAssistantAgent(exec.agent), {
          provider: args.provider,
          prompt: args.prompt,
          intendedPaths: args.intended_paths,
        }, args.operation)) }
      },
    }), ['provider', 'prompt', 'intended_paths', 'operation']),
    closedTool(defineTool({
      name: 'studio_agent_list',
      description: t('tools.list'),
      parameters: {},
      output: jsonOutput,
      async execute(_args, exec) { return { json: JSON.stringify(bridge.list(asAssistantAgent(exec.agent))) } },
    }), []),
    closedTool(defineTool({
      name: 'studio_agent_review',
      description: t('tools.review'),
      parameters: { run_id: { type: 'string', required: true, description: t('tools.runId') } },
      output: jsonOutput,
      async execute(args, exec) { return { json: JSON.stringify(await bridge.review(asAssistantAgent(exec.agent), args.run_id)) } },
    }), ['run_id']),
    closedTool(defineTool({
      name: 'studio_agent_cancel',
      description: t('tools.cancel'),
      parameters: {
        run_id: { type: 'string', required: true },
        reason: { type: 'string', description: t('tools.reason') },
      },
      output: jsonOutput,
      async execute(args, exec) { return { json: JSON.stringify(bridge.cancel(asAssistantAgent(exec.agent), args.run_id, args.reason)) } },
    }), ['run_id', 'reason']),
    closedTool(defineTool({
      name: 'studio_agent_apply',
      description: t('tools.apply'),
      parameters: { run_id: { type: 'string', required: true, description: t('tools.proposedRun') } },
      output: jsonOutput,
      async execute(args, exec) { return { json: JSON.stringify(await bridge.apply(asAssistantAgent(exec.agent), args.run_id)) } },
    }), ['run_id']),
  ]
}

function asAssistantAgent(agent: unknown): DelegationRequest['parent'] | undefined {
  return agent as DelegationRequest['parent'] | undefined
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  validatePluginConfig(config)
  const bridge = await StudioAssistantBridge.create({
    resolvePrincipal: agent => principalForAgent(ctx.studioIdentity.service, ctx.agents, agent as never),
    authorizationFor: (userId, orgId, tenantId) => ctx.studioTenancy.service.authorizationFor(userId, orgId, tenantId),
    studioAgents: ctx.studioAgents,
    killJob: (jobId, owner, reason) => ctx.jobs.kill(jobId as never, owner as never, reason),
  }, config.repositories ?? [])
  const tools = createAssistantTools(bridge)
  assertAssistantToolCatalog(tools.map(tool => tool.name), config.exposedTools)
  const disposers = tools.map(tool => ctx.tools.register(tool))
  const detachJobDone = ctx.jobs.onJobDone(snapshot => bridge.releaseJob(snapshot.id as unknown as DelegationAccepted['jobId']))
  ctx.effect(() => () => {
    detachJobDone()
    for (const dispose of disposers.reverse()) dispose()
  }, 'dz23-studio-assistant-bridge.tools')
  ctx.provide('studioAssistant', {
    bridge,
    tools: tools.map(tool => tool.name),
    automaticSessionCreation: 'NOT_PRESENT',
  })
}

function validatePluginConfig(config: Config): void {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) throw new Error(t('errors.pluginObject'))
  const unknown = Object.keys(config).filter(key => key !== 'exposedTools' && key !== 'repositories')
  if (unknown.length > 0) throw new Error(t('errors.pluginUnknown', { fields: unknown.join(', ') }))
  if (!Array.isArray(config.exposedTools) || config.exposedTools.some(name => typeof name !== 'string')) {
    throw new Error(t('errors.pluginTools'))
  }
  if (config.repositories !== undefined && !Array.isArray(config.repositories)) {
    throw new Error(t('errors.pluginRepositories'))
  }
}

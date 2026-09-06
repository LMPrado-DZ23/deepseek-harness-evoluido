import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

export const agentTeamStatusSchema = z.enum([
  'RUNNING',
  'WAITING_FOR_APPROVAL',
  'NEEDS_ATTENTION',
  'COMPLETED',
  'CANCELLED',
])

export const agentTeamTaskStatusSchema = z.enum([
  'QUEUED',
  'RUNNING',
  'PROPOSED',
  'APPLIED',
  'FAILED',
  'CANCELLED',
  'BUDGET_EXCEEDED',
  'REJECTED',
])

export const agentTeamRoleSchema = z.enum(['implementer', 'reviewer', 'tester', 'synthesizer'])

export const agentTeamSchema = z.object({
  team_id: z.string().min(1),
  org_id: z.string().min(1),
  tenant_id: z.string().min(1),
  workspace_id: z.string().min(1),
  repository_path: z.string().min(1),
  parent_session_id: z.string().min(1),
  name: z.string().min(3).max(100),
  provider: z.literal('spawn-in-process'),
  required_tier: z.enum(['T2', 'T3']),
  sensitive_operation: z.enum(['secrets', 'external-network', 'deploy']).nullable(),
  status: agentTeamStatusSchema,
  approved_by: z.string().min(1),
  approved_at: z.iso.datetime(),
  diagnostic: z.string().nullable(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
}).strict()

export const agentTeamTaskSchema = z.object({
  task_id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u),
  team_id: z.string().min(1),
  org_id: z.string().min(1),
  tenant_id: z.string().min(1),
  workspace_id: z.string().min(1),
  title: z.string().min(3).max(120),
  role: agentTeamRoleSchema,
  prompt: z.string().min(3).max(20_000),
  intended_paths: z.array(z.string().min(1)).min(1).max(20),
  depends_on: z.array(z.string().min(1)).max(7),
  status: agentTeamTaskStatusSchema,
  run_id: z.string().min(1).nullable(),
  job_id: z.string().min(1).nullable(),
  diagnostic: z.string().nullable(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
}).strict()

export type AgentTeamRecord = z.infer<typeof agentTeamSchema>
export type AgentTeamTaskRecord = z.infer<typeof agentTeamTaskSchema>
export type AgentTeamRole = z.infer<typeof agentTeamRoleSchema>

declare const agentTeamKeyBrand: unique symbol
declare const agentTeamTaskKeyBrand: unique symbol
export type AgentTeamKey = string & { readonly [agentTeamKeyBrand]: true }
export type AgentTeamTaskKey = string & { readonly [agentTeamTaskKeyBrand]: true }

export const STUDIO_AGENT_TEAMS_PHYSICAL_DOMAIN = 'studio_agent_teams'
export const STUDIO_AGENT_TEAMS_LOGICAL_DOMAIN = 'studio.agent.teams'

export const studioAgentTeamsDomainSpec = defineDomain({
  name: STUDIO_AGENT_TEAMS_PHYSICAL_DOMAIN,
  version: 1,
  tables: {
    teams: domainTable<AgentTeamKey, AgentTeamRecord>(agentTeamSchema),
    tasks: domainTable<AgentTeamTaskKey, AgentTeamTaskRecord>(agentTeamTaskSchema),
  },
})

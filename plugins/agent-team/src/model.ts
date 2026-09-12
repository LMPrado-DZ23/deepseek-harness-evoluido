import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { AGENT_TEAM_ROLES } from './roles.js'

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
  /** Espelha o UNKNOWN da execucao: ausencia de prova, nao conclusao. */
  'UNKNOWN',
])

/**
 * Os papéis (A-06). A lista vem de `roles.ts`, onde cada um também declara o
 * que pode tocar: um papel que existisse aqui sem linha lá seria um nome sem
 * poder definido, que é o defeito que este requisito tinha.
 */
export const agentTeamRoleSchema = z.enum(AGENT_TEAM_ROLES)

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
  /**
   * O teto de tokens da EQUIPE INTEIRA, quando alguém declarou um.
   *
   * Existe por uma conta que ninguém estava fazendo: o orçamento que existia
   * (`budget.maxTokens`) é POR TAREFA, e uma equipe tem até oito. Oito tarefas
   * cada uma dentro do combinado gastam oito vezes o que a pessoa aprovou — e
   * cada execução, olhada sozinha, estava certa. Teto por parte não é teto.
   *
   * `null` quando ninguém declarou, e aí nada muda: quem não pediu teto não
   * passa a ter um. O teto é do PEDIDO da pessoa, não um padrão nosso.
   *
   * OPCIONAL com a versão do domínio INTOCADA: subir a versão faria `open()`
   * falhar com `version-mismatch` em instalação que já rodou, e não existe
   * passo de migração aqui. Equipe gravada antes deste campo não tem teto —
   * que é a verdade sobre ela.
   */
  max_total_tokens: z.number().int().positive().nullable().optional(),
  /**
   * A missão a que esta equipe pertence, quando pertence a alguma.
   *
   * Existe porque o teto por equipe não alcança o que a MISSÃO gasta: três
   * equipes, cada uma dentro do próprio teto, gastam três vezes o que foi
   * combinado para a missão — e cada equipe, olhada sozinha, está certa. É a
   * mesma conta que `max_total_tokens` existe para fazer, um nível acima.
   *
   * `null` quando a equipe não pertence a missão nenhuma, e aí nada muda.
   *
   * OPCIONAL com a versão do domínio INTOCADA, pela mesma razão do campo acima:
   * subir a versão faria `open()` falhar com `version-mismatch` em instalação
   * que já rodou, e não existe passo de migração aqui.
   */
  mission_id: z.string().min(1).nullable().optional(),
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
  version: 2,
  tables: {
    teams: domainTable<AgentTeamKey, AgentTeamRecord>(agentTeamSchema),
    tasks: domainTable<AgentTeamTaskKey, AgentTeamTaskRecord>(agentTeamTaskSchema),
  },
})

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

export const agentRunStatusSchema = z.enum([
  'PENDING_APPROVAL',
  'RUNNING',
  'PROPOSED',
  'APPLIED',
  'FAILED',
  'CANCELLED',
  'BUDGET_EXCEEDED',
  'REJECTED',
  /**
   * O Studio nao conseguiu PROVAR que o trabalhador externo terminou. Nao e
   * falha nem sucesso: e ausencia de prova, e por isso e bloqueante.
   */
  'UNKNOWN',
])

export const agentRunSchema = z.object({
  run_id: z.string().min(1),
  org_id: z.string().min(1),
  tenant_id: z.string().min(1),
  workspace_id: z.string().min(1),
  parent_session_id: z.string().min(1),
  coordinator_session_id: z.string().min(1),
  provider: z.enum(['spawn-in-process', 'codex', 'claude-code']),
  worktree_path: z.string().min(1),
  repository_path: z.string().min(1),
  base_commit: z.string().min(7),
  status: agentRunStatusSchema,
  changed_files: z.array(z.string()),
  diff_bytes: z.number().int().nonnegative(),
  diff_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  main_changed_during_run: z.boolean(),
  approved_by: z.string().min(1),
  approved_at: z.iso.datetime(),
  diagnostic: z.string().nullable(),
  /**
   * Tokens consumidos, do jeito que o PROVEDOR relatou. OPCIONAL, e `null`
   * quando não houve como medir.
   *
   * Opcional de propósito, com a versão do domínio INTOCADA: subir a versão
   * faria `open()` falhar com `version-mismatch` para sempre em qualquer
   * instalação que já rodou, e não existe passo de migração neste seam. Uma
   * execução gravada antes deste campo continua legível e diz `undefined` -
   * que a tela mostra como "não medido", nunca como zero.
   *
   * `null`/ausente e `0` são coisas diferentes e a diferença é o requisito:
   * um `0` afirmaria que a execução não consumiu nada, e o teto por tokens
   * deixaria de estourar por falta de medição em vez de por estar dentro do
   * combinado.
   */
  tokens_used: z.number().int().nonnegative().nullable().optional(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
}).strict()

export const agentLeaseSchema = z.object({
  lease_id: z.string().min(1),
  run_id: z.string().min(1),
  org_id: z.string().min(1),
  tenant_id: z.string().min(1),
  workspace_id: z.string().min(1),
  repository_path: z.string().min(1),
  paths: z.array(z.string().min(1)).min(1),
  active: z.boolean(),
  created_at: z.iso.datetime(),
  released_at: z.iso.datetime().nullable(),
}).strict()

export type AgentRunRecord = z.infer<typeof agentRunSchema>
export type AgentLeaseRecord = z.infer<typeof agentLeaseSchema>

declare const agentRunKeyBrand: unique symbol
declare const agentLeaseKeyBrand: unique symbol
export type AgentRunKey = string & { readonly [agentRunKeyBrand]: true }
export type AgentLeaseKey = string & { readonly [agentLeaseKeyBrand]: true }

export const STUDIO_AGENT_RUNS_PHYSICAL_DOMAIN = 'studio_agent_runs'
export const STUDIO_AGENT_RUNS_LOGICAL_DOMAIN = 'studio.agent.runs'
export const STUDIO_AGENT_LEASES_PHYSICAL_DOMAIN = 'studio_agent_leases'
export const STUDIO_AGENT_LEASES_LOGICAL_DOMAIN = 'studio.agent.leases'

export const studioAgentRunsDomainSpec = defineDomain({
  // v3 acrescenta o estado UNKNOWN. Um leitor preso a v2 recusaria a linha em
  // vez de le-la errado, que e o comportamento certo para um estado bloqueante.
  name: STUDIO_AGENT_RUNS_PHYSICAL_DOMAIN,
  version: 3,
  tables: { runs: domainTable<AgentRunKey, AgentRunRecord>(agentRunSchema) },
})

export const studioAgentLeasesDomainSpec = defineDomain({
  name: STUDIO_AGENT_LEASES_PHYSICAL_DOMAIN,
  version: 1,
  tables: { leases: domainTable<AgentLeaseKey, AgentLeaseRecord>(agentLeaseSchema) },
})

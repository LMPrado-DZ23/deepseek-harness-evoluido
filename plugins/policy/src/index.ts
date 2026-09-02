import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

export const name = 'dz23-studio-policy'
export const inject = ['tools', 'storageDomain']

export const policyTierSchema = z.enum(['T0', 'T1', 'T2', 'T3'])
export type PolicyTier = z.infer<typeof policyTierSchema>

export const policySourceSchema = z.object({
  kind: z.enum(['studio', 'harness', 'plugin', 'mcp']),
  external: z.boolean().default(false),
  signed: z.boolean().optional(),
  stableChannel: z.boolean().default(true),
}).strict()

export const toolPolicyRuleSchema = z.object({
  source: policySourceSchema,
  inferredTier: z.unknown().optional(),
  manifestTier: z.unknown().optional(),
  policyTier: z.unknown().optional(),
  allowManifestDowngrade: z.boolean().default(false),
  blocked: z.boolean().default(false),
  sandboxMode: z.string().optional(),
}).strict()

export type ToolPolicyRule = z.input<typeof toolPolicyRuleSchema>
type ParsedToolPolicyRule = z.output<typeof toolPolicyRuleSchema>

export const policyDecisionSchema = z.object({
  toolName: z.string().min(1),
  effectiveTier: policyTierSchema,
  kind: z.enum(['allow', 'ask', 'deny']),
  reason: z.string().min(1),
  ruleSource: z.enum(['catalog', 'safe-default', 'invalid-rule']),
}).strict()

export type PolicyDecision = z.infer<typeof policyDecisionSchema>

export const policyDecisionEventSchema = policyDecisionSchema.extend({
  callId: z.string().min(1),
}).strict()

export type PolicyDecisionEvent = z.infer<typeof policyDecisionEventSchema>

export const policyAuditRecordSchema = z.object({
  audit_id: z.string().min(1),
  session_id: z.string().min(1),
  org_id: z.string().min(1),
  tenant_id: z.string().min(1),
  created_at: z.iso.datetime(),
  tool_name: z.string().min(1),
  call_id: z.string().min(1),
  effective_tier: policyTierSchema,
  decision: z.enum(['allow', 'ask', 'deny']),
  reason: z.string().min(1),
  rule_source: z.enum(['catalog', 'safe-default', 'invalid-rule']),
}).strict()

export type PolicyAuditRecord = z.infer<typeof policyAuditRecordSchema>

export interface StudioPolicyRuntime {
  auditRecords(): readonly PolicyAuditRecord[]
}

declare const policyAuditKeyBrand: unique symbol
export type PolicyAuditKey = string & { readonly [policyAuditKeyBrand]: true }

export const STUDIO_POLICY_AUDIT_PHYSICAL_DOMAIN = 'studio_policy_audit'
export const STUDIO_POLICY_AUDIT_LOGICAL_DOMAIN = 'studio.policy.audit'

export const studioPolicyAuditDomainSpec = defineDomain({
  name: STUDIO_POLICY_AUDIT_PHYSICAL_DOMAIN,
  version: 1,
  tables: {
    decisions: domainTable<PolicyAuditKey, PolicyAuditRecord>(policyAuditRecordSchema),
  },
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    studioPolicy: StudioPolicyRuntime
  }

  interface Events {
    'studio-policy/decision'(event: PolicyDecisionEvent): void
  }
}

const TIER_RANK: Readonly<Record<PolicyTier, number>> = {
  T0: 0,
  T1: 1,
  T2: 2,
  T3: 3,
}

const TIER_BY_RANK = ['T0', 'T1', 'T2', 'T3'] as const

function validTier(value: unknown): PolicyTier | undefined {
  const parsed = policyTierSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

function mostRestrictive(tiers: readonly PolicyTier[]): PolicyTier {
  return TIER_BY_RANK[Math.max(...tiers.map(tier => TIER_RANK[tier]))]!
}

function declaredTier(value: unknown): PolicyTier {
  return validTier(value) ?? 'T2'
}

function resolveTier(rule: ParsedToolPolicyRule): PolicyTier {
  const inferred = validTier(rule.inferredTier)
  const manifest = validTier(rule.manifestTier)
  const policy = validTier(rule.policyTier)
  const present = [rule.inferredTier, rule.manifestTier, rule.policyTier]
  const hasInvalid = present.some(value => value !== undefined && validTier(value) === undefined)

  let effective: PolicyTier
  if (inferred !== undefined
    && manifest !== undefined
    && policy !== undefined
    && rule.allowManifestDowngrade
    && TIER_RANK[manifest] < TIER_RANK[inferred]
    && TIER_RANK[policy] < TIER_RANK[inferred]) {
    effective = mostRestrictive([manifest, policy])
  } else {
    const declared = [inferred, manifest, policy].filter((tier): tier is PolicyTier => tier !== undefined)
    effective = declared.length === 0 ? 'T2' : mostRestrictive(declared)
  }

  if (hasInvalid) effective = mostRestrictive([effective, declaredTier(undefined)])
  if (rule.source.kind === 'mcp' && rule.source.external) {
    effective = mostRestrictive([effective, 'T1'])
  }
  if (rule.sandboxMode === 'danger-full-access') effective = 'T3'
  return effective
}

function decisionForTier(toolName: string, effectiveTier: PolicyTier, strongIdentityVerified: boolean): PolicyDecision {
  if (effectiveTier === 'T0') {
    return { toolName, effectiveTier, kind: 'allow', reason: 'Leitura segura autorizada automaticamente.', ruleSource: 'catalog' }
  }
  if (effectiveTier === 'T1') {
    return { toolName, effectiveTier, kind: 'allow', reason: 'Alteração reversível autorizada e registrada.', ruleSource: 'catalog' }
  }
  if (effectiveTier === 'T2') {
    return { toolName, effectiveTier, kind: 'ask', reason: 'Confirmação da pessoa necessária antes de continuar.', ruleSource: 'catalog' }
  }
  if (!strongIdentityVerified) {
    return {
      toolName,
      effectiveTier,
      kind: 'deny',
      reason: 'Ação sensível bloqueada até uma confirmação forte de identidade estar ativa.',
      ruleSource: 'catalog',
    }
  }
  return {
    toolName,
    effectiveTier,
    kind: 'ask',
    reason: 'Confirmação reforçada necessária antes da ação sensível.',
    ruleSource: 'catalog',
  }
}

export interface PolicyEvaluationContext {
  readonly strongIdentityVerified?: boolean
}

export interface StudioPolicyOptions {
  readonly rules?: Readonly<Record<string, ToolPolicyRule>>
}

export class StudioPolicyEngine {
  readonly #rules: Readonly<Record<string, ToolPolicyRule>>

  constructor(options: StudioPolicyOptions = {}) {
    this.#rules = options.rules ?? {}
  }

  evaluate(toolName: string, context: PolicyEvaluationContext = {}): PolicyDecision {
    if (toolName.trim().length === 0) {
      return {
        toolName: '<invalid>',
        effectiveTier: 'T2',
        kind: 'deny',
        reason: 'Ferramenta sem identificação foi bloqueada por segurança.',
        ruleSource: 'invalid-rule',
      }
    }

    const rawRule = this.#rules[toolName]
    if (rawRule === undefined) {
      return {
        toolName,
        effectiveTier: 'T2',
        kind: 'ask',
        reason: 'Ferramenta ainda não classificada: confirmação obrigatória.',
        ruleSource: 'safe-default',
      }
    }

    const parsed = toolPolicyRuleSchema.safeParse(rawRule)
    if (!parsed.success) {
      return {
        toolName,
        effectiveTier: 'T2',
        kind: 'deny',
        reason: 'Regra de segurança inválida: execução bloqueada.',
        ruleSource: 'invalid-rule',
      }
    }

    const rule = parsed.data
    const effectiveTier = resolveTier(rule)
    if (rule.blocked) {
      return { toolName, effectiveTier, kind: 'deny', reason: 'Ação bloqueada pela política do DZ23 STUDIO.', ruleSource: 'catalog' }
    }
    if (rule.source.kind === 'plugin' && rule.source.stableChannel && rule.source.signed !== true) {
      return { toolName, effectiveTier, kind: 'deny', reason: 'Plugin não assinado é bloqueado no canal estável.', ruleSource: 'catalog' }
    }
    return decisionForTier(toolName, effectiveTier, context.strongIdentityVerified === true)
  }
}

export interface PolicyPluginConfig extends StudioPolicyOptions {
  readonly strongIdentityVerified?: (execution: ToolExecution) => boolean
  readonly resolveScope?: (execution: ToolExecution) => { readonly orgId: string; readonly tenantId: string }
  readonly createAuditId?: () => string
  readonly now?: () => Date
}

function toPreToolDecision(decision: PolicyDecision): PreToolDecision {
  if (decision.kind === 'allow') return { kind: 'allow' }
  if (decision.kind === 'ask') return { kind: 'ask', reason: decision.reason }
  return { kind: 'deny', reason: decision.reason }
}

/** Mounts the policy at the authoritative host-side pre-execution seam. */
export async function apply(ctx: Context, config: PolicyPluginConfig = {}): Promise<void> {
  const engine = new StudioPolicyEngine(config)
  const domain: Domain<typeof studioPolicyAuditDomainSpec> = await ctx.storageDomain.open(studioPolicyAuditDomainSpec)
  ctx.effect(() => () => domain.close(), 'dz23-studio-policy.domainClose')
  const decisions = domain.table('decisions')
  ctx.provide('studioPolicy', {
    auditRecords: () => [...decisions.entries()].map(([, record]) => record),
  })
  ctx.on('tools/pre-execute', async (execution, next): Promise<PreToolDecision> => {
    let decision = execution.agent === undefined
      ? {
          toolName: execution.name,
          effectiveTier: 'T2' as const,
          kind: 'deny' as const,
          reason: 'Execução sem sessão auditável foi bloqueada.',
          ruleSource: 'safe-default' as const,
        }
      : engine.evaluate(execution.name, {
          strongIdentityVerified: config.strongIdentityVerified?.(execution) === true,
        })

    if (decision.kind === 'allow') {
      const downstream = await next()
      if (downstream.kind !== 'allow') {
        decision = { ...decision, kind: downstream.kind, reason: downstream.reason ?? decision.reason }
      }
    }

    let event = policyDecisionEventSchema.parse({
      ...decision,
      callId: String(execution.callId),
    })
    try {
      const scope = config.resolveScope?.(execution) ?? { orgId: 'org_local', tenantId: 'tenant_local' }
      const auditId = config.createAuditId?.() ?? randomUUID()
      const record = policyAuditRecordSchema.parse({
        audit_id: auditId,
        session_id: execution.agent === undefined ? 'agentless' : String(execution.agent.session.id),
        org_id: scope.orgId,
        tenant_id: scope.tenantId,
        created_at: (config.now?.() ?? new Date()).toISOString(),
        tool_name: event.toolName,
        call_id: event.callId,
        effective_tier: event.effectiveTier,
        decision: event.kind,
        reason: event.reason,
        rule_source: event.ruleSource,
      })
      await decisions.put(auditId as PolicyAuditKey, record)
    } catch {
      decision = {
        ...decision,
        kind: 'deny',
        reason: 'Não foi possível registrar a auditoria; a ação foi bloqueada.',
      }
      event = policyDecisionEventSchema.parse({ ...decision, callId: String(execution.callId) })
    }
    ctx.emit('studio-policy/decision', event)
    return toPreToolDecision(decision)
  })
}

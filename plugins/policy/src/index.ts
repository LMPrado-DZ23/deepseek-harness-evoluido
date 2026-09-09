import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  roleAllows,
  studioPermissionSchema,
  studioRoleSchema,
  type StudioPermission,
  type StudioRole,
} from './rbac.js'
import { t } from './i18n.js'

export * from './rbac.js'

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
  requiredPermission: studioPermissionSchema.optional(),
  scope: z.enum(['none', 'org', 'workspace', 'project']).default('none'),
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
  /**
   * Quem agiu. A trilha de politica nao gravava isto, entao a auditoria dizia
   * o QUE foi decidido sem dizer para QUEM.
   */
  user_id: z.string().min(1).optional(),
  /**
   * Encadeamento. `seq` e a posicao, `previous_sha256` e o selo da entrada
   * anterior e `entry_sha256` e o selo desta. Sem eles, a trilha era um KV
   * comum: apagar ou reescrever uma linha nao deixava marca nenhuma.
   *
   * Sao OPCIONAIS de proposito. Torna-los obrigatorios exigiria subir a versao
   * do dominio, e `open()` falha com `version-mismatch` em qualquer instalacao
   * que ja rodou - nao existe passo de migracao. Registro antigo, sem selo,
   * e reportado como NAO ENCADEADO, que e a verdade sobre ele.
   */
  seq: z.number().int().nonnegative().optional(),
  previous_sha256: z.string().length(64).optional(),
  entry_sha256: z.string().length(64).optional(),
}).strict()

export type PolicyAuditRecord = z.infer<typeof policyAuditRecordSchema>

/** Primeira entrada da corrente: nao ha anterior, e o zero diz isso. */
export const POLICY_AUDIT_CHAIN_ROOT = '0'.repeat(64)

/**
 * O selo de uma entrada: SHA-256 do conteudo canonico dela mais o selo da
 * anterior. Trocar qualquer campo, ou reordenar a trilha, muda o selo.
 * @param record - a entrada, com ou sem `entry_sha256`.
 * @returns o selo em hexadecimal.
 */
export function policyAuditEntryHash(record: Omit<PolicyAuditRecord, 'entry_sha256'>): string {
  // Chaves ordenadas: a serializacao nao pode depender da ordem em que os
  // campos foram escritos, senao o mesmo conteudo daria selos diferentes.
  const canonical = JSON.stringify(Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined).sort(([left], [right]) => left.localeCompare(right)),
  ))
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

export type PolicyAuditChainVerdict =
  | { readonly kind: 'intact'; readonly entries: number; readonly head: string }
  | { readonly kind: 'unchained'; readonly entries: number; readonly firstUnchainedId: string }
  | { readonly kind: 'broken'; readonly entries: number; readonly brokenAuditId: string; readonly detail: 'seal' | 'link' | 'sequence' }

/**
 * Confere a corrente inteira.
 *
 * `broken` distingue tres coisas diferentes: o selo nao bate com o conteudo
 * (alguem reescreveu a linha), o elo nao aponta para a anterior (alguem
 * removeu ou reordenou), ou a posicao pulou (alguem apagou do meio).
 * @param records - as entradas, em qualquer ordem.
 * @returns o veredito.
 */
export function verifyPolicyAuditChain(records: readonly PolicyAuditRecord[]): PolicyAuditChainVerdict {
  const chained = records.filter(record => record.entry_sha256 !== undefined)
  const unchained = records.find(record => record.entry_sha256 === undefined)
  if (unchained !== undefined) {
    return { kind: 'unchained', entries: records.length, firstUnchainedId: unchained.audit_id }
  }
  const ordered = [...chained].sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0))
  let previous = POLICY_AUDIT_CHAIN_ROOT
  for (const [index, record] of ordered.entries()) {
    if (record.seq !== index) {
      return { kind: 'broken', entries: ordered.length, brokenAuditId: record.audit_id, detail: 'sequence' }
    }
    if (record.previous_sha256 !== previous) {
      return { kind: 'broken', entries: ordered.length, brokenAuditId: record.audit_id, detail: 'link' }
    }
    const { entry_sha256: seal, ...body } = record
    if (policyAuditEntryHash(body) !== seal) {
      return { kind: 'broken', entries: ordered.length, brokenAuditId: record.audit_id, detail: 'seal' }
    }
    previous = seal
  }
  return { kind: 'intact', entries: ordered.length, head: previous }
}

export interface StudioPolicyRuntime {
  auditRecords(): readonly PolicyAuditRecord[]
  /** Confere a corrente da trilha de politica sem sair do processo. */
  verifyAuditChain(): PolicyAuditChainVerdict
  setIdentityResolver(resolver: (execution: ToolExecution) => PolicyIdentityState): () => void
  setAuthorizationResolver(resolver: (execution: ToolExecution) => PolicyAuthorizationState | undefined): () => void
  setDelegationGrantResolver(resolver: (execution: ToolExecution) => PolicyDelegationGrant | undefined): () => void
}

export interface PolicyIdentityState {
  readonly authenticated: boolean
  readonly strongIdentityVerified: boolean
}

export interface PolicyAuthorizationState {
  readonly userId: string
  readonly orgId: string
  readonly tenantId: string
  readonly role: StudioRole
}

export interface PolicyDelegationGrant {
  readonly approvedTier: Extract<PolicyTier, 'T2' | 'T3'>
  readonly reason: string
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
    && inferred !== 'T3'
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
  if (effective === 'T1'
    && (rule.source.external || (rule.sandboxMode !== 'read-only' && rule.sandboxMode !== 'workspace-write'))) {
    effective = 'T2'
  }
  return effective
}

function decisionForTier(toolName: string, effectiveTier: PolicyTier, strongIdentityVerified: boolean): PolicyDecision {
  if (effectiveTier === 'T0') {
    return { toolName, effectiveTier, kind: 'allow', reason: t('audit.safeReadAutoAuthorized'), ruleSource: 'catalog' }
  }
  if (effectiveTier === 'T1') {
    return { toolName, effectiveTier, kind: 'allow', reason: t('policy.alteracaoReversivelAutorizadaRegistrada'), ruleSource: 'catalog' }
  }
  if (effectiveTier === 'T2') {
    return { toolName, effectiveTier, kind: 'ask', reason: t('policy.confirmacaoPessoaNecessariaAntes'), ruleSource: 'catalog' }
  }
  if (!strongIdentityVerified) {
    return {
      toolName,
      effectiveTier,
      kind: 'deny',
      reason: t('policy.acaoSensivelBloqueadaAte'),
      ruleSource: 'catalog',
    }
  }
  return {
    toolName,
    effectiveTier,
    kind: 'ask',
    reason: t('policy.confirmacaoReforcadaNecessariaAntes'),
    ruleSource: 'catalog',
  }
}

export interface PolicyEvaluationContext {
  readonly strongIdentityVerified?: boolean
  readonly authorization?: PolicyAuthorizationState
}

export interface StudioPolicyOptions {
  readonly rules?: Readonly<Record<string, ToolPolicyRule>>
  readonly requireAuthorizationDeclarations?: boolean
}

export class StudioPolicyEngine {
  readonly #rules: Readonly<Record<string, ToolPolicyRule>>
  readonly #requireAuthorizationDeclarations: boolean

  constructor(options: StudioPolicyOptions = {}) {
    this.#rules = options.rules ?? {}
    this.#requireAuthorizationDeclarations = options.requireAuthorizationDeclarations ?? false
  }

  evaluate(toolName: string, context: PolicyEvaluationContext = {}): PolicyDecision {
    if (toolName.trim().length === 0) {
      return {
        toolName: '<invalid>',
        effectiveTier: 'T2',
        kind: 'deny',
        reason: t('policy.ferramentaIdentificacaoFoiBloqueada'),
        ruleSource: 'invalid-rule',
      }
    }

    const rawRule = this.#rules[toolName]
    if (rawRule === undefined) {
      return {
        toolName,
        effectiveTier: 'T2',
        kind: this.#requireAuthorizationDeclarations ? 'deny' : 'ask',
        reason: this.#requireAuthorizationDeclarations
          ? t('policy.ferramentaDeclaracaoPermissaoFoi')
          : t('policy.ferramentaAindaNaoClassificada'),
        ruleSource: 'safe-default',
      }
    }

    const parsed = toolPolicyRuleSchema.safeParse(rawRule)
    if (!parsed.success) {
      return {
        toolName,
        effectiveTier: 'T2',
        kind: 'deny',
        reason: t('policy.regraSegurancaInvalidaExecucao'),
        ruleSource: 'invalid-rule',
      }
    }

    const rule = parsed.data
    const effectiveTier = resolveTier(rule)
    if (this.#requireAuthorizationDeclarations && rule.requiredPermission === undefined) {
      return { toolName, effectiveTier, kind: 'deny', reason: t('policy.ferramentaPermissaoDeclaradaFoi'), ruleSource: 'invalid-rule' }
    }
    if (rule.requiredPermission !== undefined) {
      const authorization = context.authorization
      if (authorization === undefined) {
        return { toolName, effectiveTier, kind: 'deny', reason: t('policy.nenhumVinculoAtivoAutoriza'), ruleSource: 'catalog' }
      }
      if (!roleAllows(authorization.role, rule.requiredPermission)) {
        return { toolName, effectiveTier, kind: 'deny', reason: t('policy.seuPapelNesteEspaco'), ruleSource: 'catalog' }
      }
    }
    if (rule.blocked) {
      return { toolName, effectiveTier, kind: 'deny', reason: t('policy.acaoBloqueadaPelaPolitica'), ruleSource: 'catalog' }
    }
    if (rule.source.kind === 'plugin' && rule.source.stableChannel && rule.source.signed !== true) {
      return { toolName, effectiveTier, kind: 'deny', reason: t('policy.pluginNaoAssinadoBloqueado'), ruleSource: 'catalog' }
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

function requestedScope(execution: ToolExecution): { orgId?: string; tenantId?: string } {
  const args = execution.arguments
  if (typeof args !== 'object' || args === null) return {}
  const values = args as Readonly<Record<string, unknown>>
  return {
    ...(typeof values.org_id === 'string' ? { orgId: values.org_id } : {}),
    ...(typeof values.tenant_id === 'string' ? { tenantId: values.tenant_id } : {}),
  }
}

function toPreToolDecision(decision: PolicyDecision): PreToolDecision {
  if (decision.kind === 'allow') return { kind: 'allow' }
  if (decision.kind === 'ask') return { kind: 'ask', reason: decision.reason }
  return { kind: 'deny', reason: decision.reason }
}

/** Mounts the policy at the authoritative host-side pre-execution seam. */
export async function apply(ctx: Context, config: PolicyPluginConfig = {}): Promise<void> {
  const engine = new StudioPolicyEngine(config)
  let identityResolver = (execution: ToolExecution): PolicyIdentityState => ({
    authenticated: true,
    strongIdentityVerified: config.strongIdentityVerified?.(execution) === true,
  })
  let authorizationResolver = (_execution: ToolExecution): PolicyAuthorizationState | undefined => undefined
  let delegationGrantResolver = (_execution: ToolExecution): PolicyDelegationGrant | undefined => undefined
  const domain: Domain<typeof studioPolicyAuditDomainSpec> = await ctx.storageDomain.open(studioPolicyAuditDomainSpec)
  ctx.effect(() => () => domain.close(), 'dz23-studio-policy.domainClose')
  const decisions = domain.table('decisions')
  // A cabeca da corrente vem do que ja esta gravado. Comecar do zero a cada
  // inicio faria a trilha antiga parecer adulterada; retomar de onde parou e o
  // que mantem a corrente contínua entre reinicios.
  // Falha fechado: um plugin de politica que nao consegue LER a propria trilha
  // nao pode continuar a corrente. Comecar do zero por cima do que ja existe
  // faria a verificacao acusar adulteracao onde nao houve, e e a mesma postura
  // que a gravacao ja tem - se a auditoria nao pode ser registrada, a acao e
  // bloqueada.
  let stored: readonly PolicyAuditRecord[]
  try {
    stored = [...decisions.entries()].map(([, record]) => record).filter(record => record.entry_sha256 !== undefined)
  } catch (cause) {
    throw new Error('POLICY_AUDIT_TRAIL_UNREADABLE', { cause })
  }
  let head = stored.length === 0
    ? { seq: 0, hash: POLICY_AUDIT_CHAIN_ROOT }
    : stored.reduce((latest, record) => (record.seq ?? 0) >= latest.seq ? { seq: (record.seq ?? 0) + 1, hash: record.entry_sha256! } : latest, { seq: 0, hash: POLICY_AUDIT_CHAIN_ROOT })
  // Uma fila: duas decisoes simultaneas nao podem pegar a mesma cabeca e gravar
  // dois elos apontando para o mesmo anterior - isso quebraria a corrente sem
  // ninguem ter adulterado nada.
  let chainQueue: Promise<unknown> = Promise.resolve()
  const appendAudit = (body: Omit<PolicyAuditRecord, 'seq' | 'previous_sha256' | 'entry_sha256'>): Promise<void> => {
    const run = chainQueue.then(async () => {
      const withLink = { ...body, seq: head.seq, previous_sha256: head.hash }
      const record = policyAuditRecordSchema.parse({ ...withLink, entry_sha256: policyAuditEntryHash(withLink) })
      await decisions.put(record.audit_id as PolicyAuditKey, record)
      head = { seq: head.seq + 1, hash: record.entry_sha256! }
    })
    // A fila nao pode morrer numa falha: a proxima decisao ainda precisa ser
    // registrada, e quem falhou ja e bloqueado por quem chamou.
    chainQueue = run.catch(() => undefined)
    return run
  }
  ctx.provide('studioPolicy', {
    auditRecords: () => [...decisions.entries()].map(([, record]) => record),
    verifyAuditChain: () => verifyPolicyAuditChain([...decisions.entries()].map(([, record]) => record)),
    setIdentityResolver: (resolver) => {
      const previous = identityResolver
      identityResolver = resolver
      return () => { identityResolver = previous }
    },
    setAuthorizationResolver: (resolver) => {
      const previous = authorizationResolver
      authorizationResolver = resolver
      return () => { authorizationResolver = previous }
    },
    setDelegationGrantResolver: (resolver) => {
      const previous = delegationGrantResolver
      delegationGrantResolver = resolver
      return () => { delegationGrantResolver = previous }
    },
  })
  ctx.on('tools/pre-execute', async (execution, next): Promise<PreToolDecision> => {
    const identity = execution.agent === undefined
      ? { authenticated: false, strongIdentityVerified: false }
      : identityResolver(execution)
    const authorization = execution.agent === undefined ? undefined : authorizationResolver(execution)
    const requested = requestedScope(execution)
    let decision = execution.agent === undefined
      ? {
          toolName: execution.name,
          effectiveTier: 'T2' as const,
          kind: 'deny' as const,
          reason: t('policy.execucaoSessaoAuditavelFoi'),
          ruleSource: 'safe-default' as const,
        }
        : !identity.authenticated
            ? {
                toolName: execution.name,
                effectiveTier: 'T2' as const,
                kind: 'deny' as const,
                reason: t('policy.sessaoIdentidadeAusenteExpirada'),
                ruleSource: 'safe-default' as const,
              }
            : engine.evaluate(execution.name, {
                strongIdentityVerified: identity.strongIdentityVerified,
                ...(authorization === undefined ? {} : { authorization }),
              })

    if (decision.kind !== 'deny' && authorization !== undefined
      && ((requested.orgId !== undefined && requested.orgId !== authorization.orgId)
        || (requested.tenantId !== undefined && requested.tenantId !== authorization.tenantId))) {
      decision = {
        ...decision,
        kind: 'deny',
        reason: t('policy.acaoTentouAcessarOutra'),
      }
    }

    if (decision.kind === 'ask') {
      const grant = delegationGrantResolver(execution)
      if (grant !== undefined && TIER_RANK[grant.approvedTier] >= TIER_RANK[decision.effectiveTier]) {
        decision = { ...decision, kind: 'allow', reason: grant.reason }
      }
    }

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
      const scope = authorization ?? config.resolveScope?.(execution) ?? { orgId: 'org_local', tenantId: 'tenant_local' }
      const auditId = config.createAuditId?.() ?? randomUUID()
      await appendAudit({
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
        ...(authorization === undefined ? {} : { user_id: authorization.userId }),
      })
    } catch {
      decision = {
        ...decision,
        kind: 'deny',
        reason: t('policy.naoFoiPossivelRegistrar'),
      }
      event = policyDecisionEventSchema.parse({ ...decision, callId: String(execution.callId) })
    }
    ctx.emit('studio-policy/decision', event)
    return toPreToolDecision(decision)
  })
}

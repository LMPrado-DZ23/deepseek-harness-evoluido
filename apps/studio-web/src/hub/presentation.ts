/**
 * Pure presentation helpers of the Integration Hub panel: which screen a path
 * opens, how server facts become plain-language labels, how bytes and dates
 * are shown. No DOM, no fetch — unit tested on their own.
 */
import t from '../i18n/hub.pt-BR.json'

export const HUB_PATH = '/studio/hub'

export type IntegrationKind = 'smtp' | 'mcp' | 'skill' | 'webhook'
export type PolicyTier = 'T0' | 'T1' | 'T2' | 'T3'
export type Verification = 'verified' | 'unverified' | 'invalid'
export type HubOutcome = 'success' | 'failure' | 'not-executed'
export type HubAction = 'smtp.configured' | 'smtp.tested' | 'integration.registered' | 'integration.enabled' | 'integration.disabled' | 'export.created' | 'approval.recorded' | 'approval.requested' | 'export.downloadRefused'
/** The id of an approval the server issued for exactly this action; the client never asserts a tier. */
export type Approval = { approval_id: string }

/** `/studio/hub` and `/studio/hub/` open the Hub; everything else stays with the main application. */
export function isHubPath(pathname: string): boolean {
  return pathname === HUB_PATH || pathname === `${HUB_PATH}/`
}

export function kindLabel(kind: string): string {
  return (t.integrations.kind as Record<string, string>)[kind] ?? kind
}

export function tierLabel(tier: string): string {
  const known = (t.integrations.tier as Record<string, string>)[tier]
  return known === undefined ? tier : `${tier} — ${known}`
}

export function verificationLabel(verification: Verification): string {
  return verification === 'verified' ? t.integrations.verified : t.integrations.unverified
}

/** The server decides (signature + channel); the panel only mirrors `can_enable` and explains a refusal in words. */
export function enableExplanation(integration: { verification: Verification; enabled: boolean; can_enable: boolean }): string | null {
  if (integration.enabled || integration.can_enable) return null
  return t.integrations.cannotEnable
}

/** What the person is agreeing to, in plain words, for the tier the server asked for. */
export function approvalPrompt(tier: PolicyTier): string {
  return tier === 'T3' ? t.confirm.T3 : t.confirm.T2
}

/** Note under the "enable" button when the server says this one needs a confirmation. */
export function approvalNote(integration: { requires_approval_tier?: PolicyTier | null }): string | null {
  const tier = integration.requires_approval_tier ?? null
  return tier === null ? null : fill(t.integrations.needsApproval, { tier: tierLabel(tier) })
}

export type ApprovalAction = 'integration.enabled' | 'integration.removed' | 'smtp.configured' | 'smtp.tested'
/** What the server answers when it issues a decision. */
export type IssuedApproval = { approval_id: string; tier: PolicyTier }
export type GuardedOutcome = { kind: 'done' } | { kind: 'tier-changed'; step: ConfirmStepModel }

/**
 * One action waiting for the person's word. The ticket is asked for INSIDE
 * `confirm()` — never while the box is being shown — because asking earlier
 * meant that cancelling had already left a decision and an audit event on the
 * server for something the person refused.
 */
export type ConfirmStepModel = {
  readonly tier: PolicyTier
  readonly what: string
  confirm(): Promise<GuardedOutcome>
}

export function confirmStep(input: {
  readonly tier: PolicyTier
  readonly action: ApprovalAction
  readonly subjectId: string
  /** The alias or the address this decision is about; the server keeps only a digest of it. */
  readonly payload?: string
  describe(tier: PolicyTier): string
  requestApproval(action: ApprovalAction, subjectId: string, payload?: string): Promise<IssuedApproval>
  run(approval: Approval): Promise<void>
}): ConfirmStepModel {
  return {
    tier: input.tier,
    what: input.describe(input.tier),
    async confirm() {
      const ticket = await input.requestApproval(input.action, input.subjectId, input.payload)
      // The server may now demand MORE than the box said (the integration was re-registered while
      // the person read it). Nothing is done with a decision the person was not shown: the step is
      // rebuilt at the real level and asked again.
      if (ticket.tier !== input.tier) return { kind: 'tier-changed', step: confirmStep({ ...input, tier: ticket.tier }) }
      await input.run({ approval_id: ticket.approval_id })
      return { kind: 'done' }
    },
  }
}

export function actionLabel(action: string): string {
  return (t.events.action as Record<string, string>)[action] ?? action
}

export function outcomeLabel(outcome: string): string {
  return (t.events.outcome as Record<string, string>)[outcome] ?? outcome
}

export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return '0 B'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

export function formatDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
}

// ---- catálogo pesquisável e progressivo (X-01) ------------------------------

/** Como o catálogo é filtrado na tela. `all` é a ausência de filtro, e é o padrão. */
export type KindFilter = IntegrationKind | 'all'
export type StatusFilter = 'all' | 'enabled' | 'disabled'

/** A pergunta que a tela faz ao servidor. Nada disto é aplicado aqui: quem busca, filtra e corta é o servidor. */
export type CatalogQuery = {
  readonly search?: string
  readonly kind?: KindFilter
  readonly status?: StatusFilter
  readonly limit?: number
  readonly cursor?: string
}

/** Quantas integrações a tela pede por vez. O resto vem quando a pessoa pede mais. */
export const CATALOG_PAGE_SIZE = 20

/**
 * Qual vazio é este.
 *
 * `catalog`: a pessoa ainda não registrou nenhuma integração.
 * `search`: existem integrações, mas nenhuma responde ao que ela pediu.
 * `none`: não está vazio.
 *
 * Uma lista vazia sozinha não distingue as duas primeiras, e a diferença é o que
 * diz à pessoa se ela deve registrar algo ou apenas corrigir a busca.
 */
export type CatalogEmptyKind = 'none' | 'catalog' | 'search'

export function catalogEmptyKind(page: { readonly total: number; readonly matched: number }): CatalogEmptyKind {
  if (page.matched > 0) return 'none'
  return page.total === 0 ? 'catalog' : 'search'
}

/**
 * O que a tela escreve no lugar da lista, já com o termo que a pessoa digitou.
 * @param page - os dois totais que o servidor mandou.
 * @param search - o que foi buscado, para a frase citar de volta.
 * @returns a frase, ou `null` quando há resultados.
 */
export function catalogEmptyMessage(page: { readonly total: number; readonly matched: number }, search: string): string | null {
  const kind = catalogEmptyKind(page)
  if (kind === 'none') return null
  if (kind === 'catalog') return t.integrations.empty
  const term = search.trim()
  return term === '' ? t.integrations.noneMatchFilters : fill(t.integrations.noneFound, { search: term })
}

/** Quantas de quantas esta tela está mostrando; some quando não há nada a contar. */
export function catalogCount(shown: number, page: { readonly total: number; readonly matched: number }): string | null {
  if (page.matched === 0) return null
  return fill(t.integrations.showing, { shown: String(shown), matched: String(page.matched), total: String(page.total) })
}

// ---- saúde por integração (X-08) --------------------------------------------

export type IntegrationHealthState = 'OK' | 'DEGRADED' | 'DOWN' | 'NOT_EXECUTED'
export type IntegrationCostState = 'MEASURED' | 'PARTIAL' | 'UNKNOWN'

/** A saúde como o servidor a publica. Ele deriva tudo isto dos contadores que gravou. */
export type IntegrationHealth = {
  readonly state: IntegrationHealthState
  readonly calls: number
  readonly failures: number
  readonly timeouts: number
  readonly retries: number
  readonly average_latency_ms: number | null
  readonly last_call_at: string | null
  readonly last_failure: string | null
  readonly cost_state: IntegrationCostState
  readonly cost_usd: number
}

/** O estado de saúde em palavras. `NOT_EXECUTED` tem frase própria: não é "tudo bem", é "ninguém chamou". */
export function healthLabel(state: string): string {
  return (t.integrations.health as Record<string, string>)[state] ?? state
}

/**
 * O custo em palavras, e nunca um número sozinho.
 *
 * Sem preço conhecido a tela NÃO escreve "US$ 0,00": ela diz que o custo é
 * desconhecido. Um zero ali seria lido como "essa integração é de graça", que é
 * exatamente o que ninguém mediu.
 * @param health - a saúde publicada pelo servidor.
 * @returns a frase de custo.
 */
export function costLabel(health: Pick<IntegrationHealth, 'cost_state' | 'cost_usd'>): string {
  if (health.cost_state === 'UNKNOWN') return t.integrations.cost.unknown
  const value = formatUsd(health.cost_usd)
  return health.cost_state === 'PARTIAL'
    ? fill(t.integrations.cost.partial, { value })
    : fill(t.integrations.cost.measured, { value })
}

export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return formatUsd(0)
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'USD' })
}

/** Quantas chamadas e quantas falharam, para quem quer o número por trás do estado. */
export function healthCounts(health: Pick<IntegrationHealth, 'calls' | 'failures'>): string {
  return fill(t.integrations.callCounts, { calls: String(health.calls), failures: String(health.failures) })
}

/** Only verified prototypes can be exported; the option list says so instead of hiding the project. */
export function exportable(project: { state: string }): boolean {
  return project.state === 'VERIFIED_PROTOTYPE'
}

export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/gu, (_match, key: string) => values[key] ?? `{${key}}`)
}

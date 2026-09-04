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

export type ApprovalAction = 'integration.enabled' | 'smtp.configured' | 'smtp.tested'
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

/** Only verified prototypes can be exported; the option list says so instead of hiding the project. */
export function exportable(project: { state: string }): boolean {
  return project.state === 'VERIFIED_PROTOTYPE'
}

export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/gu, (_match, key: string) => values[key] ?? `{${key}}`)
}

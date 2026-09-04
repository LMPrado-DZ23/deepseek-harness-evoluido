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
export type HubAction = 'smtp.configured' | 'smtp.tested' | 'integration.registered' | 'integration.enabled' | 'integration.disabled' | 'export.created'

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

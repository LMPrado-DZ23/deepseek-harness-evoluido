/**
 * HTTP client of the Hub panel. Same rules as the main application client:
 * same-origin cookies, CSRF header on writes, JSON only. The service worker
 * answers `/api/` requests made offline with 503 `{error:"OFFLINE"}`; that
 * becomes a typed error so the panel can say "you are offline" in words.
 */
import type { HubAction, HubOutcome, IntegrationKind, PolicyTier, Verification } from './presentation'

export const HUB_API_PREFIX = '/api/studio/hub'
export const APPS_API_PREFIX = '/api/studio/apps'
const CSRF_COOKIE = 'dz23_studio_csrf'

export type Integration = {
  integration_id: string; kind: IntegrationKind; name: string; effective_tier: PolicyTier; verification: Verification
  enabled: boolean; secret_ref: string | null; updated_at: string
  /** Server decision (signature + release channel): the panel offers "enable" only when this is true. */
  can_enable: boolean
}
export type SmtpState = { configured: boolean; secret_ref: string | null; tier: PolicyTier }
export type SmtpTest = { result: 'SENT' | 'NOT_EXECUTED'; message: string }
export type ExportRecord = { export_id: string; project_id: string; run_id: string; file_name: string; sha256: string; size_bytes: number; entries: number; created_at: string }
export type HubEvent = { event_id: string; action: HubAction; outcome: HubOutcome; detail: string; created_at: string }
export type ProjectSummary = { project_id: string; name: string; state: string }

export class HubApiError extends Error {
  constructor(readonly status: number, message: string, readonly offline = false) { super(message) }
}

export interface HubTransport {
  fetch(input: string, init: RequestInit): Promise<Response>
  cookie(): string
}

const browserTransport: HubTransport = {
  fetch: (input, init) => fetch(input, init),
  cookie: () => (typeof document === 'undefined' ? '' : document.cookie),
}

export function csrfFromCookie(cookie: string): string {
  const row = cookie.split(';').map(value => value.trim()).find(value => value.startsWith(`${CSRF_COOKIE}=`))
  return row === undefined ? '' : decodeURIComponent(row.slice(row.indexOf('=') + 1))
}

export function createHubApi(transport: HubTransport = browserTransport) {
  async function call<T>(prefix: string, path: string, init: RequestInit = {}): Promise<T> {
    const write = init.method !== undefined && init.method !== 'GET'
    const headers: Record<string, string> = write ? { 'content-type': 'application/json', 'x-dz23-csrf': csrfFromCookie(transport.cookie()) } : {}
    const response = await transport.fetch(`${prefix}${path}`, { ...init, credentials: 'same-origin', headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } })
    let body: (T & { error?: string; offline?: boolean }) | undefined
    try { body = await response.json() as T & { error?: string; offline?: boolean } } catch { body = undefined }
    if (!response.ok) throw new HubApiError(response.status, body?.error ?? `HTTP ${response.status}`, body?.offline === true || body?.error === 'OFFLINE')
    return body as T
  }
  const hub = <T>(path: string, init?: RequestInit) => call<T>(HUB_API_PREFIX, path, init)
  return {
    smtp: () => hub<SmtpState>('/smtp'),
    configureSmtp: (secretRef: string) => hub<{ configured: true; secret_ref: string; tier: PolicyTier }>('/smtp', { method: 'POST', body: JSON.stringify({ secret_ref: secretRef }) }),
    testSmtp: (to: string) => hub<SmtpTest>('/smtp/test', { method: 'POST', body: JSON.stringify({ to }) }),
    integrations: () => hub<{ channel: 'stable' | 'dev'; integrations: Integration[] }>('/integrations'),
    register: (manifest: unknown) => hub<{ integration: Integration; reasons: string[] }>('/integrations', { method: 'POST', body: JSON.stringify(manifest) }),
    setEnabled: (integrationId: string, enabled: boolean) => hub<{ integration: Integration }>(`/integrations/${encodeURIComponent(integrationId)}/enabled`, { method: 'POST', body: JSON.stringify({ enabled }) }).then(value => value.integration),
    exports: (projectId: string) => hub<{ exports: ExportRecord[] }>(`/projects/${encodeURIComponent(projectId)}/exports`).then(value => value.exports),
    createExport: (projectId: string) => hub<{ export: ExportRecord }>(`/projects/${encodeURIComponent(projectId)}/exports`, { method: 'POST', body: '{}' }).then(value => value.export),
    downloadHref: (projectId: string, exportId: string) => `${HUB_API_PREFIX}/projects/${encodeURIComponent(projectId)}/exports/${encodeURIComponent(exportId)}/download`,
    events: () => hub<{ events: HubEvent[] }>('/events').then(value => value.events),
    projects: () => call<{ projects: ProjectSummary[] }>(APPS_API_PREFIX, '/projects').then(value => value.projects),
  }
}

export type HubApi = ReturnType<typeof createHubApi>

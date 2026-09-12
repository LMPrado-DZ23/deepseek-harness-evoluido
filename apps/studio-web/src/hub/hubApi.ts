/**
 * HTTP client of the Hub panel. Same rules as the main application client:
 * same-origin cookies, CSRF header on writes, JSON only. The service worker
 * answers `/api/` requests made offline with 503 `{error:"OFFLINE"}`; that
 * becomes a typed error so the panel can say "you are offline" in words.
 */
import pwa from '../i18n/pwa.pt-BR.json'
import type { Approval, ApprovalAction, CatalogQuery, HubAction, HubOutcome, IntegrationHealth, IntegrationKind, PolicyTier, Verification } from './presentation'

export const HUB_API_PREFIX = '/api/studio/hub'
export const APPS_API_PREFIX = '/api/studio/apps'
const CSRF_COOKIE = 'dz23_studio_csrf'

export type Integration = {
  integration_id: string; kind: IntegrationKind; name: string; effective_tier: PolicyTier; verification: Verification
  enabled: boolean; secret_ref: string | null; updated_at: string
  /** Server decision (signature + release channel): the panel offers "enable" only when this is true. */
  can_enable: boolean
  /** Server decision (D16): the confirmation the person has to give before this can be turned on, or `null`. */
  requires_approval_tier: PolicyTier | null
  /**
   * Saúde desta integração, derivada pelo servidor dos contadores que ele
   * gravou. Pode não vir: um Studio mais antigo não a publica, e nesse caso a
   * tela não afirma nada em vez de inventar um estado.
   */
  health?: IntegrationHealth
  /**
   * JA HA texto de habilidade instalado?
   *
   * O texto em si NUNCA vem (OS-78): ele pode ter duzentos mil caracteres, e a
   * listagem so exige `workspace.read`. Este booleano e a unica coisa que a
   * tela precisa saber sobre ele — sem ele, ela ofereceria instalar de novo o
   * que ja esta la, e quem le nao teria como saber que nao precisa.
   *
   * OPCIONAL: um Studio mais antigo nao o publica, e nesse caso a tela diz que
   * nao sabe em vez de afirmar que nao ha.
   */
  skill_body_installed?: boolean
  /**
   * O manifesto assinado, como o servidor o guarda.
   *
   * A tela le dele UMA coisa: `skill.body_chars`, o tamanho EXATO que o
   * servidor vai exigir. Sem isso a pessoa descobriria o numero por tentativa e
   * erro, numa recusa escrita em linguagem de servidor.
   */
  manifest?: { readonly skill?: { readonly body_chars?: number } | undefined } | null
}

/**
 * Uma página do catálogo, como o SERVIDOR a devolve.
 *
 * `total` e `matched` chegam separados porque uma lista vazia sozinha não diz
 * se a pessoa procurou algo que não existe ou se ela ainda não registrou nada.
 */
export type IntegrationCatalog = {
  channel: 'stable' | 'dev'
  integrations: Integration[]
  next_cursor: string | null
  total: number
  matched: number
}
export type SmtpState = { configured: boolean; secret_ref: string | null; tier: PolicyTier }
/** What the server issued for one action: the panel shows what it says and, on confirmation, presents its id. */
export type ApprovalTicket = { approval_id: string; tier: PolicyTier; expires_at: string; requires_strong_identity: boolean }
export type { ApprovalAction } from './presentation'
export type SmtpTest = { result: 'SENT' | 'NOT_EXECUTED'; message: string }
/**
 * O desfecho de um teste de conexão (X-04).
 *
 * `NOT_APPLICABLE` NÃO é falha e não é sucesso: é "este tipo não tem com quem
 * conectar" (uma habilidade) ou "ainda não há teste para isto" (um webhook).
 * Sem esse terceiro estado a tela teria de escolher entre mentir e reprovar.
 */
export type IntegrationTestResult = { result: 'OK' | 'FAILED' | 'TIMEOUT' | 'NOT_EXECUTED' | 'NOT_APPLICABLE'; message: string }
/** O que voltou de uma remoção: o suficiente para a tela dizer o nome e a referência de segredo que deixou de ser usada. */
export type RemovedIntegration = { integration_id: string; name: string; secret_ref: string | null }
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
    if (!response.ok) {
      // The worker answers a request made without network with 503 OFFLINE, and one made with
      // network but no Studio with 503 SERVICE_UNREACHABLE. Each becomes its own sentence; a raw
      // code must never reach a person.
      const offline = body?.offline === true || body?.error === 'OFFLINE'
      const unreachable = body?.error === 'SERVICE_UNREACHABLE'
      if (offline) throw new HubApiError(response.status, pwa.offline.blockedAction, true)
      if (unreachable) throw new HubApiError(response.status, pwa.offline.serviceUnreachable, false)
      throw new HubApiError(response.status, body?.error ?? `HTTP ${response.status}`, false)
    }
    return body as T
  }
  const hub = <T>(path: string, init?: RequestInit) => call<T>(HUB_API_PREFIX, path, init)
  return {
    // `payload` is what the decision is ABOUT (the alias, the address). The server keeps a digest of
    // it in the ticket, so a confirmation given for one target cannot be spent on another.
    requestApproval: (action: ApprovalAction, subjectId: string, payload?: string) => hub<ApprovalTicket>('/approvals', { method: 'POST', body: JSON.stringify(payload === undefined ? { action, subject_id: subjectId } : { action, subject_id: subjectId, payload }) }),
    smtp: () => hub<SmtpState>('/smtp'),
    configureSmtp: (secretRef: string, approval?: Approval) => hub<{ configured: true; secret_ref: string; tier: PolicyTier }>('/smtp', { method: 'POST', body: JSON.stringify({ secret_ref: secretRef, approval }) }),
    testSmtp: (to: string, approval?: Approval) => hub<SmtpTest>('/smtp/test', { method: 'POST', body: JSON.stringify({ to, approval }) }),
    // A busca, o filtro e o corte acontecem no SERVIDOR: esta chamada pede uma
    // página. Receber tudo e filtrar na tela não é paginação, é fingir que é.
    integrations: (query: CatalogQuery = {}) => hub<IntegrationCatalog>(`/integrations${catalogSearch(query)}`),
    register: (manifest: unknown) => hub<{ integration: Integration; reasons: string[] }>('/integrations', { method: 'POST', body: JSON.stringify(manifest) }),
    setEnabled: (integrationId: string, enabled: boolean, approval?: Approval) => hub<{ integration: Integration }>(`/integrations/${encodeURIComponent(integrationId)}/enabled`, { method: 'POST', body: JSON.stringify({ enabled, approval }) }).then(value => value.integration),
    /**
     * Testa a conexão (X-04). NÃO executa ferramenta nenhuma do lado de lá: o
     * servidor abre a conexão, lê o catálogo e fecha.
     */
    testIntegration: (integrationId: string) => hub<IntegrationTestResult>(`/integrations/${encodeURIComponent(integrationId)}/test`, { method: 'POST', body: '{}' }),
    /**
     * Instala o TEXTO de uma habilidade (T-11).
     *
     * A rota existia desde a OS-76 e nenhuma tela a chamava: quem quisesse
     * instalar o texto tinha de falar HTTP. Exige `integrations.manage` — o
     * corpo de uma habilidade e INSTRUCAO que entra no contexto de um agente, e
     * quem pode instala-la e quem pode instalar integracao.
     *
     * A resposta NAO devolve o texto: ela devolve a integracao recortada, com
     * `skill_body_installed`. Devolve-lo faria toda instalacao trafegar duas
     * vezes o que acabou de subir.
     */
    installSkillBody: (integrationId: string, body: string) => hub<{ integration: Integration }>(`/integrations/${encodeURIComponent(integrationId)}/skill-body`, {
      method: 'POST', body: JSON.stringify({ body }),
    }).then(value => value.integration),
    /**
     * Remove a integração (X-04). Só funciona com ela DESLIGADA, e o servidor
     * pede a mesma confirmação que ligar exigiria.
     */
    removeIntegration: (integrationId: string, approval?: Approval) => hub<{ removed: RemovedIntegration }>(`/integrations/${encodeURIComponent(integrationId)}`, {
      method: 'DELETE',
      ...(approval === undefined ? {} : { body: JSON.stringify({ approval }) }),
    }).then(value => value.removed),
    exports: (projectId: string) => hub<{ exports: ExportRecord[] }>(`/projects/${encodeURIComponent(projectId)}/exports`).then(value => value.exports),
    createExport: (projectId: string) => hub<{ export: ExportRecord }>(`/projects/${encodeURIComponent(projectId)}/exports`, { method: 'POST', body: '{}' }).then(value => value.export),
    downloadHref: (projectId: string, exportId: string) => `${HUB_API_PREFIX}/projects/${encodeURIComponent(projectId)}/exports/${encodeURIComponent(exportId)}/download`,
    // One page, newest first: the history grows for as long as the Studio runs.
    events: (limit = 50) => hub<{ events: HubEvent[]; next_cursor: string | null }>(`/events?limit=${encodeURIComponent(String(limit))}`).then(value => value.events),
    projects: () => call<{ projects: ProjectSummary[] }>(APPS_API_PREFIX, '/projects').then(value => value.projects),
  }
}

export type HubApi = ReturnType<typeof createHubApi>

/**
 * A pergunta do catálogo virando barra de endereço.
 *
 * Um campo vazio é OMITIDO em vez de virar `q=`: mandar um filtro vazio faria o
 * servidor responder à pergunta errada, e o cursor de uma busca antiga
 * misturaria duas listas diferentes na mesma tela.
 * @param query - busca, filtros, limite e posição.
 * @returns a parte da consulta, com `?`, ou uma cadeia vazia.
 */
export function catalogSearch(query: CatalogQuery): string {
  const params = new URLSearchParams()
  if (query.search !== undefined && query.search.trim() !== '') params.set('q', query.search.trim())
  if (query.kind !== undefined && query.kind !== 'all') params.set('kind', query.kind)
  if (query.status !== undefined && query.status !== 'all') params.set('status', query.status)
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  if (query.cursor !== undefined && query.cursor !== '') params.set('cursor', query.cursor)
  const search = params.toString()
  return search === '' ? '' : `?${search}`
}

/** `local_route: null` = o perfil Privado local esta bloqueado agora; ausente = servidor antigo, que nao sabe responder. */
/**
 * `UNKNOWN` é o estado de ANTES da primeira resposta de `/health`.
 *
 * A tela começava em `ATTENTION`, então toda visita abria com um alarme que
 * ninguém tinha medido ainda. O servidor nunca devolve `UNKNOWN`: ele é da
 * tela, e some na primeira leitura.
 */
export type HealthState = { state: 'OK' | 'ATTENTION' | 'UNKNOWN'; route: string | null; route_reason?: string | null; route_reason_code?: string | null; route_name?: string | null; local_route?: string | null; builder: 'OK' | 'BLOCKED_EXTERNAL'; disk: 'OK' | 'ATTENTION'; capabilities?: CapabilityReport[] }
import type { CapabilityReport } from './presentation'
import textos from './i18n/tarefa.pt-BR.json'

export type ProjectSummary = { project_id: string; name: string; state: string }

export const CSRF_STORAGE_KEY = 'dz23.studio.csrf.v1'

export type ApiResponse<T> = { status: number; body: T | null }

export async function csrfToken(): Promise<string> {
  const stored = window.sessionStorage.getItem(CSRF_STORAGE_KEY)
  if (stored !== null && stored !== '') return stored
  const response = await fetch('/api/studio/identity/csrf', { credentials: 'same-origin' })
  if (!response.ok) return ''
  const body = await response.json() as { csrf_token?: unknown }
  if (typeof body.csrf_token !== 'string' || body.csrf_token === '') return ''
  window.sessionStorage.setItem(CSRF_STORAGE_KEY, body.csrf_token)
  return body.csrf_token
}

async function request<T>(path: string, init: RequestInit): Promise<{ response: Response; body: (T & { error?: string }) | null }> {
  const csrfValue = init.body === undefined ? '' : await csrfToken()
  const bodyHeaders = init.body === undefined ? {} : typeof init.body === 'string'
    ? { 'content-type': 'application/json', 'x-dz23-csrf': csrfValue }
    : { 'x-dz23-csrf': csrfValue }
  const response = await fetch(`/api/studio/apps${path}`, {
    ...init,
    credentials: 'same-origin',
    // Toda escrita diz que sabe esperar (ver `esperarOperacao`). Só as rotas
    // que esperam o modelo usam isto; as outras ignoram o cabeçalho.
    headers: { ...bodyHeaders, ...(init.method === 'POST' ? { 'x-dz23-espera': 'longa' } : {}), ...init.headers },
  })
  const body = await response.json().catch(() => null) as (T & { error?: string; operacao_pendente?: string }) | null
  const pendente = response.status === 202 && typeof body?.operacao_pendente === 'string' ? body.operacao_pendente : undefined
  const projeto = /^\/projects\/([^/?]+)\//u.exec(path)?.[1]
  if (pendente !== undefined && projeto !== undefined) return esperarOperacao<T>(projeto, pendente)
  return { response, body }
}

/** De quanto em quanto tempo a tela pergunta, e até quando. */
export const ESPERA_ENTRE_PERGUNTAS_MS = 2_000
export const ESPERA_MAXIMA_MS = 90 * 60_000

/**
 * Pergunta pelo resultado de uma operação longa até ele chegar, e o devolve
 * como se a rota tivesse respondido na hora: mesmo status, mesmo corpo.
 *
 * Medido em 19/09/2026: um plano feito por modelo local passou de cinco
 * minutos, o navegador desistiu do pedido aos 308 s, e a tela ficou parada com
 * o plano pronto no servidor. Quem chama `api()` não muda nada: a espera
 * acontece aqui dentro.
 * @param projeto - o projeto, já codificado para a URL.
 * @param id - a operação.
 * @param dormir - a pausa entre perguntas (substituível nos testes).
 * @returns a resposta final.
 */
export async function esperarOperacao<T>(projeto: string, id: string, dormir: (ms: number) => Promise<void> = ms => new Promise(resolve => { setTimeout(resolve, ms) })): Promise<{ response: Response; body: (T & { error?: string }) | null }> {
  const limite = Date.now() + ESPERA_MAXIMA_MS
  // Começa perguntando depressa — a maioria das respostas chega em menos de
  // um segundo — e desacelera até o passo normal.
  // O número de voltas também tem teto: um relógio parado (ou um teste) não
  // pode transformar a espera num laço infinito.
  for (let volta = 0; Date.now() < limite && volta < ESPERA_MAXIMA_MS / 200; volta++) {
    await dormir(Math.min(ESPERA_ENTRE_PERGUNTAS_MS, 200 * 2 ** volta))
    const consulta = await fetch(`/api/studio/apps/projects/${projeto}/operation?id=${encodeURIComponent(id)}`, { credentials: 'same-origin' })
    const estado = await consulta.json().catch(() => null) as { estado?: string; status?: number; corpo?: unknown; error?: string } | null
    if (!consulta.ok) return { response: new Response(null, { status: consulta.status }), body: (estado ?? { error: `HTTP ${String(consulta.status)}` }) as T & { error?: string } }
    if (estado?.estado === 'PRONTA' && typeof estado.status === 'number') {
      return { response: new Response(null, { status: estado.status }), body: (estado.corpo ?? null) as (T & { error?: string }) | null }
    }
  }
  return { response: new Response(null, { status: 504 }), body: { error: textos.operacaoDemorada } as T & { error?: string } }
}

/**
 * Request variant for protocols whose HTTP status is part of the contract.
 * Authentication, tenant and role still come exclusively from the server-side
 * session cookie; the browser contributes only the CSRF token issued by it.
 */
export async function apiResponse<T>(path: string, init: RequestInit = {}): Promise<ApiResponse<T>> {
  const { response, body } = await request<T>(path, init)
  return { status: response.status, body }
}

export async function api<T>(path: string, init: RequestInit = {}, acceptDeclaredResult = false): Promise<T> {
  const { response, body } = await request<T>(path, init)
  if (!response.ok && !(acceptDeclaredResult && typeof body === 'object' && body !== null && 'state' in body)) {
    throw new Error(body?.error ?? `HTTP ${response.status}`)
  }
  if (body === null) throw new Error(`HTTP ${response.status}`)
  return body
}

import { csrfToken } from '../api'
import copy from '../i18n/mission.pt-BR.json'

/** O prefixo do servidor de missões. */
export const MISSION_API_PREFIX = '/api/studio/missions'

/** O endereço da tela de objetivos. */
export const MISSION_PATH = '/studio/objetivos'

/**
 * Se o endereço aberto é o da tela de objetivos.
 * @param pathname - o caminho atual do navegador.
 * @returns se esta tela responde por ele.
 */
export function isMissionPath(pathname: string): boolean {
  return pathname === MISSION_PATH || pathname.startsWith(`${MISSION_PATH}/`)
}

export type CriterionState = 'UNPROVEN' | 'PROVEN' | 'REFUTED' | 'BLOCKED_EXTERNAL'
export type MissionStatus = 'RUNNING' | 'CANDIDATE_COMPLETED' | 'COMPLETED' | 'ABANDONED'

export interface MissionCriterion {
  readonly criterion_id: string
  readonly statement: string
  readonly state: CriterionState
  readonly evidence: string | null
  readonly blocked_reason: string | null
}

export type MissionSpend =
  | { readonly kind: 'NO_LIMIT' }
  | { readonly kind: 'WITHIN'; readonly spent: number; readonly limit: number }
  | { readonly kind: 'EXCEEDED'; readonly spent: number; readonly limit: number }
  | { readonly kind: 'UNMEASURED'; readonly runId: string; readonly limit: number }

export type MissionCompletion =
  | { readonly kind: 'PROVEN' }
  | { readonly kind: 'REFUTED'; readonly criteria: readonly string[] }
  | { readonly kind: 'UNPROVEN'; readonly criteria: readonly string[] }
  | { readonly kind: 'BLOCKED_EXTERNAL'; readonly criteria: readonly string[]; readonly reasons: readonly string[] }

export interface MissionView {
  readonly mission_id: string
  readonly objective: string
  readonly status: MissionStatus
  readonly max_total_tokens: number | null
  readonly run_ids: readonly string[]
  readonly criteria: readonly MissionCriterion[]
  readonly created_at: string
  readonly updated_at: string
  readonly spend: MissionSpend
  readonly completion: MissionCompletion
}

const CRITERION_STATES: readonly CriterionState[] = ['UNPROVEN', 'PROVEN', 'REFUTED', 'BLOCKED_EXTERNAL']
const MISSION_STATUSES: readonly MissionStatus[] = ['RUNNING', 'CANDIDATE_COMPLETED', 'COMPLETED', 'ABANDONED']

function whole(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/**
 * O gasto veio inteiro do servidor?
 *
 * `UNMEASURED` obriga a trazer QUAL execução não foi medida. Sem esse campo, a
 * tela diria "não dá para medir" sem dizer o que olhar — e o que a pessoa faria
 * com essa frase é nada.
 * @param value - o campo cru.
 * @returns se dá para desenhar.
 */
export function isMissionSpend(value: unknown): value is MissionSpend {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  if (row.kind === 'NO_LIMIT') return true
  if (row.kind === 'WITHIN' || row.kind === 'EXCEEDED') return whole(row.spent) && whole(row.limit)
  return row.kind === 'UNMEASURED' && typeof row.runId === 'string' && row.runId !== '' && whole(row.limit)
}

/**
 * O veredito de conclusão veio inteiro?
 *
 * Todo veredito que NÃO é `PROVEN` obriga a trazer os itens que o justificam:
 * "ainda falta" sem dizer o que falta é uma frase que não ajuda ninguém.
 * @param value - o campo cru.
 * @returns se dá para desenhar.
 */
export function isMissionCompletion(value: unknown): value is MissionCompletion {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  if (row.kind === 'PROVEN') return true
  const named = Array.isArray(row.criteria) && row.criteria.length > 0 && row.criteria.every(item => typeof item === 'string')
  if (row.kind === 'REFUTED' || row.kind === 'UNPROVEN') return named
  return row.kind === 'BLOCKED_EXTERNAL' && named
    && Array.isArray(row.reasons) && row.reasons.every(item => typeof item === 'string')
}

function isCriterion(value: unknown): value is MissionCriterion {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return typeof row.criterion_id === 'string' && row.criterion_id !== ''
    && typeof row.statement === 'string' && row.statement !== ''
    && CRITERION_STATES.includes(row.state as CriterionState)
    && (row.evidence === null || typeof row.evidence === 'string')
    && (row.blocked_reason === null || typeof row.blocked_reason === 'string')
}

/**
 * A missão inteira, ou nada.
 *
 * Uma missão a que falte um item mostraria uma lista com uma linha a menos e
 * diria, em silêncio, que aquele item não faz parte do combinado — que é
 * exatamente o erro mais caro que esta tela pode cometer.
 * @param value - o objeto cru devolvido pelo servidor.
 * @returns se é uma missão que a tela pode desenhar.
 */
export function isMissionView(value: unknown): value is MissionView {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return typeof row.mission_id === 'string' && row.mission_id !== ''
    && typeof row.objective === 'string' && row.objective !== ''
    && MISSION_STATUSES.includes(row.status as MissionStatus)
    && (row.max_total_tokens === null || whole(row.max_total_tokens))
    && Array.isArray(row.run_ids) && row.run_ids.every(item => typeof item === 'string')
    && Array.isArray(row.criteria) && row.criteria.length > 0 && row.criteria.every(isCriterion)
    && typeof row.created_at === 'string' && row.created_at !== ''
    && typeof row.updated_at === 'string' && row.updated_at !== ''
    && isMissionSpend(row.spend)
    && isMissionCompletion(row.completion)
}

export class MissionRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

export interface MissionPort {
  fetch(input: string, init?: RequestInit): Promise<Response>
}

const defaultPort: MissionPort = { fetch: (input, init) => fetch(input, init) }

async function readBody(response: Response): Promise<Record<string, unknown> | undefined> {
  return await response.json().catch(() => undefined) as Record<string, unknown> | undefined
}

function failure(response: Response, body: Record<string, unknown> | undefined, fallback: string): MissionRequestError {
  return new MissionRequestError(response.status, typeof body?.error === 'string' ? body.error : fallback)
}

/**
 * Os objetivos deste espaço de trabalho.
 *
 * Uma missão incompleta é DESCARTADA da lista, e não desenhada pela metade. É a
 * mesma regra que o painel de equipe usa para os cartões.
 * @param port - a porta de rede, injetável no teste.
 * @param signal - cancelamento da leitura.
 * @returns as missões completas.
 */
export async function listMissions(port: MissionPort = defaultPort, signal?: AbortSignal): Promise<readonly MissionView[]> {
  const response = await port.fetch(`${MISSION_API_PREFIX}/missions`, {
    method: 'GET', credentials: 'same-origin', ...(signal === undefined ? {} : { signal }),
  })
  const body = await readBody(response)
  if (!response.ok) throw failure(response, body, copy.readError)
  if (!Array.isArray(body?.missions)) throw new MissionRequestError(response.status, copy.invalidServerResponse)
  return body.missions.filter(isMissionView)
}

/**
 * Declara que o objetivo parece terminado.
 *
 * Não conclui nada: quem decide é a conferência dos itens no servidor. A tela
 * separa os dois gestos de propósito, porque no produto eles são coisas
 * diferentes.
 * @param missionId - o objetivo.
 * @param port - a porta de rede, injetável no teste.
 * @param getCsrf - de onde sai o token de CSRF.
 * @returns o objetivo atualizado.
 */
export async function declareCandidate(
  missionId: string, port: MissionPort = defaultPort, getCsrf: () => Promise<string> = csrfToken,
): Promise<MissionView> {
  return write(`${MISSION_API_PREFIX}/missions/${encodeURIComponent(missionId)}/candidate`, 'POST', undefined, port, getCsrf, copy.candidateError)
}

/**
 * Conclui o objetivo — e o servidor recusa se algum item não estiver comprovado.
 * @param missionId - o objetivo.
 * @param port - a porta de rede, injetável no teste.
 * @param getCsrf - de onde sai o token de CSRF.
 * @returns o objetivo atualizado.
 */
export async function completeMission(
  missionId: string, port: MissionPort = defaultPort, getCsrf: () => Promise<string> = csrfToken,
): Promise<MissionView> {
  return write(`${MISSION_API_PREFIX}/missions/${encodeURIComponent(missionId)}/complete`, 'POST', undefined, port, getCsrf, copy.completeError)
}

async function write(
  url: string, method: string, payload: unknown, port: MissionPort, getCsrf: () => Promise<string>, fallback: string,
): Promise<MissionView> {
  const response = await port.fetch(url, {
    method,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-dz23-csrf': await getCsrf() },
    ...(payload === undefined ? { body: '{}' } : { body: JSON.stringify(payload) }),
  })
  const body = await readBody(response)
  if (!response.ok) throw failure(response, body, fallback)
  if (!isMissionView(body?.mission)) throw new MissionRequestError(response.status, copy.invalidServerResponse)
  return body.mission
}

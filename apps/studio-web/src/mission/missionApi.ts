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
export type MissionStatus = 'RUNNING' | 'CANDIDATE_COMPLETED' | 'COMPLETED'

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
  readonly run_count: number
  readonly criteria: readonly MissionCriterion[]
  readonly created_at: string
  readonly updated_at: string
  readonly spend: MissionSpend
  readonly completion: MissionCompletion
}

const CRITERION_STATES: readonly CriterionState[] = ['UNPROVEN', 'PROVEN', 'REFUTED', 'BLOCKED_EXTERNAL']
const MISSION_STATUSES: readonly MissionStatus[] = ['RUNNING', 'CANDIDATE_COMPLETED', 'COMPLETED']

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
    && whole(row.run_count)
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

/**
 * O identificador técnico derivado de uma frase escrita por gente.
 *
 * O servidor exige `mission_id`, e pedir isso à pessoa seria pedir que ela
 * inventasse uma chave de banco de dados para poder escrever um objetivo. Então
 * a frase vira o identificador: minúsculas, sem acento, espaços viram traço, e
 * o que não é letra nem número cai fora.
 *
 * Frase que não sobra NADA depois disso — só emoji, só pontuação, um idioma
 * sem alfabeto latino — devolve string vazia, e quem chama trata. Inventar um
 * identificador aleatório aqui esconderia o caso em vez de resolvê-lo.
 * @param phrase - a frase escrita pela pessoa.
 * @returns o identificador, ou string vazia quando não sobra nada.
 */
export function slugify(phrase: string): string {
  return phrase
    .normalize('NFD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 120)
    .replace(/-+$/gu, '')
}

/**
 * O identificador que ainda não está em uso entre os que a tela conhece.
 *
 * É uma cortesia, e NÃO a garantia: a tela vê só os objetivos que carregou, e
 * quem decide de verdade é o servidor, que recusa o repetido. Tratar isto como
 * garantia seria repetir a conferência no lugar errado — e o lugar errado é
 * qualquer lugar onde outra pessoa pode ter criado no meio.
 * @param base - o identificador derivado da frase.
 * @param taken - os identificadores já vistos.
 * @returns o identificador livre.
 */
export function uniqueSlug(base: string, taken: readonly string[]): string {
  if (base === '') return ''
  const usados = new Set(taken)
  if (!usados.has(base)) return base
  for (let suffix = 2; suffix < 1_000; suffix += 1) {
    const candidate = `${base.slice(0, 115)}-${String(suffix)}`
    if (!usados.has(candidate)) return candidate
  }
  return ''
}

export interface MissionDraft {
  readonly missionId: string
  readonly objective: string
  readonly maxTotalTokens: number | null
  readonly criteria: readonly { readonly criterion_id: string; readonly statement: string }[]
}

/**
 * Cria um objetivo.
 *
 * A validação do servidor NÃO é repetida aqui: a tela impede o envio vazio para
 * não gastar uma ida de rede à toa, e tudo o mais que for recusado chega como a
 * frase do servidor e é mostrada.
 * @param draft - o rascunho montado pela tela.
 * @param port - a porta de rede, injetável no teste.
 * @param getCsrf - de onde sai o token de CSRF.
 * @returns o objetivo criado.
 */
export async function createMission(
  draft: MissionDraft, port: MissionPort = defaultPort, getCsrf: () => Promise<string> = csrfToken,
): Promise<MissionView> {
  return write(`${MISSION_API_PREFIX}/missions`, 'POST', {
    mission_id: draft.missionId,
    objective: draft.objective,
    max_total_tokens: draft.maxTotalTokens,
    criteria: draft.criteria,
  }, port, getCsrf, copy.createError)
}

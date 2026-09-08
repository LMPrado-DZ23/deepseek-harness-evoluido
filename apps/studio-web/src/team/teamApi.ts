import copy from '../i18n/team.pt-BR.json'
import { ConversationRequestError, type ConversationPort } from '../assistant/conversationApi'
import { csrfToken } from '../api'

export const TEAMS_ENDPOINT = '/studio/teams'
export const TEAM_POLL_MS = 5_000

const TEAM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const TASK_ID = /^[a-z][a-z0-9_-]{0,63}$/u

export interface TeamCard {
  readonly team_id: string
  readonly name: string
  readonly status: string
  readonly updated_at: string
}

export type TaskEvidence =
  | { readonly state: 'NOT_EXECUTED' }
  | {
    readonly state: 'MEASURED'
    readonly changed_files: readonly string[]
    readonly diff_bytes: number
    readonly diff_sha256: string
    readonly base_commit: string
    readonly main_changed_during_run: boolean
  }

export type TaskCost =
  | { readonly state: 'NOT_MEASURED' }
  | { readonly state: 'MEASURED', readonly tokens: number }

export type TeamCost =
  | { readonly state: 'NOT_MEASURED', readonly reason: string }
  | { readonly state: 'PARTIAL', readonly tokens: number, readonly measured: number, readonly total: number, readonly reason: string }
  | { readonly state: 'MEASURED', readonly tokens: number, readonly measured: number }

export interface TeamTask {
  readonly task_id: string
  readonly title: string
  readonly role: string
  readonly status: string
  readonly depends_on: readonly string[]
  readonly intended_paths: readonly string[]
  readonly blocked: boolean
  readonly diagnostic: string | null
  readonly evidence: TaskEvidence
  readonly cost: TaskCost
  readonly updated_at: string
}

export interface TeamPanel extends TeamCard {
  readonly workspace_id: string
  readonly required_tier: string
  readonly sensitive_operation: string | null
  readonly approved_by: string
  readonly approved_at: string
  readonly diagnostic: string | null
  readonly created_at: string
  readonly tasks: readonly TeamTask[]
  readonly cost: TeamCost
}

/** Um cartão só é desenhado quando é inteiro: meia linha aqui vira trabalho fantasma. */
export function isTeamCard(value: unknown): value is TeamCard {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return typeof row.team_id === 'string' && TEAM_ID.test(row.team_id)
    && typeof row.name === 'string' && row.name !== ''
    && typeof row.status === 'string' && row.status !== ''
    && typeof row.updated_at === 'string' && row.updated_at !== ''
}

/**
 * O custo de uma etapa. Um número medido tem de ser um inteiro não negativo:
 * qualquer outra coisa é lida como ausência de medida, e não desenhada.
 * @param value - o campo devolvido pelo servidor.
 * @returns se é um custo de etapa que a tela pode desenhar.
 */
function isTaskCost(value: unknown): value is TaskCost {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  if (row.state === 'NOT_MEASURED') return true
  return row.state === 'MEASURED' && typeof row.tokens === 'number' && Number.isInteger(row.tokens) && row.tokens >= 0
}

/**
 * O custo da equipe.
 *
 * `PARTIAL` obriga a trazer quantas etapas entraram na soma E quantas
 * executaram: sem os dois números, "parcial" seria uma palavra sem tamanho e a
 * tela mostraria uma soma pela metade como se fosse o total.
 * @param value - o campo devolvido pelo servidor.
 * @returns se é um custo de equipe que a tela pode desenhar.
 */
function isTeamCost(value: unknown): value is TeamCost {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  const whole = (candidate: unknown): boolean => typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 0
  if (row.state === 'NOT_MEASURED') return typeof row.reason === 'string' && row.reason !== ''
  if (row.state === 'MEASURED') return whole(row.tokens) && whole(row.measured)
  return row.state === 'PARTIAL' && whole(row.tokens) && whole(row.measured) && whole(row.total)
    && typeof row.reason === 'string' && row.reason !== ''
}

function isEvidence(value: unknown): value is TaskEvidence {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  if (row.state === 'NOT_EXECUTED') return true
  return row.state === 'MEASURED'
    && Array.isArray(row.changed_files) && row.changed_files.every(entry => typeof entry === 'string')
    && typeof row.diff_bytes === 'number' && Number.isInteger(row.diff_bytes) && row.diff_bytes >= 0
    && typeof row.diff_sha256 === 'string'
    && typeof row.base_commit === 'string' && row.base_commit !== ''
    && typeof row.main_changed_during_run === 'boolean'
}

/** Uma etapa incompleta é DESCARTADA: desenhar meia etapa desenha uma árvore torta. */
export function isTeamTask(value: unknown): value is TeamTask {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return typeof row.task_id === 'string' && TASK_ID.test(row.task_id)
    && typeof row.title === 'string' && row.title !== ''
    && typeof row.role === 'string' && row.role !== ''
    && typeof row.status === 'string' && row.status !== ''
    && Array.isArray(row.depends_on) && row.depends_on.every(entry => typeof entry === 'string')
    && Array.isArray(row.intended_paths) && row.intended_paths.every(entry => typeof entry === 'string')
    && typeof row.blocked === 'boolean'
    && (row.diagnostic === null || typeof row.diagnostic === 'string')
    && isEvidence(row.evidence)
    && isTaskCost(row.cost)
    && typeof row.updated_at === 'string' && row.updated_at !== ''
}

/**
 * O painel inteiro, ou nada.
 *
 * Aqui a etapa quebrada NÃO é descartada: um painel a que falta uma etapa
 * mostraria uma árvore com um galho a menos e diria, em silêncio, que aquele
 * trabalho não existe. Melhor recusar o painel e dizer que a resposta não foi
 * entendida.
 * @param value - o corpo devolvido pelo servidor.
 * @returns se o valor é um painel completo.
 */
export function isTeamPanel(value: unknown): value is TeamPanel {
  if (!isTeamCard(value)) return false
  const row = value as unknown as Record<string, unknown>
  return typeof row.workspace_id === 'string' && row.workspace_id !== ''
    && typeof row.required_tier === 'string' && row.required_tier !== ''
    && (row.sensitive_operation === null || typeof row.sensitive_operation === 'string')
    && typeof row.approved_by === 'string'
    && typeof row.approved_at === 'string'
    && (row.diagnostic === null || typeof row.diagnostic === 'string')
    && typeof row.created_at === 'string'
    && Array.isArray(row.tasks) && row.tasks.every(isTeamTask)
    && isTeamCost(row.cost)
}

const defaultPort: ConversationPort = { fetch: (input, init) => fetch(input, init) }

async function readBody(response: Response): Promise<Record<string, unknown> | undefined> {
  return await response.json().catch(() => undefined) as Record<string, unknown> | undefined
}

function failure(response: Response, body: Record<string, unknown> | undefined, fallback: string): ConversationRequestError {
  const message = typeof body?.error === 'string' ? body.error : fallback
  return new ConversationRequestError(response.status, message, response.status >= 500)
}

/**
 * Os trabalhos em equipe do projeto.
 * @param port - a porta de rede, injetável no teste.
 * @param signal - cancelamento da leitura.
 * @returns os cartões completos; os incompletos são descartados.
 */
export async function listTeams(port: ConversationPort = defaultPort, signal?: AbortSignal): Promise<readonly TeamCard[]> {
  const response = await port.fetch(TEAMS_ENDPOINT, {
    method: 'GET', credentials: 'same-origin', ...(signal === undefined ? {} : { signal }),
  })
  const body = await readBody(response)
  if (!response.ok) throw failure(response, body, copy.readError)
  if (!Array.isArray(body?.teams)) throw new ConversationRequestError(response.status, copy.invalidServerResponse, false)
  return body.teams.filter(isTeamCard)
}

/**
 * O painel de um trabalho.
 * @param teamId - o identificador do trabalho.
 * @param port - a porta de rede, injetável no teste.
 * @param signal - cancelamento da leitura.
 * @returns o painel completo.
 */
export async function readTeam(
  teamId: string, port: ConversationPort = defaultPort, signal?: AbortSignal,
): Promise<TeamPanel> {
  const response = await port.fetch(`${TEAMS_ENDPOINT}/${encodeURIComponent(teamId)}`, {
    method: 'GET', credentials: 'same-origin', ...(signal === undefined ? {} : { signal }),
  })
  const body = await readBody(response)
  if (!response.ok) throw failure(response, body, copy.readError)
  if (!isTeamPanel(body?.team)) throw new ConversationRequestError(response.status, copy.invalidServerResponse, false)
  return body.team
}

/**
 * Para um trabalho em equipe.
 *
 * O motivo é OPCIONAL e o pedido carrega só ele: quem está parando sai da
 * sessão, no servidor. Um campo de usuário aqui seria um campo que o navegador
 * escolhe, e a autoria da parada é a única coisa que ela não pode escolher.
 * @param teamId - o trabalho a parar.
 * @param reason - o motivo escrito, quando houver.
 * @param port - a porta de rede, injetável no teste.
 * @param getCsrf - de onde sai o token de CSRF.
 * @returns o painel já com o trabalho interrompido.
 */
export async function stopTeam(
  teamId: string,
  reason: string,
  port: ConversationPort = defaultPort,
  getCsrf: () => Promise<string> = csrfToken,
): Promise<TeamPanel> {
  const trimmed = reason.trim()
  const response = await port.fetch(`${TEAMS_ENDPOINT}/${encodeURIComponent(teamId)}/stop`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-dz23-csrf': await getCsrf() },
    body: JSON.stringify(trimmed === '' ? {} : { reason: trimmed }),
  })
  const body = await readBody(response)
  if (!response.ok) {
    const fallback = body?.code === 'FORBIDDEN' ? copy.stopForbidden
      : body?.code === 'CONFLICT' ? copy.stopAlreadyOver
        : copy.stopError
    throw failure(response, body, fallback)
  }
  if (!isTeamPanel(body?.team)) throw new ConversationRequestError(response.status, copy.invalidServerResponse, false)
  return body.team
}

/**
 * O identificador do trabalho pedido no endereço, quando houver.
 * @param pathname - o caminho atual do navegador.
 * @returns o `team_id`, ou `null` para a lista.
 */
export function teamIdFromPath(pathname: string): string | null {
  const match = /^\/studio\/progresso\/([0-9a-f-]+)\/?$/u.exec(pathname)
  return match !== null && TEAM_ID.test(match[1]!) ? match[1]! : null
}

/** Caminho da tela de progresso. */
export const TEAM_PATH = '/studio/progresso'

/**
 * Se o endereço aberto é a tela de progresso.
 * @param pathname - o caminho atual do navegador.
 * @returns se esta tela responde por ele.
 */
export function isTeamPath(pathname: string): boolean {
  return pathname === TEAM_PATH || pathname.startsWith(`${TEAM_PATH}/`)
}

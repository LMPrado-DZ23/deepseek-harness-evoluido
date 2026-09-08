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
  readonly cost: { readonly state: 'NOT_MEASURED', readonly reason: string }
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
  const cost = row.cost as Record<string, unknown> | undefined
  return typeof row.workspace_id === 'string' && row.workspace_id !== ''
    && typeof row.required_tier === 'string' && row.required_tier !== ''
    && (row.sensitive_operation === null || typeof row.sensitive_operation === 'string')
    && typeof row.approved_by === 'string'
    && typeof row.approved_at === 'string'
    && (row.diagnostic === null || typeof row.diagnostic === 'string')
    && typeof row.created_at === 'string'
    && Array.isArray(row.tasks) && row.tasks.every(isTeamTask)
    && typeof cost === 'object' && cost !== null
    && cost.state === 'NOT_MEASURED' && typeof cost.reason === 'string' && cost.reason !== ''
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

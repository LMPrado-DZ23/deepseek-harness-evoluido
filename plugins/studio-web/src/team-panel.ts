import type { IncomingMessage } from 'node:http'
import { authenticatedMutation, type StudioIdentityService } from '@dz23-studio/identity'
import { t } from './i18n.js'

/**
 * O painel do trabalho em equipe.
 *
 * Até aqui o estado de uma equipe de agentes só existia dentro das ferramentas
 * de conversa: quem quisesse saber o que cada etapa estava fazendo tinha de
 * PEDIR ao assistente e confiar na frase que voltasse. Uma pessoa leiga não
 * tem como perguntar o que não sabe que existe, e não tem como parar o que não
 * consegue ver. Esta rota existe para que o trabalho seja olhado, e não
 * narrado.
 *
 * Três leituras e uma parada. Não há como INICIAR equipe por aqui de
 * propósito: começar exige o agente vivo da conversa (`parent: Agent`), que
 * não atravessa HTTP, e uma rota que fingisse iniciar seria pior que a
 * ausência dela.
 */

export const TEAM_PANEL_PREFIX = '/studio/teams'

/** UUID v4 do `team_id`. Recusar aqui evita levar texto arbitrário ao serviço. */
const TEAM_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

const MAX_STOP_BODY_BYTES = 4096
const MAX_STOP_REASON = 500

export type TeamPanelRoute =
  | { readonly kind: 'list' }
  | { readonly kind: 'detail', readonly teamId: string }
  | { readonly kind: 'stop', readonly teamId: string }
  | { readonly kind: 'method-not-allowed' }

/**
 * Roteamento puro do painel.
 * @param method - método HTTP do pedido.
 * @param pathname - caminho já normalizado.
 * @returns a rota reconhecida, ou `undefined` quando o caminho não é deste painel.
 */
export function routeTeamPanel(method: string | undefined, pathname: string): TeamPanelRoute | undefined {
  if (pathname === TEAM_PANEL_PREFIX) {
    return method === 'GET' ? { kind: 'list' } : { kind: 'method-not-allowed' }
  }
  if (!pathname.startsWith(`${TEAM_PANEL_PREFIX}/`)) return undefined
  const rest = pathname.slice(TEAM_PANEL_PREFIX.length + 1)
  const [teamId, suffix, extra] = rest.split('/')
  // Um identificador que não é UUID não é "não encontrado": é caminho que não
  // pertence a este painel, e responder 404 aqui esconderia uma rota vizinha.
  if (teamId === undefined || !TEAM_ID_RE.test(teamId) || extra !== undefined) return undefined
  if (suffix === undefined) return method === 'GET' ? { kind: 'detail', teamId } : { kind: 'method-not-allowed' }
  if (suffix !== 'stop') return undefined
  return method === 'POST' ? { kind: 'stop', teamId } : { kind: 'method-not-allowed' }
}

/** O recorte do runtime de equipes que esta rota lê. Nada além disto. */
export interface TeamPanelTeamsSource {
  teams(): readonly TeamRecordShape[]
  readonly service: {
    status(teamId: string): Promise<TeamSnapshotShape>
    cancel(teamId: string, approvedBy: string, reason?: string): Promise<TeamSnapshotShape>
  }
}

/**
 * O retrato de uma equipe, como esta rota o lê.
 *
 * `blocked` é DERIVADO e vem de quem define dependência — o runtime de
 * equipes. Este painel é desacoplado de propósito e não importa aquele pacote;
 * recalcular a regra aqui criaria uma segunda verdade, que diverge no primeiro
 * conserto de um dos dois lados.
 */
export interface TeamSnapshotShape {
  readonly team: TeamRecordShape
  readonly tasks: readonly TaskRecordShape[]
  readonly blocked: readonly BlockedTaskShape[]
}

export interface BlockedTaskShape {
  readonly task_id: string
  readonly title: string
  readonly reason: string
  readonly dependencies: readonly string[]
}

export interface TeamRecordShape {
  readonly team_id: string
  readonly org_id: string
  readonly tenant_id: string
  readonly workspace_id: string
  readonly name: string
  readonly status: string
  readonly required_tier: string
  readonly sensitive_operation: string | null
  readonly approved_by: string
  readonly approved_at: string
  readonly diagnostic: string | null
  readonly created_at: string
  readonly updated_at: string
}

export interface TaskRecordShape {
  readonly task_id: string
  readonly team_id: string
  readonly title: string
  readonly role: string
  readonly status: string
  readonly run_id: string | null
  readonly depends_on: readonly string[]
  readonly intended_paths: readonly string[]
  readonly diagnostic: string | null
  readonly created_at: string
  readonly updated_at: string
}

/** O recorte do runtime de agentes de onde sai a evidência de cada etapa. */
export interface TeamPanelRunsSource {
  runs(): readonly {
    readonly run_id: string
    readonly changed_files: readonly string[]
    readonly diff_bytes: number
    readonly diff_sha256: string
    readonly base_commit: string
    readonly main_changed_during_run: boolean
    readonly tokens_used?: number | null
  }[]
}

export interface TeamPanelConfig {
  readonly identity: StudioIdentityService
  readonly teams?: TeamPanelTeamsSource
  readonly runs?: TeamPanelRunsSource
}

/**
 * A evidência de uma etapa, como a tela pode mostrá-la.
 *
 * `NOT_EXECUTED` não é zero. Uma etapa que ainda não rodou não mudou zero
 * arquivo: ela não tem o que mostrar, e imprimir "0 arquivos" ao lado de uma
 * etapa em fila faria a pessoa ler ausência de trabalho como trabalho sem
 * efeito.
 */
export type TaskEvidenceView =
  | { readonly state: 'NOT_EXECUTED' }
  | {
    readonly state: 'MEASURED'
    readonly changed_files: readonly string[]
    readonly diff_bytes: number
    readonly diff_sha256: string
    readonly base_commit: string
    readonly main_changed_during_run: boolean
  }

export type TaskCostView =
  | { readonly state: 'NOT_MEASURED' }
  | { readonly state: 'MEASURED', readonly tokens: number }

export interface TaskPanelView {
  readonly task_id: string
  readonly title: string
  readonly role: string
  readonly status: string
  readonly depends_on: readonly string[]
  readonly intended_paths: readonly string[]
  readonly blocked: boolean
  readonly dependency_block: { readonly reason: string; readonly dependencies: readonly string[] } | null
  readonly diagnostic: string | null
  readonly evidence: TaskEvidenceView
  readonly cost: TaskCostView
  readonly updated_at: string
}

export interface TeamCardView {
  readonly team_id: string
  readonly name: string
  readonly status: string
  readonly updated_at: string
}

/**
 * O custo, dito como ele está.
 *
 * `MEASURED` só quando TODA etapa que rodou trouxe medida. Somar as que
 * trouxeram e mostrar o total seria o pior desfecho: a pessoa leria um número
 * completo de uma soma pela metade, e uma equipe com um agente externo (que
 * não publica consumo) pareceria mais barata do que foi.
 */
export type TeamCostView =
  | { readonly state: 'NOT_MEASURED', readonly reason: string }
  | { readonly state: 'PARTIAL', readonly tokens: number, readonly measured: number, readonly total: number, readonly reason: string }
  | { readonly state: 'MEASURED', readonly tokens: number, readonly measured: number }

export interface TeamPanelView extends TeamCardView {
  readonly workspace_id: string
  readonly required_tier: string
  readonly sensitive_operation: string | null
  readonly approved_by: string
  readonly approved_at: string
  readonly diagnostic: string | null
  readonly created_at: string
  readonly tasks: readonly TaskPanelView[]
  readonly cost: TeamCostView
}

export class TeamPanelError extends Error {
  constructor(readonly code: 'NOT_CONFIGURED' | 'NOT_FOUND' | 'INVALID_REQUEST' | 'FORBIDDEN' | 'CONFLICT', message: string) {
    super(message)
  }
}

/**
 * Status HTTP de uma falha do painel.
 * @param error - o erro capturado pelo tratador.
 * @returns o status, ou `undefined` quando o erro não é deste painel.
 */
export function teamPanelStatus(error: unknown): number | undefined {
  if (!(error instanceof TeamPanelError)) return undefined
  return { NOT_CONFIGURED: 503, NOT_FOUND: 404, INVALID_REQUEST: 400, FORBIDDEN: 403, CONFLICT: 409 }[error.code]
}

/** As etapas que não podem andar sozinhas. Uma etapa nesta lista pede gente. */
const BLOCKING_STATUSES = new Set(['FAILED', 'CANCELLED', 'BUDGET_EXCEEDED', 'REJECTED', 'UNKNOWN'])

/**
 * A evidência de uma etapa, buscada pela execução que a produziu.
 * @param runId - a execução da etapa, ou `null` quando ela nunca rodou.
 * @param runs - runtime de agentes, ou `undefined` quando não está montado.
 * @returns o que houver de medido, e `NOT_EXECUTED` quando não houver.
 */
export function taskEvidence(runId: string | null, runs: TeamPanelRunsSource | undefined): TaskEvidenceView {
  const run = findRun(runId, runs)
  if (run === undefined) return { state: 'NOT_EXECUTED' }
  return {
    state: 'MEASURED',
    changed_files: [...run.changed_files],
    diff_bytes: run.diff_bytes,
    diff_sha256: run.diff_sha256,
    base_commit: run.base_commit,
    main_changed_during_run: run.main_changed_during_run,
  }
}

/** A execução de uma etapa, quando ela existe no runtime. */
function findRun(runId: string | null, runs: TeamPanelRunsSource | undefined) {
  if (runId === null || runs === undefined) return undefined
  return runs.runs().find(candidate => candidate.run_id === runId)
}

/**
 * O consumo de UMA etapa.
 *
 * `NOT_MEASURED` cobre três coisas diferentes que a tela trata igual porque
 * para quem olha elas são a mesma: a etapa não rodou, o provedor é externo e
 * não publica consumo, ou a execução é anterior a este campo existir. Nenhuma
 * delas é zero.
 * @param runId - a execução da etapa.
 * @param runs - runtime de agentes.
 * @returns o consumo medido, ou a ausência dele.
 */
export function taskCost(runId: string | null, runs: TeamPanelRunsSource | undefined): TaskCostView {
  const tokens = findRun(runId, runs)?.tokens_used
  return typeof tokens === 'number' ? { state: 'MEASURED', tokens } : { state: 'NOT_MEASURED' }
}

/**
 * O consumo da equipe inteira.
 *
 * Só uma etapa que RODOU deve consumo. Uma etapa em fila não entra na conta de
 * "quantas faltam medir" — ela ainda não tem o que medir, e contá-la faria o
 * total parecer permanentemente incompleto.
 * @param tasks - as etapas já projetadas.
 * @param reason - a frase que explica a ausência de medida.
 * @returns o custo da equipe.
 */
export function teamCost(tasks: readonly TaskPanelView[], reason: string): TeamCostView {
  const executed = tasks.filter(task => task.evidence.state === 'MEASURED')
  const measured = executed.filter(task => task.cost.state === 'MEASURED')
  if (executed.length === 0 || measured.length === 0) return { state: 'NOT_MEASURED', reason }
  const tokens = measured.reduce((total, task) => total + (task.cost.state === 'MEASURED' ? task.cost.tokens : 0), 0)
  if (measured.length < executed.length) {
    return { state: 'PARTIAL', tokens, measured: measured.length, total: executed.length, reason }
  }
  return { state: 'MEASURED', tokens, measured: measured.length }
}

/**
 * A projeção de uma equipe para a tela.
 *
 * `repository_path`, `worktree_path`, `parent_session_id`, `prompt` e os
 * identificadores de organização e inquilino NÃO atravessam: caminho absoluto
 * do computador de quem hospeda não é assunto de quem usa, e o texto do prompt
 * pode carregar o que a pessoa escreveu para o agente.
 * @param team - o registro da equipe.
 * @param tasks - as etapas da equipe.
 * @param runs - runtime de agentes de onde sai a evidência.
 * @returns o painel completo de uma equipe.
 */
export function teamPanelView(
  team: TeamRecordShape,
  tasks: readonly TaskRecordShape[],
  runs: TeamPanelRunsSource | undefined,
  blocked: readonly BlockedTaskShape[] = [],
): TeamPanelView {
  const blockedById = new Map(blocked.map(item => [item.task_id, item]))
  const projected = tasks.map(task => ({
    task_id: task.task_id,
    title: task.title,
    role: task.role,
    status: task.status,
    depends_on: [...task.depends_on],
    intended_paths: [...task.intended_paths],
    blocked: BLOCKING_STATUSES.has(task.status),
    // `blocked` acima é sobre o estado DESTA etapa. `dependency_block` é outra
    // coisa e não se confundem: a etapa está intacta, na fila, e nunca vai
    // andar porque uma dependência dela morreu ou não existe. Sem esta
    // distinção as duas apareciam iguais — uma tarefa esperando para sempre
    // tinha a mesma cara de quem só aguarda a vez.
    dependency_block: blockedById.get(task.task_id) === undefined
      ? null
      : { reason: blockedById.get(task.task_id)!.reason, dependencies: [...blockedById.get(task.task_id)!.dependencies] },
    diagnostic: task.diagnostic,
    evidence: taskEvidence(task.run_id, runs),
    cost: taskCost(task.run_id, runs),
    updated_at: task.updated_at,
  }))
  return {
    team_id: team.team_id,
    name: team.name,
    status: team.status,
    workspace_id: team.workspace_id,
    required_tier: team.required_tier,
    sensitive_operation: team.sensitive_operation,
    approved_by: team.approved_by,
    approved_at: team.approved_at,
    diagnostic: team.diagnostic,
    created_at: team.created_at,
    updated_at: team.updated_at,
    cost: teamCost(projected, t('teamPanel.costNotMeasured')),
    tasks: projected,
  }
}

/**
 * As equipes do escopo exato de quem está perguntando.
 * @param teams - runtime de equipes.
 * @param scope - organização e inquilino da sessão autenticada.
 * @returns cartões ordenados da mais recentemente mexida para a mais antiga.
 */
export function teamCardsFor(
  teams: TeamPanelTeamsSource,
  scope: { readonly org_id: string, readonly tenant_id: string },
): readonly TeamCardView[] {
  return teams.teams()
    .filter(team => team.org_id === scope.org_id && team.tenant_id === scope.tenant_id)
    .map(team => ({ team_id: team.team_id, name: team.name, status: team.status, updated_at: team.updated_at }))
    .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at))
}

/**
 * Lê o motivo opcional da parada.
 * @param request - o pedido HTTP.
 * @returns o motivo escrito, ou `undefined` quando o corpo está vazio.
 */
async function stopReason(request: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Buffer)
    size += buffer.byteLength
    if (size > MAX_STOP_BODY_BYTES) throw new TeamPanelError('INVALID_REQUEST', t('teamPanel.invalidBody'))
    chunks.push(buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (raw === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new TeamPanelError('INVALID_REQUEST', t('teamPanel.invalidBody'))
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TeamPanelError('INVALID_REQUEST', t('teamPanel.invalidBody'))
  }
  const reason = (parsed as { reason?: unknown }).reason
  if (reason === undefined) return undefined
  if (typeof reason !== 'string') throw new TeamPanelError('INVALID_REQUEST', t('teamPanel.invalidBody'))
  if (reason.length > MAX_STOP_REASON) throw new TeamPanelError('INVALID_REQUEST', t('teamPanel.reasonTooLong'))
  return reason
}

/**
 * Atende um pedido do painel.
 * @param request - o pedido HTTP.
 * @param route - a rota já reconhecida.
 * @param config - identidade e os runtimes lidos.
 * @returns status e corpo da resposta.
 */
export async function handleTeamPanel(
  request: IncomingMessage,
  route: TeamPanelRoute,
  config: TeamPanelConfig,
): Promise<{ readonly status: number, readonly body: unknown }> {
  if (route.kind === 'method-not-allowed') {
    return { status: 405, body: { error: t('teamPanel.methodNotAllowed') } }
  }
  // Autentica ANTES de olhar qualquer equipe. O escopo sai do cookie, e a
  // parada só é aceita de quem a sessão diz ser - nunca de um campo do corpo.
  const session = await authenticatedMutation(request, config.identity)
  const teams = config.teams
  if (teams === undefined) throw new TeamPanelError('NOT_CONFIGURED', t('teamPanel.notConfigured'))
  if (route.kind === 'list') {
    return { status: 200, body: { teams: teamCardsFor(teams, session) } }
  }
  // O motivo é lido ANTES da parada: um corpo malformado tem de recusar o
  // pedido inteiro, e não interromper a equipe e falhar depois.
  const reason = route.kind === 'stop' ? await stopReason(request) : undefined
  // A existência é conferida contra o escopo de quem pergunta. Perguntar ao
  // serviço primeiro contaria a quem não é dono que aquela equipe existe.
  const owned = teams.teams().find(team => team.team_id === route.teamId
    && team.org_id === session.org_id
    && team.tenant_id === session.tenant_id)
  if (owned === undefined) throw new TeamPanelError('NOT_FOUND', t('teamPanel.notFound'))
  const snapshot = await (route.kind === 'stop'
    ? teams.service.cancel(route.teamId, session.user_id, reason)
    : teams.service.status(route.teamId)).catch((error: unknown) => { throw translateTeamError(error) })
  return { status: 200, body: { team: teamPanelView(snapshot.team, snapshot.tasks, config.runs, snapshot.blocked) } }
}

/**
 * Traduz a recusa do serviço de equipes para a linguagem desta rota.
 *
 * O serviço mora em outro pacote e esta rota não o importa - depender dele
 * inverteria a direção (a interface passaria a puxar o motor). O que atravessa
 * é o `code`, que é contrato: sem esta tradução, "quem aprovou é outra pessoa"
 * viraria erro 500 e a tela mandaria a pessoa tentar de novo contra uma recusa
 * que tentar de novo não resolve.
 * @param error - a falha vinda do serviço.
 * @returns o erro desta rota, ou o original quando não é reconhecido.
 */
function translateTeamError(error: unknown): unknown {
  if (error instanceof TeamPanelError) return error
  const code = (error as { code?: unknown } | null)?.code
  const message = error instanceof Error ? error.message : ''
  if (code === 'FORBIDDEN') return new TeamPanelError('FORBIDDEN', message)
  if (code === 'NOT_FOUND') return new TeamPanelError('NOT_FOUND', t('teamPanel.notFound'))
  if (code === 'INVALID_STATE') return new TeamPanelError('CONFLICT', message)
  return error
}

import { AlertTriangle, CircleCheck, CircleDashed, FileText, Loader, OctagonX } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import copy from '../i18n/team.pt-BR.json'
import { ConversationRequestError, type ConversationPort } from '../assistant/conversationApi'
import {
  TEAM_POLL_MS,
  listTeams,
  readTeam,
  stopTeam,
  teamIdFromPath,
  type TeamCard,
  type TeamCost as TeamCostData,
  type TeamPanel as TeamPanelData,
  type TeamTask,
} from './teamApi'
import './team.css'

export { TEAM_PATH, isTeamPath } from './teamApi'

/**
 * Nome legível de um estado.
 *
 * O código cru (`BUDGET_EXCEEDED`) não é para ser lido por quem não escreveu o
 * programa. Um estado desconhecido devolve o próprio código em vez de sumir:
 * uma etapa sem estado na tela é uma etapa que a pessoa não sabe se anda.
 * @param table - o dicionário de estados.
 * @param value - o estado devolvido pelo servidor.
 * @returns a frase, ou o código quando ele é novo para esta tela.
 */
export function label(table: Readonly<Record<string, string>>, value: string): string {
  return table[value] ?? value
}

/**
 * Data legível, e o texto original quando não dá para ler.
 * @param value - a data em ISO.
 * @returns a data no formato do Brasil.
 */
export function formatMoment(value: string): string {
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? value : new Date(parsed).toLocaleString('pt-BR')
}

/**
 * A ORDEM em que as etapas são desenhadas: quem não depende de ninguém primeiro,
 * e cada etapa depois de tudo de que ela depende.
 *
 * É isto que faz a lista virar árvore para quem lê de cima para baixo. Um ciclo
 * ou uma dependência que aponta para etapa inexistente NÃO some da tela: o
 * resto é desenhado e as remanescentes vão para o fim, porque esconder uma
 * etapa é pior que mostrá-la fora de ordem.
 * @param tasks - as etapas do painel.
 * @returns as etapas ordenadas por dependência, com profundidade para o recuo.
 */
export function orderedTasks(tasks: readonly TeamTask[]): readonly { readonly task: TeamTask, readonly depth: number }[] {
  const byId = new Map(tasks.map(task => [task.task_id, task]))
  const depth = new Map<string, number>()
  const ordered: { task: TeamTask, depth: number }[] = []
  const remaining = [...tasks]
  let progressed = true
  while (remaining.length > 0 && progressed) {
    progressed = false
    for (let index = 0; index < remaining.length;) {
      const task = remaining[index]!
      const parents = task.depends_on.filter(id => byId.has(id))
      if (parents.every(id => depth.has(id))) {
        const own = parents.length === 0 ? 0 : Math.max(...parents.map(id => depth.get(id)!)) + 1
        depth.set(task.task_id, own)
        ordered.push({ task, depth: own })
        remaining.splice(index, 1)
        progressed = true
        continue
      }
      index += 1
    }
  }
  for (const task of remaining) ordered.push({ task, depth: 0 })
  return ordered
}

const defaultPort: ConversationPort = { fetch: (input, init) => fetch(input, init) }

export interface TeamScreenProps {
  readonly port?: ConversationPort
  readonly pollMs?: number
  readonly pathname?: string
  readonly getCsrf?: () => Promise<string>
}

/**
 * A tela do progresso.
 *
 * Por que existe: até aqui o trabalho em equipe só podia ser PERGUNTADO ao
 * assistente. Quem não sabe que a equipe existe não pergunta, e quem não vê o
 * que está rodando não consegue parar. Esta tela mostra cada etapa, de que ela
 * depende, o que ela mexeu, o que travou, quem autorizou - e traz o botão de
 * parar junto do que ele para.
 */
export function TeamScreen({ port = defaultPort, pollMs = TEAM_POLL_MS, pathname, getCsrf }: TeamScreenProps) {
  const path = pathname ?? (typeof window === 'undefined' ? '' : window.location.pathname)
  const teamId = teamIdFromPath(path)
  const [cards, setCards] = useState<readonly TeamCard[]>([])
  const [panel, setPanel] = useState<TeamPanelData | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [readError, setReadError] = useState<ConversationRequestError | null>(null)
  // O erro da parada é SEPARADO do erro de leitura: a próxima leitura bem
  // sucedida apagaria "não deu para parar", e a pessoa acharia que parou.
  const [stopError, setStopError] = useState<ConversationRequestError | null>(null)
  const [stopping, setStopping] = useState(false)
  const [reason, setReason] = useState('')

  useEffect(() => {
    let live = true
    const controller = new AbortController()
    const read = async (): Promise<void> => {
      try {
        if (teamId === null) {
          const rows = await listTeams(port, controller.signal)
          if (!live) return
          setCards(rows)
        } else {
          const current = await readTeam(teamId, port, controller.signal)
          if (!live) return
          setPanel(current)
        }
        setReadError(null)
        setLoaded(true)
      } catch (caught) {
        if (!live || controller.signal.aborted) return
        setReadError(caught instanceof ConversationRequestError
          ? caught
          : new ConversationRequestError(0, copy.readError, true))
        setLoaded(true)
      }
    }
    void read()
    const timer = setInterval(() => { void read() }, pollMs)
    return () => { live = false; controller.abort(); clearInterval(timer) }
  }, [port, pollMs, teamId])

  const stop = useCallback(async () => {
    if (teamId === null) return
    setStopping(true)
    setStopError(null)
    try {
      setPanel(await stopTeam(teamId, reason, port, getCsrf))
      setReason('')
    } catch (caught) {
      setStopError(caught instanceof ConversationRequestError
        ? caught
        : new ConversationRequestError(0, copy.stopError, true))
    } finally {
      setStopping(false)
    }
  }, [teamId, reason, port, getCsrf])

  return <TeamView
    cards={cards} panel={teamId === null ? null : panel} loaded={loaded}
    readError={readError} stopError={stopError} stopping={stopping}
    reason={reason} onReason={setReason} onStop={() => { void stop() }}
  />
}

export interface TeamViewProps {
  readonly cards: readonly TeamCard[]
  readonly panel: TeamPanelData | null
  readonly loaded: boolean
  readonly readError: ConversationRequestError | null
  readonly stopError: ConversationRequestError | null
  readonly stopping: boolean
  readonly reason: string
  readonly onReason: (value: string) => void
  readonly onStop: () => void
}

/** A parte visível, pura, para que o desenho seja provável sem esperar rede. */
export function TeamView(props: TeamViewProps) {
  const { cards, panel, loaded, readError, stopError } = props
  return <main className="team-screen" aria-labelledby="team-title">
    <h1 id="team-title">{copy.title}</h1>
    <p className="team-intro">{copy.intro}</p>
    {readError !== null && <p className="error" role="alert"><AlertTriangle aria-hidden="true" />{readError.message}</p>}
    {stopError !== null && <p className="error" role="alert"><AlertTriangle aria-hidden="true" />{stopError.message}</p>}
    {/* "Nenhum trabalho" só é dito depois de uma leitura que deu certo. Antes
        disso a frase seria uma afirmação sobre o que ninguém leu ainda. */}
    {!loaded && readError === null && <p className="team-loading">{copy.loading}</p>}
    {panel === null
      ? loaded && readError === null && cards.length === 0
        ? <p className="team-empty">{copy.empty}</p>
        : <TeamCards cards={cards} />
      : <TeamDetail {...props} panel={panel} />}
  </main>
}

/** A lista de trabalhos. */
export function TeamCards({ cards }: { readonly cards: readonly TeamCard[] }) {
  if (cards.length === 0) return null
  return <ul className="team-cards">
    {cards.map(card => <li key={card.team_id} className="team-card">
      <a href={`/studio/progresso/${card.team_id}`}>{card.name}</a>
      <span className={`team-status team-status-${card.status.toLowerCase()}`}>{label(copy.status, card.status)}</span>
      <span className="team-moment">{formatMoment(card.updated_at)}</span>
    </li>)}
  </ul>
}

/** O painel de um trabalho: cabeçalho, autorização, custo, etapas e a parada. */
export function TeamDetail({ panel, stopping, reason, onReason, onStop }: TeamViewProps & { readonly panel: TeamPanelData }) {
  const over = panel.status === 'COMPLETED' || panel.status === 'CANCELLED'
  return <article className="team-detail">
    <h2>{panel.name}</h2>
    <p className={`team-status team-status-${panel.status.toLowerCase()}`}>{label(copy.status, panel.status)}</p>
    {panel.diagnostic !== null && <p className="team-diagnostic">{panel.diagnostic}</p>}

    <section aria-labelledby="team-approval-title">
      <h3 id="team-approval-title">{copy.approvalTitle}</h3>
      <p>{copy.approvalBy.replace('{who}', panel.approved_by).replace('{when}', formatMoment(panel.approved_at))}</p>
      <p>{copy.tierLabel.replace('{tier}', panel.required_tier)}</p>
      {panel.sensitive_operation !== null
        && <p>{copy.sensitiveLabel.replace('{kind}', panel.sensitive_operation)}</p>}
    </section>

    <section aria-labelledby="team-cost-title">
      <h3 id="team-cost-title">{copy.costTitle}</h3>
      {/* O consumo é dito como está. Um total completo saído de uma soma pela
          metade seria a mentira mais cara desta tela, então o caso PARCIAL diz,
          com todas as letras, que o número é MENOR que o real. */}
      <TeamCostBlock cost={panel.cost} />
    </section>

    <section aria-labelledby="team-tasks-title">
      <h3 id="team-tasks-title">{copy.tasksTitle}</h3>
      <ol className="team-tasks">
        {orderedTasks(panel.tasks).map(({ task, depth }) => <TaskRow key={task.task_id} task={task} depth={depth} />)}
      </ol>
    </section>

    <section aria-labelledby="team-stop-title">
      <h3 id="team-stop-title">{copy.stop}</h3>
      <p>{copy.stopConfirm}</p>
      <label htmlFor="team-stop-reason">{copy.stopReasonLabel}</label>
      <input
        id="team-stop-reason" type="text" maxLength={500} value={reason}
        disabled={over || stopping}
        onChange={event => { onReason(event.target.value) }}
      />
      <button type="button" className="team-stop" onClick={onStop} disabled={over || stopping}>
        <OctagonX aria-hidden="true" />{stopping ? copy.stopping : copy.stop}
      </button>
    </section>

    <p><a href="/studio/progresso">{copy.backToList}</a></p>
  </article>
}

/** O consumo da equipe: medido, parcial, ou dito como não medido. */
export function TeamCostBlock({ cost }: { readonly cost: TeamCostData }) {
  if (cost.state === 'NOT_MEASURED') return <p className="team-cost">{cost.reason}</p>
  if (cost.state === 'MEASURED') {
    return <p className="team-cost">{copy.costMeasured
      .replace('{tokens}', cost.tokens.toLocaleString('pt-BR'))
      .replace('{measured}', String(cost.measured))}</p>
  }
  return <>
    <p className="team-cost team-cost-partial" role="alert">{copy.costPartial
      .replace('{tokens}', cost.tokens.toLocaleString('pt-BR'))
      .replace('{measured}', String(cost.measured))
      .replace('{total}', String(cost.total))}</p>
    <p className="team-cost">{cost.reason}</p>
  </>
}

/** Uma etapa, com o recuo que mostra de quem ela depende. */
export function TaskRow({ task, depth }: { readonly task: TeamTask, readonly depth: number }) {
  const icon = task.blocked
    ? <AlertTriangle aria-hidden="true" />
    : task.status === 'APPLIED' ? <CircleCheck aria-hidden="true" />
      : task.status === 'RUNNING' ? <Loader aria-hidden="true" /> : <CircleDashed aria-hidden="true" />
  return <li
    className={`team-task${task.blocked ? ' team-task-blocked' : ''}`}
    style={{ marginInlineStart: `${String(Math.min(depth, 6) * 1.25)}rem` }}
  >
    <p className="team-task-title">{icon}{task.title}</p>
    <p className="team-task-meta">
      <span className={`team-status team-status-${task.status.toLowerCase()}`}>{label(copy.taskStatus, task.status)}</span>
      <span className="team-task-role">{label(copy.role, task.role)}</span>
      <span className="team-task-cost">{task.cost.state === 'MEASURED'
        ? copy.costTaskMeasured.replace('{tokens}', task.cost.tokens.toLocaleString('pt-BR'))
        : copy.costTaskNotMeasured}</span>
    </p>
    <p className="team-task-depends">
      {task.depends_on.length === 0
        ? copy.dependsOnNone
        : copy.dependsOn.replace('{tasks}', task.depends_on.join(', '))}
    </p>
    {task.blocked && <p className="team-task-blocked-note" role="alert">{copy.blockedTitle}</p>}
    {task.diagnostic !== null && <p className="team-task-diagnostic">{task.diagnostic}</p>}
    {task.intended_paths.length > 0 && <details className="team-task-files">
      <summary><FileText aria-hidden="true" />{copy.filesTitle}</summary>
      <ul>{task.intended_paths.map(path => <li key={path}>{path}</li>)}</ul>
    </details>}
    <TaskEvidenceBlock task={task} />
  </li>
}

/** A evidência de uma etapa: o que ela mudou, ou por que não há o que mostrar. */
export function TaskEvidenceBlock({ task }: { readonly task: TeamTask }) {
  return <details className="team-task-evidence">
    <summary>{copy.evidenceTitle}</summary>
    {task.evidence.state === 'NOT_EXECUTED'
      ? <p>{copy.evidenceNotExecuted}</p>
      : <>
        <p>{copy.evidenceFiles
          .replace('{count}', String(task.evidence.changed_files.length))
          .replace('{bytes}', String(task.evidence.diff_bytes))}</p>
        <p>{copy.evidenceBase.replace('{commit}', task.evidence.base_commit)}</p>
        {task.evidence.main_changed_during_run && <p role="alert">{copy.evidenceMainChanged}</p>}
        <ul>{task.evidence.changed_files.map(file => <li key={file}>{file}</li>)}</ul>
      </>}
  </details>
}

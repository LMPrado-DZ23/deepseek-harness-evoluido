import { AlertTriangle, CircleCheck, CircleDashed, FileText, Loader, OctagonX } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import copy from '../i18n/team.pt-BR.json'
import { ConversationRequestError, type ConversationPort } from '../assistant/conversationApi'
import {
  TEAM_POLL_MS,
  listTeams,
  readTeam,
  readTeamTrace,
  stopTeam,
  teamIdFromPath,
  type TeamCard,
  type TeamCost as TeamCostData,
  type TeamPanel as TeamPanelData,
  type TeamTask,
  type TeamTrace as TeamTraceData,
} from './teamApi'
import './team.css'
import { assistantRequestAddress } from '../assistant/assistantRequest'

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
        ? <section className="team-empty">
          <p>{copy.empty}</p>
          {/* O painel mostrava TUDO sobre uma equipe e não tinha caminho
              nenhum para começar uma: quem chegava aqui sem equipe lia
              "nenhum trabalho foi iniciado" e ficava sem saber o que fazer
              com essa informação.
              O botão NÃO inicia — e isso é deliberado. Uma equipe é ancorada
              num agente vivo do Harness, que só existe dentro de uma chamada
              de ferramenta; uma rota HTTP teria de inventar esse dono, e
              inventar dono é pior que não ter botão. O que ele faz é levar à
              conversa, que tem o agente de verdade, com o pedido escrito. */}
          <p className="context-note">{copy.emptyHow}</p>
          <a className="primary team-empty-action" href={assistantRequestAddress(copy.emptyRequest)}>{copy.emptyAction}</a>
        </section>
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

    <section aria-labelledby="team-trace-title">
      <h3 id="team-trace-title">{copy.traceTitle}</h3>
      <TeamTraceSection teamId={panel.team_id} />
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

/**
 * Se abrir a seção deve mesmo disparar uma leitura.
 *
 * Função separada porque `<details>` dispara `toggle` ao ABRIR e ao FECHAR, e
 * porque quem já leu não precisa ler de novo. Sem esta conferência, cada abrir
 * e fechar da seção era uma ida à trilha inteira — que é o custo que a leitura
 * sob demanda existe para evitar.
 * @param jaTem - se a cadeia já foi lida.
 * @param lendo - se uma leitura está em andamento.
 * @returns se deve ler.
 */
export function shouldLoadTrace(jaTem: boolean, lendo: boolean): boolean {
  return !jaTem && !lendo
}

export type TeamTraceSectionProps = {
  readonly teamId: string
  readonly load?: (teamId: string) => Promise<TeamTraceData>
}

/**
 * A seção que lê a cadeia, e só quando alguém pede.
 *
 * A leitura é SOB DEMANDA de propósito: a trilha de política cresce com o uso,
 * e trazê-la em toda volta do laço de atualização faria o painel ficar mais
 * lento exatamente nas instalações que mais têm o que mostrar.
 *
 * A recusa do servidor é MOSTRADA. Uma instalação sem trilha montada recusa com
 * uma frase que diz isso — e trocá-la por uma lista vazia faria a tela afirmar
 * que nenhuma ferramenta foi usada.
 * @param props - o trabalho e de onde a cadeia vem.
 * @returns a seção.
 */
export function TeamTraceSection({ teamId, load = readTeamTrace }: TeamTraceSectionProps) {
  const [trace, setTrace] = useState<TeamTraceData | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const abrir = useCallback(() => {
    if (!shouldLoadTrace(trace !== null, loading)) return
    setLoading(true)
    setProblem(null)
    void load(teamId)
      .then(setTrace)
      .catch((error: unknown) => { setProblem(error instanceof Error ? error.message : copy.traceReadError) })
      .finally(() => { setLoading(false) })
  }, [load, teamId, trace, loading])

  return <details className="team-trace-section" onToggle={abrir}>
    <summary>{copy.traceOpen}</summary>
    {loading ? <p role="status">{copy.traceLoading}</p> : null}
    {problem !== null ? <p role="alert" className="error">{problem}</p> : null}
    {trace !== null ? <TeamTraceBlock trace={trace} /> : null}
  </details>
}

/**
 * Que ferramentas cada etapa usou, e o que a política decidiu em cada uma.
 *
 * A regra que atravessa este bloco: AUSÊNCIA DE ELO NÃO É AUSÊNCIA DE CHAMADA.
 * Uma etapa que rodou sem deixar a ligação com o registro fez chamadas que
 * ninguém consegue atribuir — e desenhar isso como "não usou ferramenta
 * nenhuma" descreveria como limpo justamente o caso em que a vigilância
 * falhou.
 *
 * O resumo de cima existe pelo mesmo motivo: quem percorre dez etapas não soma
 * de cabeça quantas ficaram sem ligação, e sem esse número a pessoa sai da tela
 * achando que leu o relato inteiro.
 * @param props - a cadeia já lida.
 * @returns o bloco.
 */
export function TeamTraceBlock({ trace }: { readonly trace: TeamTraceData }) {
  const rodaram = trace.tasks.filter(row => row.trace.link !== 'NOT_EXECUTED').length
  return <>
    {trace.unlinked_count > 0
      ? <p className="team-trace-gap" role="alert">{copy.traceUnlinkedSummary
        .replace('{count}', String(trace.unlinked_count))
        .replace('{total}', String(rodaram))}</p>
      : <p className="team-trace-complete">{copy.traceComplete}</p>}
    <p>{copy.traceHelp}</p>
    <ol className="team-trace">
      {trace.tasks.map(row => <li key={row.task_id} className="team-trace-task">
        <p className="team-trace-title">{row.title}</p>
        {row.trace.link === 'NOT_EXECUTED' ? <p>{copy.traceNotExecuted}</p> : null}
        {row.trace.link === 'UNLINKED' ? <p role="alert" className="team-trace-gap">{copy.traceUnlinked}</p> : null}
        {row.trace.link === 'LINKED' && row.trace.calls.length === 0 ? <p>{copy.traceEmpty}</p> : null}
        {row.trace.calls.length > 0 ? <ul className="team-trace-calls">
          {row.trace.calls.map(call => <li key={call.call_id}>
            <span className="team-trace-tool">{call.tool_name}</span>
            <span className={`team-trace-decision team-trace-${call.decision}`}>
              {label(copy.traceDecision, call.decision)}
            </span>
            <span className="team-trace-when">{formatMoment(call.at)}</span>
            <span className="team-trace-reason">{call.reason}</span>
            {/* Uma entrada sem selo é dita como tal. Omitir a distinção faria
                uma linha inauditável parecer auditada. */}
            {call.sealed ? null : <span className="team-trace-unsealed">{copy.traceUnsealed}</span>}
          </li>)}
        </ul> : null}
      </li>)}
    </ol>
  </>
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

/**
 * Por que uma etapa parada nunca vai andar.
 *
 * Duas frases porque são dois gestos diferentes: dependência que não existe é
 * erro de plano, e alguém precisa corrigir o plano; dependência que terminou
 * mal é trabalho a refazer. Uma frase só para os dois casos deixaria a pessoa
 * sem saber o que fazer em metade das vezes — e "não vai andar" sem próximo
 * passo é só uma má notícia.
 * @param block - o bloqueio vindo do servidor.
 * @returns a frase em pt-BR, com as dependências culpadas.
 */
function dependencyBlockSentence(block: { readonly reason: string; readonly dependencies: readonly string[] }): string {
  const template = block.reason === 'MISSING_DEPENDENCY' ? copy.dependencyBlockMissing : copy.dependencyBlockFailed
  return template.replace('{tasks}', block.dependencies.join(', '))
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
    {task.dependency_block !== null && <p className="team-task-blocked-note" role="alert">{dependencyBlockSentence(task.dependency_block)}</p>}
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

import { useEffect, useState } from 'react'
import copy from '../i18n/mission.pt-BR.json'
import {
  completeMission, createMission, declareCandidate, listMissions, recordCriterion, slugify, uniqueSlug,
  type CriterionPatch, type CriterionState, type MissionCompletion, type MissionCriterion,
  type MissionDraft, type MissionSpend, type MissionView,
} from './missionApi'
import './mission.css'

/**
 * A frase do gasto, com os números já no lugar.
 *
 * `UNMEASURED` nomeia o trabalho que não foi medido, e não diz só "não deu".
 * Uma frase que descreve um impedimento sem dizer o que olhar não é
 * informação — é um aviso que a pessoa não consegue usar.
 * @param spend - o gasto devolvido pelo servidor.
 * @returns a frase.
 */
export function spendLabel(spend: MissionSpend): string {
  switch (spend.kind) {
    case 'NO_LIMIT': return copy.spend.NO_LIMIT
    case 'WITHIN': return copy.spend.WITHIN.replace('{spent}', String(spend.spent)).replace('{limit}', String(spend.limit))
    case 'EXCEEDED': return copy.spend.EXCEEDED.replace('{spent}', String(spend.spent)).replace('{limit}', String(spend.limit))
    case 'UNMEASURED': return copy.spend.UNMEASURED.replace('{run}', spend.runId)
  }
}

/**
 * A frase de quantos trabalhos estão ligados ao objetivo.
 * @param count - quantos.
 * @returns a frase, no singular ou no plural certo.
 */
export function runCountLabel(count: number): string {
  if (count === 0) return copy.runCount.zero
  if (count === 1) return copy.runCount.one
  return copy.runCount.many.replace('{count}', String(count))
}

/** A frase do veredito de conclusão. */
export function completionLabel(completion: MissionCompletion): string {
  return copy.completion[completion.kind]
}

/**
 * Encerrar só faz sentido depois de marcar como terminado.
 *
 * E marcar como terminado só faz sentido enquanto está em andamento. A tela
 * NÃO esconde o botão de encerrar quando os itens ainda não estão comprovados:
 * o servidor recusa e diz quais faltam, e esconder o botão trocaria uma recusa
 * explicada por um botão que sumiu sem motivo visível.
 * @param mission - o objetivo.
 * @returns quais gestos cabem agora.
 */
export function availableActions(mission: MissionView): { readonly candidate: boolean; readonly complete: boolean } {
  return {
    candidate: mission.status === 'RUNNING',
    complete: mission.status === 'CANDIDATE_COMPLETED',
  }
}

/**
 * Qual campo de texto o estado escolhido EXIGE, se algum.
 *
 * `PROVEN` exige a prova e `BLOCKED_EXTERNAL` exige o motivo — e o servidor
 * recusa nos DOIS sentidos: prova sem estar comprovado também é recusada. Então
 * a tela troca o campo junto com o estado, em vez de mostrar os dois e deixar a
 * pessoa preencher o errado.
 * @param state - o estado escolhido.
 * @returns qual campo, ou nenhum.
 */
export function fieldFor(state: CriterionState): 'evidence' | 'blocked' | 'none' {
  if (state === 'PROVEN') return 'evidence'
  if (state === 'BLOCKED_EXTERNAL') return 'blocked'
  return 'none'
}

export type PatchResult =
  | { readonly ok: true; readonly patch: CriterionPatch }
  | { readonly ok: false; readonly problem: string }

/**
 * Monta o registro de um item, ou diz o que falta.
 *
 * Quando o estado não exige texto, o campo correspondente vai como `null`
 * EXPLÍCITO, e não omitido: registrar "ainda sem prova" precisa LIMPAR a prova
 * anterior. Omitir o campo deixaria na tela um item sem prova com "Onde está a
 * prova: …" logo abaixo — o mesmo verde artificial, entrando pela outra metade
 * do par.
 * @param state - o estado escolhido.
 * @param text - o que foi escrito no campo.
 * @returns o registro, ou o problema.
 */
export function buildPatch(state: CriterionState, text: string): PatchResult {
  const escrito = text.trim()
  const campo = fieldFor(state)
  if (campo === 'evidence') {
    if (escrito === '') return { ok: false, problem: copy.evidenceRequired }
    return { ok: true, patch: { state, evidence: escrito, blocked_reason: null } }
  }
  if (campo === 'blocked') {
    if (escrito === '') return { ok: false, problem: copy.blockedRequired }
    return { ok: true, patch: { state, blocked_reason: escrito, evidence: null } }
  }
  return { ok: true, patch: { state, evidence: null, blocked_reason: null } }
}

export type DraftResult =
  | { readonly ok: true; readonly draft: MissionDraft }
  | { readonly ok: false; readonly problem: string }

/**
 * Transforma o que a pessoa escreveu num rascunho, ou diz o que falta.
 *
 * Função PURA, fora do componente, porque é aqui que moram as decisões que
 * podem errar em silêncio: o identificador derivado da frase, o limite que
 * precisa ser inteiro, e o item vazio que o servidor recusaria depois de uma
 * ida de rede.
 *
 * O que ela NÃO faz é repetir a validação do servidor. Ela impede o envio
 * obviamente vazio; tudo o mais é recusado lá e a frase de lá é mostrada.
 * @param objective - a meta escrita.
 * @param statements - os itens a comprovar, como foram escritos.
 * @param limit - o limite escrito, ou string vazia.
 * @param taken - os identificadores que a tela já conhece.
 * @returns o rascunho, ou o problema.
 */
export function buildDraft(
  objective: string, statements: readonly string[], limit: string, taken: readonly string[],
): DraftResult {
  const meta = objective.trim()
  if (meta.length < 3) return { ok: false, problem: copy.objectiveTooShort }
  const escritos = statements.map(item => item.trim()).filter(item => item !== '')
  if (escritos.length === 0) return { ok: false, problem: copy.noCriteria }
  if (escritos.some(item => item.length < 3)) return { ok: false, problem: copy.criterionTooShort }

  const missionId = uniqueSlug(slugify(meta), taken)
  // Frase sem letra nem número nenhum — só emoji, só pontuação — não vira
  // identificador. Inventar um aleatório aqui esconderia o caso: a pessoa
  // veria um objetivo com um nome que ela não escreveu.
  if (missionId === '') return { ok: false, problem: copy.slugImpossible }

  const cru = limit.trim()
  let maxTotalTokens: number | null = null
  if (cru !== '') {
    const numero = Number(cru)
    // `Number('')` é 0 e `Number(' 12 ')` é 12: a string vazia já saiu acima, e
    // o resto tem de ser inteiro positivo. Um limite de zero seria um objetivo
    // que nasce estourado.
    if (!Number.isInteger(numero) || numero <= 0) return { ok: false, problem: copy.limitNotWhole }
    maxTotalTokens = numero
  }

  // Os identificadores dos ITENS também são derivados, e precisam ser distintos
  // entre si: o esquema do servidor recusa item repetido, e dois itens escritos
  // com a mesma frase produziriam a mesma chave.
  const usados: string[] = []
  const criteria = escritos.map((statement, index) => {
    const base = slugify(statement)
    const id = uniqueSlug(base === '' ? `item-${String(index + 1)}` : base, usados)
    usados.push(id)
    return { criterion_id: id, statement }
  })
  return { ok: true, draft: { missionId, objective: meta, maxTotalTokens, criteria } }
}

/**
 * A lista de objetivos.
 *
 * Um objetivo reúne trabalhos diferentes sob a mesma meta e carrega a lista do
 * que precisa estar comprovado antes de ser dado por encerrado. A tela mostra
 * os dois gestos SEPARADOS — marcar como terminado e encerrar — porque no
 * produto eles são coisas diferentes: o primeiro é a pessoa dizendo que
 * acredita ter acabado, o segundo é a conferência item a item.
 * @returns a tela.
 */
export function MissionScreen() {
  const [rows, setRows] = useState<readonly MissionView[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setFailed(false)
    void listMissions(undefined, controller.signal)
      .then(missions => { if (!controller.signal.aborted) setRows(missions) })
      .catch(() => { if (!controller.signal.aborted) { setRows(null); setFailed(true) } })
    return () => { controller.abort() }
  }, [attempt])

  const act = (missionId: string, run: () => Promise<MissionView>) => {
    setBusy(missionId)
    setProblem(null)
    void run()
      .then(updated => { setRows(current => (current ?? []).map(row => row.mission_id === updated.mission_id ? updated : row)) })
      // A recusa do servidor é MOSTRADA, e não engolida: é nela que está escrito
      // qual item ainda falta comprovar, e é a única coisa acionável aqui.
      .catch((error: unknown) => { setProblem(error instanceof Error ? error.message : copy.completeError) })
      .finally(() => { setBusy(null) })
  }

  return <main className="missions">
    <div className="heading"><div><h1>{copy.title}</h1><p>{copy.subtitle}</p></div></div>

    {failed ? <section className="task-card">
      <p role="alert">{copy.failed}</p>
      <button type="button" className="primary" onClick={() => setAttempt(value => value + 1)}>{copy.retry}</button>
    </section> : null}

    {!failed && rows === null ? <p role="status">{copy.loading}</p> : null}

    {rows !== null && rows.length === 0 ? <section className="task-card">
      <p>{copy.empty}</p>
      <p>{copy.emptyHelp}</p>
    </section> : null}

    {problem !== null ? <p role="alert" className="mission-problem">{problem}</p> : null}

    {/* O formulário fica ACIMA da lista e aparece assim que a leitura volta,
        inclusive quando ela volta vazia: numa conta nova, a primeira coisa a
        fazer é criar, e um formulário escondido atrás de um botão faria a tela
        vazia não oferecer nada. */}
    {rows !== null ? <MissionForm
      taken={rows.map(row => row.mission_id)}
      onCreate={async draft => {
        const criada = await createMission(draft)
        setRows(current => [criada, ...(current ?? [])])
      }}
    /> : null}

    {rows !== null && rows.map(mission => <MissionCard
      key={mission.mission_id}
      mission={mission}
      busy={busy === mission.mission_id}
      onCandidate={() => { act(mission.mission_id, async () => declareCandidate(mission.mission_id)) }}
      onComplete={() => { act(mission.mission_id, async () => completeMission(mission.mission_id)) }}
      onRecord={async (criterionId, patch) => {
        const atualizada = await recordCriterion(mission.mission_id, criterionId, patch)
        setRows(current => (current ?? []).map(row => row.mission_id === atualizada.mission_id ? atualizada : row))
      }}
    />)}
  </main>
}

export type MissionFormProps = {
  readonly taken: readonly string[]
  readonly onCreate: (draft: MissionDraft) => Promise<void>
}

/**
 * O formulário que cria um objetivo.
 *
 * A lista de itens a comprovar nasce com UM campo, e não com zero: um
 * formulário que abre vazio faz a pessoa descobrir sozinha que precisa
 * acrescentar algo antes de poder enviar.
 *
 * O identificador técnico NÃO aparece: ele é derivado da meta. Pedir uma chave
 * a quem está escrevendo uma meta é pedir que ela conheça o banco de dados.
 * @param props - os identificadores já em uso e o que fazer com o rascunho.
 * @returns o formulário.
 */
export function MissionForm(props: MissionFormProps) {
  const [objective, setObjective] = useState('')
  const [statements, setStatements] = useState<readonly string[]>([''])
  const [limit, setLimit] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  const submit = (event: { preventDefault: () => void }) => {
    event.preventDefault()
    const result = buildDraft(objective, statements, limit, props.taken)
    if (!result.ok) { setProblem(result.problem); return }
    setProblem(null)
    setSending(true)
    void props.onCreate(result.draft)
      .then(() => { setObjective(''); setStatements(['']); setLimit('') })
      // A recusa do SERVIDOR é mostrada como veio. Ela sabe coisas que a tela
      // não sabe — um objetivo com o mesmo nome criado por outra pessoa, por
      // exemplo — e trocá-la por uma frase genérica apagaria justamente isso.
      .catch((error: unknown) => { setProblem(error instanceof Error ? error.message : copy.createError) })
      .finally(() => { setSending(false) })
  }

  return <form className="task-card mission-form" onSubmit={submit}>
    <h2>{copy.createTitle}</h2>
    <p>{copy.createHelp}</p>

    <label htmlFor="mission-objective">{copy.objectiveLabel}</label>
    <input id="mission-objective" type="text" value={objective} placeholder={copy.objectivePlaceholder}
      onChange={event => { setObjective(event.target.value) }} />

    <fieldset className="mission-criteria-fields">
      <legend>{copy.criteriaLabel}</legend>
      {statements.map((statement, index) => <div key={index} className="mission-criterion-field">
        <label htmlFor={`mission-criterion-${String(index)}`} className="sr-only">
          {copy.criteriaLabel} {index + 1}
        </label>
        <input id={`mission-criterion-${String(index)}`} type="text" value={statement}
          placeholder={copy.criterionPlaceholder}
          onChange={event => {
            const valor = event.target.value
            setStatements(current => current.map((item, position) => position === index ? valor : item))
          }} />
        {/* O botão de tirar só aparece quando há mais de um: com um só, tirar
            deixaria o formulário num estado que o envio recusa. */}
        {statements.length > 1 ? <button type="button" className="secondary"
          onClick={() => { setStatements(current => current.filter((_, position) => position !== index)) }}>
          {copy.removeCriterion}
        </button> : null}
      </div>)}
      <button type="button" className="secondary"
        onClick={() => { setStatements(current => [...current, '']) }}>{copy.addCriterion}</button>
    </fieldset>

    <label htmlFor="mission-limit">{copy.limitLabel}</label>
    <input id="mission-limit" type="text" inputMode="numeric" value={limit}
      aria-describedby="mission-limit-help"
      onChange={event => { setLimit(event.target.value) }} />
    <p id="mission-limit-help" className="mission-help">{copy.limitHelp}</p>

    {problem !== null ? <p role="alert" className="mission-problem">{problem}</p> : null}
    <button type="submit" className="primary" disabled={sending}>{copy.submit}</button>
  </form>
}

export type CriterionEditorProps = {
  readonly missionId: string
  readonly criterion: MissionCriterion
  readonly onRecord: (patch: CriterionPatch) => Promise<void>
}

/**
 * O registro de UM item, embaixo do próprio item.
 *
 * O campo de texto TROCA com o estado escolhido, porque o servidor recusa nos
 * dois sentidos: prova num item que não está comprovado é recusada do mesmo
 * jeito que um item comprovado sem prova. Mostrar os dois campos convidaria a
 * pessoa a preencher aquele que vai ser recusado.
 * @param props - o objetivo, o item e o que fazer com o registro.
 * @returns o editor.
 */
export function CriterionEditor(props: CriterionEditorProps) {
  const { criterion } = props
  const [state, setState] = useState<CriterionState>(criterion.state)
  const [text, setText] = useState(criterion.evidence ?? criterion.blocked_reason ?? '')
  const [problem, setProblem] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const campo = fieldFor(state)
  const idBase = `criterion-${props.missionId}-${criterion.criterion_id}`

  const submit = (event: { preventDefault: () => void }) => {
    event.preventDefault()
    const result = buildPatch(state, text)
    if (!result.ok) { setProblem(result.problem); return }
    setProblem(null)
    setSending(true)
    void props.onRecord(result.patch)
      .catch((error: unknown) => { setProblem(error instanceof Error ? error.message : copy.criterionError) })
      .finally(() => { setSending(false) })
  }

  return <form className="mission-record" onSubmit={submit}>
    <label htmlFor={`${idBase}-state`}>{copy.recordState}</label>
    <select id={`${idBase}-state`} value={state}
      onChange={event => { setState(event.target.value as CriterionState) }}>
      {(['UNPROVEN', 'PROVEN', 'BLOCKED_EXTERNAL', 'REFUTED'] as const).map(option =>
        <option key={option} value={option}>{copy.criterion[option]}</option>)}
    </select>

    {campo !== 'none' ? <>
      <label htmlFor={`${idBase}-text`}>
        {campo === 'evidence' ? copy.evidenceField : copy.blockedField}
      </label>
      <input id={`${idBase}-text`} type="text" value={text}
        placeholder={campo === 'evidence' ? copy.evidencePlaceholder : copy.blockedPlaceholder}
        onChange={event => { setText(event.target.value) }} />
    </> : null}

    {problem !== null ? <p role="alert" className="mission-problem">{problem}</p> : null}
    <button type="submit" className="secondary" disabled={sending}>{copy.recordSubmit}</button>
  </form>
}

export type MissionCardProps = {
  readonly mission: MissionView
  readonly busy: boolean
  readonly onCandidate: () => void
  readonly onComplete: () => void
  readonly onRecord: (criterionId: string, patch: CriterionPatch) => Promise<void>
}

/**
 * Um objetivo desenhado.
 *
 * Separado do componente de tela por uma razão de PROVA: a tela busca dados num
 * efeito, e `renderToStaticMarkup` não roda efeitos — enquanto o corpo da lista
 * morava lá dentro, o único ramo que algum teste alcançava era o de
 * carregamento. Tudo o que importa aqui (a prova, o motivo do bloqueio, quais
 * botões aparecem) não era exercido por teste nenhum.
 * @param props - o objetivo e os dois gestos.
 * @returns o cartão.
 */
export function MissionCard(props: MissionCardProps) {
  const { mission } = props
  const actions = availableActions(mission)
  return <section className="task-card mission-card">
    <div className="mission-line">
      <strong>{mission.objective}</strong>
      <span className="mission-status">{copy.status[mission.status]}</span>
    </div>
    <p className="mission-verdict">{completionLabel(mission.completion)}</p>
    <p className="mission-spend">{spendLabel(mission.spend)}</p>
    <p className="mission-runs">{runCountLabel(mission.run_count)}</p>

    <h2 className="mission-checklist-title">{copy.checklist}</h2>
    <ul className="mission-checklist">
      {mission.criteria.map(criterion => <li key={criterion.criterion_id}>
        <div className="mission-line">
          <span>{criterion.statement}</span>
          <span className="mission-criterion-state">{copy.criterion[criterion.state]}</span>
        </div>
        {/* A prova aparece na tela. Um item que se diz comprovado sem mostrar
            ONDE está a prova é a mesma coisa que não estar comprovado — e o
            servidor já recusa gravar assim, nos dois sentidos. */}
        {criterion.evidence !== null ? <p className="mission-evidence">{copy.evidenceLabel}: {criterion.evidence}</p> : null}
        {criterion.blocked_reason !== null ? <p className="mission-blocked">{copy.blockedLabel}: {criterion.blocked_reason}</p> : null}
        {/* Registrar só aparece enquanto o objetivo não foi encerrado: o
            servidor recusa mexer num objetivo encerrado, e um campo que existe
            para ser recusado é pior do que um campo que não existe. */}
        {mission.status === 'COMPLETED' ? null : <CriterionEditor
          missionId={mission.mission_id}
          criterion={criterion}
          onRecord={async patch => props.onRecord(criterion.criterion_id, patch)}
        />}
      </li>)}
    </ul>

    {actions.candidate ? <button type="button" className="secondary" disabled={props.busy}
      onClick={props.onCandidate}>{copy.declareCandidate}</button> : null}
    {actions.complete ? <button type="button" className="primary" disabled={props.busy}
      onClick={props.onComplete}>{copy.complete}</button> : null}
    {actions.candidate ? <p className="mission-help">{copy.candidateHelp}</p> : null}
  </section>
}

import { useEffect, useState } from 'react'
import copy from '../i18n/mission.pt-BR.json'
import {
  completeMission, declareCandidate, listMissions,
  type MissionCompletion, type MissionSpend, type MissionView,
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

    {rows !== null && rows.map(mission => {
      const actions = availableActions(mission)
      return <section className="task-card mission-card" key={mission.mission_id}>
        <div className="mission-line">
          <strong>{mission.objective}</strong>
          <span className="mission-status">{copy.status[mission.status]}</span>
        </div>
        <p className="mission-verdict">{completionLabel(mission.completion)}</p>
        <p className="mission-spend">{spendLabel(mission.spend)}</p>
        <p className="mission-runs">{runCountLabel(mission.run_ids.length)}</p>

        <h2 className="mission-checklist-title">{copy.checklist}</h2>
        <ul className="mission-checklist">
          {mission.criteria.map(criterion => <li key={criterion.criterion_id}>
            <div className="mission-line">
              <span>{criterion.statement}</span>
              <span className="mission-criterion-state">{copy.criterion[criterion.state]}</span>
            </div>
            {/* A prova aparece na tela. Um item que se diz comprovado sem
                mostrar ONDE está a prova é a mesma coisa que não estar
                comprovado — e o servidor já recusa gravar assim. */}
            {criterion.evidence !== null ? <p className="mission-evidence">{copy.evidenceLabel}: {criterion.evidence}</p> : null}
            {criterion.blocked_reason !== null ? <p className="mission-blocked">{copy.blockedLabel}: {criterion.blocked_reason}</p> : null}
          </li>)}
        </ul>

        {actions.candidate ? <button type="button" className="secondary" disabled={busy === mission.mission_id}
          onClick={() => { act(mission.mission_id, async () => declareCandidate(mission.mission_id)) }}>{copy.declareCandidate}</button> : null}
        {actions.complete ? <button type="button" className="primary" disabled={busy === mission.mission_id}
          onClick={() => { act(mission.mission_id, async () => completeMission(mission.mission_id)) }}>{copy.complete}</button> : null}
        {actions.candidate ? <p className="mission-help">{copy.candidateHelp}</p> : null}
      </section>
    })}
  </main>
}

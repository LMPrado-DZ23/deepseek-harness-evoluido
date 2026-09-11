import { PendingButton } from './PendingButton'
import { CircleAlert, CircleCheck, CircleDashed, LoaderCircle } from 'lucide-react'
import t from './i18n/pt-BR.json'
import { undoAvailable, type ProjectUiState } from './presentation'

export type RunStageState = 'passed' | 'failed' | 'running' | 'not-run'

export interface RunStage {
  readonly step: string
  readonly label: string
  readonly state: RunStageState
  readonly detail: string
}

export interface RunFile {
  readonly path: string
  readonly lines: number
  readonly bytes: number
  readonly author: 'model' | 'studio'
  readonly change: 'added' | 'changed' | 'unchanged'
}

export interface RunReportValue {
  readonly stages: readonly RunStage[]
  readonly files: readonly RunFile[]
  readonly findings: readonly string[]
  readonly correction: string | null
  readonly attempt: number
}

/**
 * Aceita só o formato que o servidor promete.
 *
 * Desenhar meia etapa mostraria à pessoa algo que o servidor nunca disse — e
 * esta é a tela que existe para ela ENTENDER o que aconteceu.
 * @param value - o corpo devolvido pela rota.
 * @returns se é um relato utilizável.
 */
export function isRunReport(value: unknown): value is RunReportValue {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.stages) || !Array.isArray(record.files) || !Array.isArray(record.findings)) return false
  if (typeof record.attempt !== 'number') return false
  if (record.correction !== null && typeof record.correction !== 'string') return false
  return record.stages.every(stage => typeof stage === 'object' && stage !== null
    && typeof (stage as RunStage).label === 'string'
    && ['passed', 'failed', 'running', 'not-run'].includes((stage as RunStage).state))
}

function stageIcon(state: RunStageState) {
  if (state === 'passed') return <CircleCheck aria-hidden="true" />
  if (state === 'failed') return <CircleAlert aria-hidden="true" />
  if (state === 'running') return <LoaderCircle aria-hidden="true" />
  return <CircleDashed aria-hidden="true" />
}

function stageWord(state: RunStageState): string {
  if (state === 'passed') return t.report.statePassed
  if (state === 'failed') return t.report.stateFailed
  if (state === 'running') return t.report.stateRunning
  return t.report.stateNotRun
}

function changeWord(change: RunFile['change']): string {
  if (change === 'added') return t.report.changeAdded
  if (change === 'changed') return t.report.changeChanged
  return t.report.changeUnchanged
}

/**
 * O que aconteceu na criação, em português, com o técnico atrás de um clique.
 *
 * Antes disto a criação era uma caixa preta: o registro do processo era gravado
 * como evidência e nunca mostrado, e a pessoa terminava com um código em inglês.
 * @param props - o relato do servidor.
 * @returns a seção da tela.
 */
export function RunReport({ report }: { readonly report: RunReportValue }) {
  return <section className="run-report" aria-labelledby="run-report-title">
    <h2 id="run-report-title">{t.report.title}</h2>
    {report.attempt > 1 ? <p className="context-note">{t.report.attempt} {report.attempt}</p> : null}
    <ol className="run-stages">
      {report.stages.map(stage => <li key={stage.step} className={`run-stage ${stage.state}`}>
        <div className="run-stage-head">
          {stageIcon(stage.state)}
          <strong>{stage.label}</strong>
          <span className="run-stage-word">{stageWord(stage.state)}</span>
        </div>
        {stage.detail === '' ? null : <details>
          <summary>{t.report.technical}</summary>
          <pre dir="ltr">{stage.detail}</pre>
        </details>}
      </li>)}
    </ol>

    {report.correction === null ? null : <section className="run-correction">
      <h3>{t.report.correctionTitle}</h3>
      <p className="context-note">{t.report.correctionHelp}</p>
      {/* O diagnóstico cru do pipeline (`build: exit 1`,
          `TEMPLATE_INTEGRITY_FAILED`) vinha aberto, em inglês, na seção que
          aparece justamente quando algo deu errado. Ele continua inteiro —
          atrás do mesmo `<details>` fechado que o resto do relato usa. */}
      <details><summary>{t.report.correctionTechnical}</summary><pre dir="ltr">{report.correction}</pre></details>
    </section>}

    {report.findings.length === 0 ? null : <section className="run-findings">
      <h3>{t.report.findingsTitle}</h3>
      <p className="context-note">{t.report.findingsHelp}</p>
      <ul>{report.findings.map(finding => <li key={finding}>{findingSentence(finding)}</li>)}</ul>
      <details><summary>{t.report.findingTechnical}</summary>
        <ul>{report.findings.map(finding => <li key={finding}><code dir="ltr">{finding}</code></li>)}</ul>
      </details>
    </section>}

    <h3>{t.report.filesTitle}</h3>
    {report.files.length === 0
      ? <p className="context-note">{t.report.filesEmpty}</p>
      : <><p className="context-note">{t.report.filesHelp}</p>
        <ul className="run-files">{report.files.map(file => <li key={file.path}>
          <code dir="ltr">{file.path}</code>
          <span className="run-file-meta">
            {file.lines} {t.report.lines} · {file.author === 'model' ? t.report.authorModel : t.report.authorStudio} · {changeWord(file.change)}
          </span>
        </li>)}</ul></>}
  </section>
}

/** Por que uma tentativa não é um ponto seguro, do jeito que o servidor responde. */
export type CheckpointBlocker =
  | 'ACCEPTANCE_ATTESTATION_UNAVAILABLE'
  | 'TEMPLATE_INTEGRITY_FAILED'
  | 'INTEGRITY_NOT_RECORDED'
  | 'STEPS_DID_NOT_PASS'

export interface CheckpointValue {
  readonly run_id: string
  readonly attempt: number
  readonly created_at: string
  readonly run_directory: string
  readonly tree_sha256: string | null
  readonly acceptance_checks: ReadonlyArray<{ readonly id: string; readonly label: string; readonly status: string }>
  readonly integrity: 'VERIFIED' | 'FAILED' | 'UNKNOWN'
  readonly green: boolean
  readonly blocker: CheckpointBlocker | null
}

export interface CheckpointListValue {
  readonly checkpoints: readonly CheckpointValue[]
  readonly green_run_id: string | null
  readonly reason: CheckpointBlocker | 'NO_ATTEMPT' | null
  readonly current_run_id: string | null
}

const BLOCKERS = ['ACCEPTANCE_ATTESTATION_UNAVAILABLE', 'TEMPLATE_INTEGRITY_FAILED', 'INTEGRITY_NOT_RECORDED', 'STEPS_DID_NOT_PASS']

/**
 * Aceita só o formato que o servidor promete.
 *
 * Um ponto de retorno desenhado a partir de um corpo que o servidor não disse
 * seria pior do que nenhum: a pessoa clicaria em "voltar" confiando em um verde
 * que ninguém provou.
 * @param value - o corpo devolvido pela rota.
 * @returns se é uma lista de pontos utilizável.
 */
export function isCheckpointList(value: unknown): value is CheckpointListValue {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.checkpoints)) return false
  if (record.green_run_id !== null && typeof record.green_run_id !== 'string') return false
  if (record.current_run_id !== null && typeof record.current_run_id !== 'string') return false
  if (record.reason !== null && !(typeof record.reason === 'string' && [...BLOCKERS, 'NO_ATTEMPT'].includes(record.reason))) return false
  return record.checkpoints.every(entry => typeof entry === 'object' && entry !== null
    && typeof (entry as CheckpointValue).run_id === 'string'
    && typeof (entry as CheckpointValue).attempt === 'number'
    && typeof (entry as CheckpointValue).green === 'boolean'
    && ['VERIFIED', 'FAILED', 'UNKNOWN'].includes((entry as CheckpointValue).integrity)
    && ((entry as CheckpointValue).blocker === null || BLOCKERS.includes(String((entry as CheckpointValue).blocker))))
}

/**
 * A frase que explica por que não há ponto seguro.
 *
 * Cada motivo tem a sua: um "não há para onde voltar" sem o porquê devolveria a
 * pessoa à caixa preta. Hoje o motivo real é a atestação de aceite que ainda não
 * existe, e a frase diz isso sem jargão.
 * @param reason - o motivo devolvido pelo servidor.
 * @returns a frase para a pessoa.
 */
export function noCheckpointSentence(reason: CheckpointListValue['reason']): string {
  if (reason === 'ACCEPTANCE_ATTESTATION_UNAVAILABLE') return t.checkpoint.reasonAttestation
  if (reason === 'TEMPLATE_INTEGRITY_FAILED') return t.checkpoint.reasonIntegrityFailed
  if (reason === 'INTEGRITY_NOT_RECORDED') return t.checkpoint.reasonIntegrityUnknown
  if (reason === 'STEPS_DID_NOT_PASS') return t.checkpoint.reasonSteps
  return t.checkpoint.reasonNoAttempt
}

function integrityWord(integrity: CheckpointValue['integrity']): string {
  if (integrity === 'VERIFIED') return t.checkpoint.integrityVerified
  if (integrity === 'FAILED') return t.checkpoint.integrityFailed
  return t.checkpoint.integrityUnknown
}

/**
 * Para onde a pessoa pode voltar, o que cada ponto significa, e o que acontece com o resto.
 *
 * A confirmação é CONTROLADA de fora de propósito: quem desfaz precisa ler antes
 * o que o desfazer faz e o que ele não faz — e o que ele não faz é apagar. O
 * botão de recomeçar fica ao lado porque, depois de uma falha, essas são as duas
 * saídas honestas.
 * @param props - a lista do servidor, o que está sendo confirmado e as ações.
 * @returns a seção da tela.
 */
/**
 * Por que voltar não está disponível agora.
 *
 * Duas razões diferentes, e elas pedem gestos diferentes: durante a criação a
 * pessoa precisa PARAR antes; antes de qualquer tentativa não há o que fazer
 * além de criar. Uma frase só para os dois casos mandaria metade das pessoas
 * procurar um botão que não existe.
 * @param state - o estado atual do projeto.
 * @returns a frase em pt-BR.
 */
function unavailableSentence(state: ProjectUiState | null): string {
  if (state === 'GENERATING' || state === 'BUILD_OK' || state === 'TESTS_OK') return t.checkpoint.undoUnavailableWhileRunning
  return t.checkpoint.undoUnavailableBeforeAttempt
}

export function Checkpoints(props: {
  readonly list: CheckpointListValue
  /**
   * O estado do projeto decide se voltar é uma operação POSSÍVEL — ver
   * `undoAvailable`. Sem isto, o botão aparecia para toda tentativa verde,
   * inclusive durante a criação, e a recusa só chegava depois de confirmar.
   */
  readonly projectState: ProjectUiState | null
  readonly confirmingRunId: string | null
  readonly askConfirm: (runId: string) => void
  readonly cancelConfirm: () => void
  readonly undo: (runId: string) => void
  readonly restart?: () => void
}) {
  const { list } = props
  const canUndo = undoAvailable(props.projectState)
  return <section className="run-checkpoints" aria-labelledby="run-checkpoints-title">
    <h2 id="run-checkpoints-title">{t.checkpoint.title}</h2>
    <p className="context-note">{t.checkpoint.help}</p>
    {list.green_run_id === null ? <section className="checkpoint-none">
      <h3>{t.checkpoint.noneTitle}</h3>
      <p>{noCheckpointSentence(list.reason)}</p>
    </section> : null}
    {list.checkpoints.length === 0 ? null : <ul className="checkpoint-list">
      {list.checkpoints.map(checkpoint => <li key={checkpoint.run_id} className={checkpoint.green ? 'checkpoint green' : 'checkpoint'}>
        <div className="checkpoint-head">
          <strong>{t.checkpoint.attempt} {checkpoint.attempt}</strong>
          <span className="checkpoint-word">{checkpoint.green ? t.checkpoint.safe : t.checkpoint.unsafe}</span>
          {checkpoint.run_id === list.current_run_id ? <span className="checkpoint-current">{t.checkpoint.current}</span> : null}
        </div>
        <p className="context-note">
          {integrityWord(checkpoint.integrity)} · {criteriaSentence(checkpoint.acceptance_checks)}
        </p>
        {checkpoint.green ? null : <p className="context-note">{noCheckpointSentence(checkpoint.blocker)}</p>}
        <p className="context-note">{t.checkpoint.kept}</p>
        {checkpoint.green && !canUndo ? <p className="context-note">{unavailableSentence(props.projectState)}</p> : null}
        {canUndo && checkpoint.green && props.confirmingRunId !== checkpoint.run_id
          ? <button type="button" className="secondary compact" onClick={() => props.askConfirm(checkpoint.run_id)}>{t.checkpoint.undo}</button>
          : null}
        {canUndo && checkpoint.green && props.confirmingRunId === checkpoint.run_id ? <section className="checkpoint-confirm">
          <h4>{t.checkpoint.confirmTitle}</h4>
          <p>{t.checkpoint.confirmBody}</p>
          <PendingButton label={t.checkpoint.confirm} busyLabel={t.checkpoint.confirmBusy} action={async () => { await props.undo(checkpoint.run_id) }} />
          <button type="button" className="secondary compact" onClick={() => props.cancelConfirm()}>{t.checkpoint.cancel}</button>
        </section> : null}
      </li>)}
    </ul>}
    {props.restart === undefined ? null : <section className="checkpoint-restart">
      <h3>{t.checkpoint.restartTitle}</h3>
      <p>{t.checkpoint.restartBody}</p>
      <button type="button" className="secondary" onClick={() => props.restart?.()}>{t.checkpoint.restart}</button>
    </section>}
  </section>
}

/**
 * O achado de segurança em português, com o que fazer.
 *
 * A tela mostrava `src/GeneratedApp.tsx:SECRET_PATTERN` sob o título "O que foi
 * recusado" — inglês, caixa alta, sem próximo passo, e exatamente no momento em
 * que algo deu errado. O código continua na tela, dentro dos detalhes técnicos,
 * porque é ele que se cola num pedido de ajuda.
 * @param finding - o achado como o servidor manda, `caminho:CÓDIGO`.
 * @returns a frase para a pessoa.
 */
export function findingSentence(finding: string): string {
  const separator = finding.lastIndexOf(':')
  const path = separator === -1 ? finding : finding.slice(0, separator)
  const code = separator === -1 ? '' : finding.slice(separator + 1)
  if (code === 'SECRET_PATTERN') return t.report.findingSecret.replace('{arquivo}', path)
  if (code === 'PII_PATTERN') return t.report.findingPii.replace('{arquivo}', path)
  return t.report.findingUnknown.replace('{arquivo}', path)
}

/**
 * Quantos critérios foram MESMO conferidos.
 *
 * A tela dizia "12 critérios conferidos" contando a lista inteira — os que
 * falharam e os que ninguém automatizou junto. Numa tentativa com 3 falhas e 5
 * sem automação, o número afirmava uma conferência que não houve, e era a
 * palavra "conferidos" que fazia a afirmação.
 * @param checks - as conferências da tentativa.
 * @returns a frase com o total e a repartição, quando ela não é trivial.
 */
export function criteriaSentence(checks: readonly { readonly status: string }[]): string {
  const passed = checks.filter(check => check.status === 'PASSED').length
  const failed = checks.filter(check => check.status === 'FAILED').length
  const others = checks.length - passed - failed
  if (checks.length > 0 && passed === checks.length) {
    return t.checkpoint.criteriaAllPassed.replace('{total}', String(checks.length))
  }
  return t.checkpoint.criteriaBreakdown
    .replace('{total}', String(checks.length))
    .replace('{conferidos}', String(passed))
    .replace('{falharam}', String(failed))
    .replace('{naoAutomatizados}', String(others))
}

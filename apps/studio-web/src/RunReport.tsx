import { CircleAlert, CircleCheck, CircleDashed, LoaderCircle } from 'lucide-react'
import t from './i18n/pt-BR.json'

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
      <pre dir="ltr">{report.correction}</pre>
    </section>}

    {report.findings.length === 0 ? null : <section className="run-findings">
      <h3>{t.report.findingsTitle}</h3>
      <p className="context-note">{t.report.findingsHelp}</p>
      <ul>{report.findings.map(finding => <li key={finding}>{finding}</li>)}</ul>
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

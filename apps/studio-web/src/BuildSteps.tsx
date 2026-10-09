import t from './i18n/pt-BR.json'

/** Os quatro passos do construtor, na ordem em que ele os executa. */
export const BUILD_STEP_ORDER = ['install', 'build', 'test', 'e2e'] as const
export type BuildStepName = typeof BUILD_STEP_ORDER[number]

/** Um passo como o servidor o grava. */
export interface RunStepRecord {
  readonly step: string
  readonly state: 'RUNNING' | 'PASSED' | 'FAILED'
  readonly started_at: string
  readonly finished_at: string | null
}

/** Como um passo aparece na tela. */
export type BuildStepUiState = 'running' | 'passed' | 'failed' | 'waiting' | 'never'

export interface BuildStepRow {
  readonly step: BuildStepName
  readonly state: BuildStepUiState
  /** Segundos que o passo levou, quando dá para saber. */
  readonly seconds: number | null
}

const STEP_LABEL: Readonly<Record<BuildStepName, string>> = {
  install: t.creation.steps.labels.install,
  build: t.creation.steps.labels.build,
  test: t.creation.steps.labels.test,
  e2e: t.creation.steps.labels.e2e,
}

const STATE_LABEL: Readonly<Record<BuildStepUiState, string>> = {
  running: t.creation.steps.running,
  passed: t.creation.steps.done,
  failed: t.creation.steps.failed,
  waiting: t.creation.steps.waiting,
  never: t.creation.steps.never,
}

export function buildStepLabel(step: BuildStepName): string { return STEP_LABEL[step] }
export function buildStepStateLabel(state: BuildStepUiState): string { return STATE_LABEL[state] }

export function buildStepRows(steps: readonly RunStepRecord[] | undefined, finished: boolean): readonly BuildStepRow[] {
  const known = new Map<BuildStepName, RunStepRecord>()
  for (const entry of steps ?? []) {
    if ((BUILD_STEP_ORDER as readonly string[]).includes(entry.step)) known.set(entry.step as BuildStepName, entry)
  }
  return BUILD_STEP_ORDER.map(step => {
    const record = known.get(step)
    if (record === undefined) return { step, state: finished ? 'never' : 'waiting', seconds: null } as const
    const state: BuildStepUiState = record.state === 'RUNNING' ? 'running' : record.state === 'PASSED' ? 'passed' : 'failed'
    return { step, state, seconds: elapsedSeconds(record) }
  })
}

function elapsedSeconds(record: RunStepRecord): number | null {
  if (record.finished_at === null) return null
  const started = Date.parse(record.started_at); const finished = Date.parse(record.finished_at)
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) return null
  return Math.round((finished - started) / 1_000)
}

export function hasBuildSteps(steps: readonly RunStepRecord[] | undefined): boolean {
  return buildStepRows(steps, false).some(row => row.state !== 'waiting')
}

/**
 * A linha do tempo da construção, enquanto ela acontece.
 */
export function BuildSteps({ steps, finished }: { readonly steps: readonly RunStepRecord[] | undefined; readonly finished: boolean }) {
  const rows = buildStepRows(steps, finished)
  return <section className="build-steps">
    <h2>{t.creation.steps.title}</h2>
    <ol aria-live="polite">
      {rows.map(row => <li key={row.step} className={`build-step build-step-${row.state}`}>
        <span className="build-step-dot" aria-hidden="true" />
        <span className="build-step-label">{buildStepLabel(row.step)}</span>
        <span className="build-step-state">{buildStepStateLabel(row.state)}</span>
        {row.seconds === null ? null : <span className="build-step-time">{t.creation.steps.elapsed.replace('{s}', String(row.seconds))}</span>}
      </li>)}
    </ol>
  </section>
}


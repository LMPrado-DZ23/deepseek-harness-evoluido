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

/**
 * Como um passo aparece na tela.
 *
 * `waiting` e `never` são a MESMA ausência de registro lida em dois momentos
 * diferentes, e a diferença importa para quem está olhando: enquanto a execução
 * corre, um passo sem registro ainda vai acontecer; depois que ela termina, ele
 * não chegou a acontecer. Dizer "ainda vai" sobre um passo que nunca vai é a
 * definição de deixar alguém esperando.
 */
export type BuildStepUiState = 'running' | 'passed' | 'failed' | 'waiting' | 'never'

export interface BuildStepRow {
  readonly step: BuildStepName
  readonly state: BuildStepUiState
  /** Segundos que o passo levou, quando dá para saber. */
  readonly seconds: number | null
}

/**
 * As frases dos passos, uma tabela EXAUSTIVA sobre a união.
 *
 * Um passo novo no construtor não compila até alguém escrever a frase dele em
 * português. A alternativa — buscar num objeto solto — deixaria o passo novo
 * aparecer em branco na tela de quem não programa, que é pior do que não
 * aparecer.
 */
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

/** A frase do passo, em português. */
export function buildStepLabel(step: BuildStepName): string { return STEP_LABEL[step] }
/** A frase da situação do passo, em português. */
export function buildStepStateLabel(state: BuildStepUiState): string { return STATE_LABEL[state] }

/**
 * A linha do tempo da construção, do jeito que a tela precisa dela.
 *
 * A criação era uma caixa preta enquanto acontecia: o registro guardava a etapa
 * (`build` ou `test`) e o construtor roda QUATRO passos dentro dessas duas. Nos
 * minutos mais longos do produto a pessoa via uma frase imóvel, e "trabalhando"
 * e "travado" ficavam com a mesma aparência.
 *
 * Um passo que o servidor mandou e este cliente não conhece é DESCARTADO em vez
 * de quebrar a lista: um servidor mais novo que a interface não pode apagar a
 * tela de quem está esperando. Ele reaparece quando alguém escrever a frase.
 *
 * @param steps - os passos gravados, ou `undefined` numa execução antiga.
 * @param finished - se a execução já terminou (muda `waiting` para `never`).
 * @returns uma linha por passo conhecido, na ordem do construtor.
 */
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

/**
 * Quantos segundos o passo levou.
 *
 * Só para passo TERMINADO. Um cronômetro correndo para um passo em andamento
 * teria de ser redesenhado a cada segundo e, no primeiro segundo em que a rede
 * engasgasse, ele congelaria — um número parado mente com mais convicção do que
 * número nenhum.
 */
function elapsedSeconds(record: RunStepRecord): number | null {
  if (record.finished_at === null) return null
  const started = Date.parse(record.started_at); const finished = Date.parse(record.finished_at)
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) return null
  return Math.round((finished - started) / 1_000)
}

/** Se vale mostrar a linha do tempo: sem passo nenhum registrado, não vale. */
export function hasBuildSteps(steps: readonly RunStepRecord[] | undefined): boolean {
  return buildStepRows(steps, false).some(row => row.state !== 'waiting')
}

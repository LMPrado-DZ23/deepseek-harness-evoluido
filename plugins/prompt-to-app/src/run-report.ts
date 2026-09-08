import { t } from './i18n.js'

/**
 * O relato do que aconteceu na criação, na língua de quem não programa.
 *
 * Até aqui a etapa de criação era uma caixa preta: o `pipeline.log` era gravado
 * como evidência e NUNCA renderizado, e a pessoa terminava com um código em
 * inglês (`BUILD_FAILED`) e nada mais. Este módulo é puro de propósito - ele
 * transforma o que o pipeline já sabe em frases, sem tocar em disco, para que
 * cada regra seja testável isoladamente.
 *
 * Regra que atravessa o arquivo inteiro: NADA aqui inventa. Uma etapa que não
 * rodou é `not-run`, e não "passou"; um arquivo sem autor conhecido não vira
 * "do Studio"; e o detalhe técnico é o texto real do processo, cortado, nunca
 * reescrito.
 */

/** Os passos do construtor, na ordem em que acontecem. */
export const RUN_STEPS = ['install', 'build', 'test', 'e2e'] as const
export type RunStep = typeof RUN_STEPS[number]

export type RunStageState = 'passed' | 'failed' | 'running' | 'not-run'

export interface RunStage {
  readonly step: RunStep
  /** A frase que a pessoa lê. */
  readonly label: string
  readonly state: RunStageState
  /**
   * A saída real do processo, cortada. Fica atrás de "detalhes técnicos": é o
   * que se cola num pedido de ajuda, e não o que se lê para entender.
   */
  readonly detail: string
}

/** Quem escreveu o arquivo. `model` é a IA; `studio` são os geradores próprios. */
export type RunFileAuthor = 'model' | 'studio'
export type RunFileChange = 'added' | 'changed' | 'unchanged'

export interface RunFile {
  readonly path: string
  readonly lines: number
  readonly bytes: number
  readonly author: RunFileAuthor
  readonly change: RunFileChange
}

export interface RunReport {
  readonly stages: readonly RunStage[]
  readonly files: readonly RunFile[]
  /** O que os controles recusaram nesta tentativa. Vazio quando nada foi recusado. */
  readonly findings: readonly string[]
  /**
   * O que estava errado na tentativa anterior e foi pedido para corrigir.
   * `null` na primeira tentativa - não havia nada a corrigir.
   */
  readonly correction: string | null
  readonly attempt: number
}

/** Limite do detalhe técnico por etapa: o suficiente para diagnosticar, não um despejo. */
export const RUN_DETAIL_LIMIT = 4_000

/**
 * Separa o `pipeline.log` nos passos que o produziram.
 *
 * O formato é o que o pipeline escreve: `[passo]\n<stdout>\n<stderr>\n`. Um log
 * truncado ou de formato desconhecido devolve lista vazia em vez de adivinhar
 * um passo - adivinhar aqui viraria uma etapa "que passou" sem prova.
 * @param log - o conteúdo do arquivo.
 * @returns um par passo/saída por bloco reconhecido.
 */
export function parsePipelineLog(log: string): readonly { readonly step: RunStep; readonly output: string }[] {
  const blocks: { step: RunStep; output: string }[] = []
  const pattern = /^\[(install|build|test|e2e)\]$/u
  let current: { step: RunStep; lines: string[] } | undefined
  for (const line of log.split('\n')) {
    const match = pattern.exec(line.trim())
    if (match !== null) {
      if (current !== undefined) blocks.push({ step: current.step, output: current.lines.join('\n').trim() })
      current = { step: match[1] as RunStep, lines: [] }
      continue
    }
    current?.lines.push(line)
  }
  if (current !== undefined) blocks.push({ step: current.step, output: current.lines.join('\n').trim() })
  return blocks
}

/** Corta preservando o começo E o fim: o erro costuma estar no fim. */
export function runDetail(output: string, limit = RUN_DETAIL_LIMIT): string {
  const value = output.trim()
  if (value.length <= limit) return value
  const half = Math.floor((limit - 1) / 2)
  return `${value.slice(0, half)}\n…\n${value.slice(value.length - half)}`
}

export interface RunReportInput {
  /** O passo em que a execução estava, ou terminou. */
  readonly stage: 'generate' | 'build' | 'test' | 'verify'
  readonly runState: 'PENDING' | 'RUNNING' | 'PASSED' | 'FAILED' | 'BLOCKED_EXTERNAL' | 'BUDGET_EXCEEDED' | 'CANCELLED'
  readonly attempt: number
  readonly log: string
  readonly files: readonly RunFile[]
  readonly findings: readonly string[]
  readonly correction: string | null
}

/**
 * O estado de cada etapa, deduzido do log e do estado da execução.
 *
 * Um passo com bloco no log ROBOU: passou se um passo posterior também rodou ou
 * se a execução terminou bem; falhou se foi o último e a execução falhou.
 * Passo sem bloco nenhum é `not-run`, e a tela diz isso - dizer "aguardando"
 * para um passo que nunca vai rodar seria enganar quem espera.
 * @param input - o que o pipeline já sabe.
 * @returns o relato pronto para a tela.
 */
export function runReport(input: RunReportInput): RunReport {
  const blocks = parsePipelineLog(input.log)
  const executed = new Map(blocks.map(block => [block.step, block.output]))
  const lastExecuted = blocks.at(-1)?.step
  const failed = input.runState === 'FAILED' || input.runState === 'BUDGET_EXCEEDED'
  const running = input.runState === 'RUNNING' || input.runState === 'PENDING'
  const stages = RUN_STEPS.map((step): RunStage => {
    const output = executed.get(step)
    const label = t(`stages.${step}`)
    if (output === undefined) return { step, label, state: 'not-run', detail: '' }
    const isLast = step === lastExecuted
    const state: RunStageState = isLast && failed ? 'failed' : isLast && running ? 'running' : 'passed'
    return { step, label, state, detail: runDetail(output) }
  })
  return {
    stages,
    files: [...input.files].sort((left, right) => left.path.localeCompare(right.path)),
    findings: input.findings,
    correction: input.correction,
    attempt: input.attempt,
  }
}

/**
 * Compara o que foi escrito nesta tentativa com o da anterior.
 *
 * Na primeira tentativa tudo é `added`: não havia nada antes, e marcar
 * `unchanged` daria a impressão de que o Studio não fez nada.
 * @param current - arquivos desta tentativa, com conteúdo.
 * @param previous - arquivos da tentativa anterior, com conteúdo.
 * @returns a lista com o tipo de mudança de cada arquivo.
 */
export function diffRunFiles(
  current: readonly { readonly path: string; readonly content: string; readonly author: RunFileAuthor }[],
  previous: readonly { readonly path: string; readonly content: string }[] = [],
): readonly RunFile[] {
  const before = new Map(previous.map(file => [file.path, file.content]))
  return current.map(file => ({
    path: file.path,
    lines: file.content === '' ? 0 : file.content.split('\n').length,
    bytes: Buffer.byteLength(file.content, 'utf8'),
    author: file.author,
    change: !before.has(file.path) ? 'added' : before.get(file.path) === file.content ? 'unchanged' : 'changed',
  }))
}

/** Onde o relato mora, ao lado da execução. */
export const RUN_REPORT_FILE = 'run-report.json'

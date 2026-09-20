import t from './i18n/pt-BR.json'

/** A etapa e a tentativa da execução em curso, como o servidor as manda. */
export interface RunningStage {
  readonly stage: string
  readonly attempt: number
}

/**
 * O que está acontecendo AGORA na criação, em português.
 *
 * O servidor grava um registro de execução a cada mudança de etapa, e a tela já
 * lia esse registro a cada 1,5 segundo — para jogar a etapa fora e mostrar
 * sempre a mesma frase: "Criando e conferindo dentro do ambiente isolado…".
 * Durante os minutos mais longos do produto, a pessoa via um texto imóvel e não
 * tinha como saber se alguma coisa estava andando.
 *
 * Aqui a etapa vira frase. Uma etapa que este cliente não conhece cai numa
 * frase honesta e genérica em vez de sumir: um servidor mais novo que a
 * interface não pode fazer a tela parecer travada.
 * @param running - a etapa e a tentativa, ou `null` quando não há execução.
 * @returns a frase da etapa, ou `null` quando não há o que dizer.
 */
export function stageSentence(running: RunningStage | null): string | null {
  if (running === null) return null
  const stages: Readonly<Record<string, string>> = t.creation.stages
  return Object.hasOwn(stages, running.stage) ? stages[running.stage]! : t.creation.stageUnknown
}

/**
 * A frase da repetição, quando há uma.
 *
 * A primeira tentativa não ganha frase: dizer "1ª tentativa" na hora em que
 * tudo ainda está indo bem planta a ideia de que algo deu errado. Da segunda em
 * diante a pessoa PRECISA saber, porque o tempo dobra e o silêncio parece
 * travamento.
 * @param running - a etapa e a tentativa.
 * @returns a frase, ou `null` na primeira tentativa.
 */
export function attemptSentence(running: RunningStage | null): string | null {
  if (running === null || running.attempt <= 1) return null
  return t.creation.attempt.replace('{n}', String(running.attempt))
}


/** A execucao pode terminar antes de a transicao do projeto ser persistida. */
export function generationSettled(projectState: string, runState: string): boolean {
  return !['GENERATING', 'BUILD_OK', 'TESTS_OK'].includes(projectState)
    && ['PASSED', 'FAILED', 'BLOCKED_EXTERNAL', 'BUDGET_EXCEEDED', 'CANCELLED'].includes(runState)
}

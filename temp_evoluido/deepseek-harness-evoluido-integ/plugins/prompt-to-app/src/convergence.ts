import { createHash } from 'node:crypto'

import { t } from './i18n.js'

/**
 * CONVERGENCIA — a fase que faltava do Spec Engine (T-09).
 *
 * O laco de criacao roda `attempt <= 3`, fixo, e nunca pergunta se a tentativa
 * seguinte tem chance. O caso que isto existe para pegar e concreto: a
 * tentativa 2 recebe a mesma correcao que a 1 recebeu, escreve exatamente o
 * mesmo codigo e falha exatamente do mesmo jeito. A tentativa 3 vai receber a
 * mesma entrada pela terceira vez.
 *
 * O QUE ISTO NAO AFIRMA: que a proxima tentativa falharia. O gerador nao e
 * deterministico, e dizer "vai falhar" seria concluir sobre o futuro a partir
 * de duas amostras. O que se pode afirmar e sobre o PASSADO e sobre o
 * ORCAMENTO: a mesma entrada ja foi apresentada duas vezes e produziu a mesma
 * saida duas vezes, e a terceira gasta o resto do teto na mesma aposta. Essa e
 * a diferenca entre parar por evidencia e parar por supersticao, e e a mesma
 * linha que a memoria de falha traca na OS-60 — contar, nao concluir.
 *
 * POR ISSO SO `REPEATING` PARA. `STALLED` — mesmo diagnostico com codigo
 * diferente — e o gerador TENTANDO e nao chegando la, que e informacao para a
 * proxima correcao e nao motivo para desistir dela.
 */

export interface AttemptOutcome {
  readonly attempt: number
  readonly stage: string
  readonly diagnostic: string
  /**
   * O que a tentativa produziu, ou `undefined` quando NAO FOI OBSERVADO.
   *
   * Ausente nao e vazio, e a distincao decide se o laco para: quando o gerador
   * LANCA, nao existe saida para comparar — nao se sabe se ele tentou a mesma
   * coisa ou outra. Tratar "nao observado" como "igual" pararia a criacao
   * afirmando uma repeticao que ninguem viu. E o mesmo principio do indice de
   * codigo na OS-57: arquivo ilegivel e DITO, nunca tratado como ausente.
   */
  readonly files?: readonly { readonly path: string; readonly content: string }[] | undefined
}

export type ConvergenceVerdict =
  /** Nada com que comparar: primeira tentativa. */
  | { readonly state: 'FIRST' }
  /** Os achados DIMINUIRAM de uma tentativa para a outra. */
  | { readonly state: 'CONVERGING'; readonly previous: number; readonly current: number }
  /** Mesmo diagnostico, codigo DIFERENTE: tentou e nao chegou la. */
  | { readonly state: 'STALLED'; readonly occasions: number }
  /** Mesmo diagnostico E mesmo codigo de uma tentativa anterior. */
  | { readonly state: 'REPEATING'; readonly sameAs: number }

/**
 * A impressao do que a tentativa ESCREVEU.
 *
 * Ordenada por caminho, porque a ordem em que os geradores emitem os arquivos
 * nao faz parte do codigo: duas emissoes na ordem trocada sao o mesmo
 * aplicativo, e trata-las como diferentes esconderia justamente a repeticao
 * que este arquivo existe para enxergar.
 *
 * O caminho entra no resumo junto do conteudo — dois arquivos com o mesmo
 * conteudo em lugares diferentes sao programas diferentes. E o TAMANHO de cada
 * pedaco entra antes dele: sem isso, `{path: 'ab', content: 'c'}` e
 * `{path: 'a', content: 'bc'}` produziriam a mesma impressao.
 */
export function outputDigest(files: readonly { readonly path: string; readonly content: string }[]): string {
  const hash = createHash('sha256')
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(`${file.path.length}:${file.path}:${file.content.length}:${file.content}`)
  }
  return hash.digest('hex')
}

/**
 * Quantos achados o diagnostico reune.
 *
 * Os achados chegam juntos separados por `; `, que e como o pipeline os une.
 * Um diagnostico que nao e lista conta como UM: ele e uma falha, e contar zero
 * faria qualquer falha parecer melhora em relacao a anterior.
 */
export function countFindings(diagnostic: string): number {
  return diagnostic.split(';').map(part => part.trim()).filter(part => part.length > 0).length
}

/**
 * O veredito da tentativa MAIS RECENTE contra as anteriores.
 *
 * A comparacao de repeticao e contra QUALQUER tentativa anterior, e nao so
 * contra a imediatamente anterior: A -> B -> A e um ciclo, e olhar so para o
 * vizinho o deixaria passar como se fosse progresso.
 *
 * O diagnostico e comparado LITERALMENTE. Ele e escrito pelo nosso proprio
 * codigo, entao uma diferenca nele e uma diferenca de verdade — normalizar
 * juntaria duas falhas distintas numa so e faria o laco parar por engano.
 */
export function convergenceOf(outcomes: readonly AttemptOutcome[]): ConvergenceVerdict {
  if (outcomes.length < 2) return { state: 'FIRST' }
  const current = outcomes[outcomes.length - 1]!
  // A repeticao exige os DOIS lados observados. Sem isso, duas geracoes que
  // falharam antes de escrever qualquer coisa pareceriam a mesma tentativa.
  const currentDigest = current.files === undefined ? undefined : outputDigest(current.files)
  if (currentDigest !== undefined) {
    for (const past of outcomes.slice(0, -1)) {
      if (past.files === undefined) continue
      if (past.diagnostic === current.diagnostic && outputDigest(past.files) === currentDigest) {
        return { state: 'REPEATING', sameAs: past.attempt }
      }
    }
  }
  const previous = outcomes[outcomes.length - 2]!
  if (previous.diagnostic === current.diagnostic) {
    // Ocasioes, e nao tentativas: conta quantas vezes ESTE diagnostico apareceu
    // na sequencia inteira, porque e isso que a correcao precisa dizer.
    return { state: 'STALLED', occasions: outcomes.filter(outcome => outcome.diagnostic === current.diagnostic).length }
  }
  const previousCount = countFindings(previous.diagnostic)
  const currentCount = countFindings(current.diagnostic)
  if (currentCount < previousCount) return { state: 'CONVERGING', previous: previousCount, current: currentCount }
  return { state: 'STALLED', occasions: 1 }
}

/**
 * A UNICA razao para o laco parar antes do teto.
 *
 * Nao e `STALLED` e nunca vai ser: parar porque o gerador nao chegou la em duas
 * tentativas seria transformar dificuldade em impossibilidade, e a terceira
 * tentativa existe exatamente para a dificuldade.
 */
export function shouldStopEarly(verdict: ConvergenceVerdict): boolean {
  return verdict.state === 'REPEATING'
}

/*
 * NAO HA AVISO DE TENTATIVA TRAVADA AQUI, E A AUSENCIA E DELIBERADA.
 *
 * Escrevendo um `convergenceNote` para `STALLED`, a ligacao com o pipeline
 * mostrou que ele ja existe: `FailureMemory.correctionFor` monta
 * `prompts.repeatedFailure` — "esta mesma correcao ja foi pedida N vezes...
 * mude de estrategia" — desde a OS-19. Um segundo aviso dizendo a mesma coisa
 * com outras palavras seria uma SEGUNDA VERDADE dentro do mesmo prompt: dois
 * contadores da mesma repeticao, que divergem no primeiro conserto de um dos
 * dois, e o gerador lendo duas vezes a mesma instrucao.
 *
 * O que este arquivo acrescenta, e que nao existia em lugar nenhum, e a PARADA
 * por repeticao. `STALLED` fica aqui como CLASSIFICACAO — ele e o que separa
 * "tentou e nao chegou la" de "escreveu a mesma coisa de novo" — e quem avisa
 * sobre ele continua sendo a memoria de falha.
 */

/** A frase que explica a pessoa por que a criacao parou antes do teto. */
export function repeatingReason(verdict: ConvergenceVerdict): string | undefined {
  if (verdict.state !== 'REPEATING') return undefined
  return t('pipeline.repeating', { attempt: String(verdict.sameAs) })
}

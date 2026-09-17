/**
 * O que a PRÉVIA de um pacote mostra — e o que ela não tenta mostrar.
 *
 * O servidor devolve a lista inteira do diretório central. Desenhar trezentas
 * linhas dentro de um cartão da Biblioteca não ajuda ninguém, e cortar sem
 * dizer que cortou faz a pessoa achar que o pacote tem menos do que tem.
 *
 * Função pura pelo motivo de sempre: a ORDEM e o CORTE são o que quebra
 * primeiro, e decisão dentro de um JSX não é exercitada por teste nenhum.
 */

export interface EntradaDoPacote {
  readonly name: string
  readonly size: number
}

/** Quantas entradas cabem antes de a prévia virar a tela inteira. */
export const ENTRADAS_NA_PREVIA = 12

export interface PreviaDoPacote {
  readonly entradas: readonly EntradaDoPacote[]
  /** Quantas ficaram de fora do corte. Zero quando coube tudo. */
  readonly restantes: number
  /** O total de entradas do pacote, e não o total mostrado. */
  readonly total: number
}

/**
 * A prévia a desenhar.
 *
 * A ordem é a do NOME, e não a do arquivo: a ordem dentro do zip é a de
 * escrita e muda entre pacotes, o que faria a mesma lista aparecer embaralhada
 * de um pacote para outro.
 * @param entradas - o que o servidor devolveu.
 * @returns as entradas cortadas, quantas sobraram e o total.
 */
export function previaDoPacote(entradas: readonly EntradaDoPacote[]): PreviaDoPacote {
  const ordenadas = [...entradas].sort((esquerda, direita) => esquerda.name.localeCompare(direita.name, 'pt-BR'))
  return {
    entradas: ordenadas.slice(0, ENTRADAS_NA_PREVIA),
    restantes: Math.max(0, ordenadas.length - ENTRADAS_NA_PREVIA),
    total: ordenadas.length,
  }
}

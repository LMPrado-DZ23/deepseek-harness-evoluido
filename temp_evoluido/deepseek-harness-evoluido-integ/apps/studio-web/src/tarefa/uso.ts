/**
 * O USO e o CUSTO desta tarefa — cinco números que NÃO são o mesmo número.
 *
 * O adendo `DZ23-USO-CUSTOS-API` do proprietário exige que COTA, CONSUMO,
 * CUSTO ESTIMADO, CUSTO INFORMADO e ORÇAMENTO fiquem distintos, e proíbe duas
 * confusões por escrito:
 *
 * - **uso desconhecido nunca vira zero.** Uma tentativa que rodou sem o
 *   provedor informar tokens não é uma tentativa de zero token; é uma
 *   tentativa cujo consumo não foi registrado. Somar as duas coisas transforma
 *   "não sei" em "não custou";
 * - **evento repetido não duplica custo.** A leitura é por tentativa, e a
 *   tentativa tem identificador: reprocessar a mesma lista duas vezes não pode
 *   somar duas vezes.
 *
 * Esta fatia cobre o que o produto JÁ REGISTRA: o consumo por tentativa, que o
 * pipeline grava em `studio_runs`. Cota de assinatura e custo informado pelo
 * provedor ainda não existem em lugar nenhum, e por isso não aparecem aqui —
 * inventá-los na tela seria exatamente o que o adendo proíbe.
 */

/** Uma tentativa, no que interessa ao consumo. */
export interface TentativaComUso {
  readonly run_id: string
  readonly attempt: number
  /** Tokens de entrada, ou `null`/ausente quando o provedor não informou. */
  readonly input_tokens?: number | null
  readonly output_tokens?: number | null
  /** O custo ESTIMADO pelo preço configurado — nunca o informado pelo provedor. */
  readonly estimated_cost_usd?: number | null
  readonly route?: string | null
  readonly model?: string | null
}

export interface UsoDaTarefa {
  /** Quantas tentativas existem, contadas por identificador. */
  readonly tentativas: number
  /** Soma dos tokens de entrada REGISTRADOS, ou `null` quando nenhuma registrou. */
  readonly tokensEntrada: number | null
  readonly tokensSaida: number | null
  /** Soma dos custos estimados REGISTRADOS, ou `null` quando nenhum foi. */
  readonly custoEstimadoUsd: number | null
  /**
   * Quantas tentativas rodaram SEM consumo registrado.
   *
   * Este é o número que impede o resto de mentir: com ele na tela, uma soma
   * pequena ao lado de "3 tentativas sem registro" é lida como incompleta, que
   * é o que ela é.
   */
  readonly tentativasSemRegistro: number
  /** As rotas e modelos que apareceram, sem repetição e em ordem estável. */
  readonly rotas: readonly string[]
  readonly modelos: readonly string[]
}

function somar(valores: readonly (number | null | undefined)[]): number | null {
  const conhecidos = valores.filter((valor): valor is number => typeof valor === 'number')
  return conhecidos.length === 0 ? null : conhecidos.reduce((total, valor) => total + valor, 0)
}

/**
 * O consumo desta tarefa, a partir das tentativas registradas.
 *
 * @param tentativas - as execuções que o servidor devolveu.
 * @returns o uso, com ausência preservada como ausência.
 */
export function usoDaTarefa(tentativas: readonly TentativaComUso[]): UsoDaTarefa {
  // POR IDENTIFICADOR, e não pela ordem da lista: o corpo da tarefa traz a
  // tentativa corrente DUAS vezes — em `runs` e em `current_run` — e somar as
  // duas dobraria o custo dela. Evento repetido não duplica custo.
  const unicas = new Map<string, TentativaComUso>()
  for (const tentativa of tentativas) unicas.set(tentativa.run_id, tentativa)
  const lista = [...unicas.values()]
  return {
    tentativas: lista.length,
    tokensEntrada: somar(lista.map(item => item.input_tokens)),
    tokensSaida: somar(lista.map(item => item.output_tokens)),
    custoEstimadoUsd: somar(lista.map(item => item.estimated_cost_usd)),
    tentativasSemRegistro: lista.filter(item => typeof item.estimated_cost_usd !== 'number').length,
    rotas: [...new Set(lista.map(item => item.route).filter((valor): valor is string => typeof valor === 'string' && valor !== ''))].sort(),
    modelos: [...new Set(lista.map(item => item.model).filter((valor): valor is string => typeof valor === 'string' && valor !== ''))].sort(),
  }
}

/**
 * O custo em DINHEIRO de uma missão, e a tabela de preço que ele exige.
 *
 * O teto por TOKENS já existe e é falsificado (`missionSpend`). O teto por
 * DINHEIRO estava parado por um motivo escrito no livro mestre: ele depende de
 * uma tabela de preço, e preço é decisão do Prado — muda por fora, por
 * fornecedor, e sem aviso.
 *
 * O que estava parado era o NÚMERO, não o MECANISMO. Este módulo é o mecanismo,
 * e ele é construído para o estado em que a tabela está hoje: VAZIA.
 *
 * Três decisões, e as três são a mesma disciplina que o resto do repositório:
 *
 * 1. **Modelo sem preço nunca vale zero.** Somar zero por um modelo que a
 *    tabela não conhece produz um total que parece medido e não é — e o teto
 *    então autoriza gasto justamente onde o registro está incompleto, que é
 *    quando um teto mais importa. É a lição de `UNMEASURED` em `missionSpend`,
 *    aplicada a dinheiro.
 * 2. **Preço tem VALIDADE.** Um preço copiado uma vez e nunca mais olhado é
 *    segunda verdade com data: o número no arquivo e o número que o fornecedor
 *    cobra divergem em silêncio, e quem lê o painel acha que sabe quanto
 *    gastou. Um preço vencido é `PRECO_VENCIDO`, que é diferente de ausente e
 *    diferente de válido.
 * 3. **Tabela vazia não é "sem teto".** `SEM_TABELA` é um desfecho próprio.
 *    Tratá-la como ausência de limite transformaria um campo não preenchido em
 *    autorização de gasto ilimitado.
 */
import { z } from 'zod'

/** Os desfechos de um cálculo de custo. Nenhum deles colapsa em outro. */
export const DESFECHOS_DE_CUSTO = ['CALCULADO', 'SEM_TABELA', 'SEM_PRECO', 'PRECO_VENCIDO', 'SEM_CONSUMO'] as const
export type DesfechoDeCusto = (typeof DESFECHOS_DE_CUSTO)[number]

/**
 * O preço de um modelo, em CENTAVOS por milhão de tokens.
 *
 * Centavos inteiros, e não reais com vírgula: ponto flutuante soma errado, e um
 * teto de gasto que erra centavos ao longo de mil execuções erra o teto. A
 * unidade é "por milhão" porque é como todo fornecedor publica — converter na
 * leitura evitaria uma conversão e criaria uma tradução a mais para conferir.
 */
export const precoDeModeloSchema = z.object({
  provedor: z.string().min(1).max(64),
  modelo: z.string().min(1).max(128),
  entrada_centavos_por_milhao: z.number().int().nonnegative(),
  saida_centavos_por_milhao: z.number().int().nonnegative(),
  moeda: z.enum(['BRL', 'USD']),
  /** Quem escreveu este preço, e de onde ele veio. Um preço sem origem não é conferível. */
  fonte: z.string().min(1).max(500),
  anotado_em: z.string().datetime(),
  /** Depois desta data o preço não vale mais. Obrigatória: preço sem validade é preço que ninguém volta a olhar. */
  vale_ate: z.string().datetime(),
}).strict()
export type PrecoDeModelo = z.infer<typeof precoDeModeloSchema>

export const tabelaDePrecoSchema = z.object({
  /** A moeda em que o teto da missão é declarado. Misturar moedas num total é somar coisas diferentes. */
  moeda: z.enum(['BRL', 'USD']),
  precos: z.array(precoDeModeloSchema).max(200),
}).strict()
export type TabelaDePreco = z.infer<typeof tabelaDePrecoSchema>

/** O consumo de uma execução, no recorte que o custo exige. */
export interface ConsumoDeExecucao {
  readonly run_id: string
  readonly provedor: string
  readonly modelo: string
  readonly tokens_entrada?: number | null | undefined
  readonly tokens_saida?: number | null | undefined
}

export type CustoDeExecucao =
  | { readonly kind: 'CALCULADO'; readonly centavos: number }
  | { readonly kind: 'SEM_PRECO'; readonly provedor: string; readonly modelo: string }
  | { readonly kind: 'PRECO_VENCIDO'; readonly provedor: string; readonly modelo: string; readonly vale_ate: string }
  | { readonly kind: 'SEM_CONSUMO'; readonly runId: string }

/**
 * A chave de um modelo na tabela.
 *
 * Provedor E modelo: `gpt-4o` de um revendedor e do fornecedor original não têm
 * o mesmo preço, e casar só pelo nome do modelo escolheria o primeiro que
 * aparecesse na lista.
 * @param provedor - o provedor.
 * @param modelo - o modelo.
 * @returns a chave.
 */
export function chaveDoModelo(provedor: string, modelo: string): string {
  return `${provedor.toLowerCase()}|${modelo.toLowerCase()}`
}

/**
 * O custo de UMA execução.
 *
 * Arredonda para CIMA. Um teto que arredonda para baixo deixa passar um pouco
 * mais a cada execução, e "um pouco mais" mil vezes é o teto não existindo.
 * @param consumo - o consumo declarado da execução.
 * @param tabela - a tabela de preço vigente.
 * @param agora - o instante da conferência, em ISO-8601.
 * @returns o custo, ou o motivo de não dar para calcular.
 */
export function custoDaExecucao(consumo: ConsumoDeExecucao, tabela: TabelaDePreco, agora: string): CustoDeExecucao {
  const preco = tabela.precos.find(item => chaveDoModelo(item.provedor, item.modelo) === chaveDoModelo(consumo.provedor, consumo.modelo))
  if (preco === undefined) return { kind: 'SEM_PRECO', provedor: consumo.provedor, modelo: consumo.modelo }
  if (Date.parse(preco.vale_ate) <= Date.parse(agora)) {
    return { kind: 'PRECO_VENCIDO', provedor: consumo.provedor, modelo: consumo.modelo, vale_ate: preco.vale_ate }
  }
  // A MOEDA é conferida contra a da tabela, e não convertida: converter exigiria
  // uma taxa de câmbio, que é outro preço que muda por fora e que ninguém
  // declarou. Um preço em outra moeda é tão incalculável quanto um ausente.
  if (preco.moeda !== tabela.moeda) return { kind: 'SEM_PRECO', provedor: consumo.provedor, modelo: consumo.modelo }
  const entrada = consumo.tokens_entrada
  const saida = consumo.tokens_saida
  // Consumo NÃO DECLARADO não é consumo zero. A execução que não relatou quanto
  // usou é a que mais precisa aparecer.
  if (entrada === null || entrada === undefined || saida === null || saida === undefined) {
    return { kind: 'SEM_CONSUMO', runId: consumo.run_id }
  }
  const centavos = Math.ceil((entrada * preco.entrada_centavos_por_milhao + saida * preco.saida_centavos_por_milhao) / 1_000_000)
  return { kind: 'CALCULADO', centavos }
}

export type GastoEmDinheiro =
  | { readonly kind: 'SEM_TABELA' }
  | { readonly kind: 'SEM_TETO'; readonly centavos: number }
  | { readonly kind: 'DENTRO'; readonly centavos: number; readonly teto: number }
  | { readonly kind: 'ESTOURADO'; readonly centavos: number; readonly teto: number }
  | { readonly kind: 'NAO_MEDIDO'; readonly motivo: CustoDeExecucao; readonly teto: number | null }

/**
 * Quanto a missão gastou em dinheiro, e se cabe mais.
 *
 * `NAO_MEDIDO` vem ANTES de qualquer comparação com o teto, e carrega o motivo
 * inteiro: dizer "não medido" sem dizer QUAL modelo falta na tabela manda a
 * pessoa procurar em toda a tabela. Ele também é devolvido quando NÃO há teto —
 * saber que o total é incalculável importa mesmo sem limite declarado, porque é
 * esse total que aparece no painel.
 * @param teto - o teto em centavos, ou `null` quando a missão não declarou.
 * @param consumos - o consumo de cada execução da missão.
 * @param tabela - a tabela de preço vigente, ou `undefined` quando não há.
 * @param agora - o instante da conferência, em ISO-8601.
 * @returns o veredito.
 */
export function gastoEmDinheiro(
  teto: number | null,
  consumos: readonly ConsumoDeExecucao[],
  tabela: TabelaDePreco | undefined,
  agora: string,
): GastoEmDinheiro {
  // Tabela ausente ou VAZIA são o mesmo estado para quem pergunta: não dá para
  // calcular. Uma tabela presente e vazia seria "calculado, zero", que é a
  // mentira exata que este módulo existe para não contar.
  if (tabela === undefined || tabela.precos.length === 0) return { kind: 'SEM_TABELA' }
  let centavos = 0
  for (const consumo of consumos) {
    const custo = custoDaExecucao(consumo, tabela, agora)
    if (custo.kind !== 'CALCULADO') return { kind: 'NAO_MEDIDO', motivo: custo, teto }
    centavos += custo.centavos
  }
  if (teto === null) return { kind: 'SEM_TETO', centavos }
  return centavos >= teto ? { kind: 'ESTOURADO', centavos, teto } : { kind: 'DENTRO', centavos, teto }
}

/**
 * Os preços que vencem dentro de uma janela, para alguém ser avisado ANTES.
 *
 * Existe porque a alternativa é descobrir o vencimento quando a missão para: um
 * preço que vence no meio de uma execução transforma um teto que funcionava em
 * `NAO_MEDIDO`, e quem estava trabalhando descobre pelo bloqueio.
 * @param tabela - a tabela vigente.
 * @param agora - o instante, em ISO-8601.
 * @param janelaDias - quantos dias à frente olhar.
 * @returns os preços que vencem na janela, os já vencidos primeiro.
 */
export function precosVencendo(tabela: TabelaDePreco, agora: string, janelaDias: number): readonly PrecoDeModelo[] {
  const limite = Date.parse(agora) + janelaDias * 24 * 60 * 60 * 1000
  return tabela.precos
    .filter(preco => Date.parse(preco.vale_ate) <= limite)
    .sort((esquerda, direita) => Date.parse(esquerda.vale_ate) - Date.parse(direita.vale_ate))
}

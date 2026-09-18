import type { Custo, Oferta, RegistroDeOferta } from './model.js'

/**
 * As regras da OFERTA — o que a empresa entrega, para quem, por quanto, com
 * que capacidade e sob que condições.
 *
 * `BUS-03` na matriz canônica: *"Oferta descreve entrega, público, preço/moeda,
 * capacidade e condições aprovadas. Preço sugerido não publicado
 * automaticamente; margem estimada declara custos ausentes e não é lucro
 * garantido."*
 *
 * As duas frases do fim do aceite não são ressalvas — são o requisito. Cada uma
 * vira uma regra com nome próprio aqui, porque uma regra que mora dentro do
 * método que grava não é exercitada por teste nenhum.
 *
 * ## "Preço sugerido não publicado automaticamente"
 *
 * `precoSugerido` é uma função PURA que não escreve em lugar nenhum e devolve
 * `aplicado: false` junto do número. O preço de uma oferta só existe porque uma
 * pessoa o escreveu; a sugestão é material de decisão, e virar preço sozinha é
 * o produto decidindo quanto a empresa de alguém cobra.
 *
 * ## "Margem estimada declara custos ausentes e não é lucro garantido"
 *
 * A margem tem TRÊS estados, e colapsá-los é a mesma ausência-vira-prova que o
 * adendo de custos já proibiu do outro lado do produto:
 *
 * - **DESCONHECIDA** — nenhum custo declarado. Isso NÃO é margem de 100%: é
 *   não saber. Escrever 100% aqui diria a alguém que a oferta é lucro puro.
 * - **TETO** — há custo declarado SEM valor. A conta que dá para fazer é um
 *   limite superior: a margem real só pode ser menor. Chamar isso de estimativa
 *   esconderia exatamente a parte que falta.
 * - **ESTIMADA** — todo custo declarado tem valor. Ainda assim é estimativa, e
 *   não lucro: imposto, inadimplência, devolução e o custo que ninguém lembrou
 *   continuam fora, e a palavra "lucro" não aparece em lugar nenhum daqui.
 */

/** Por que uma oferta foi recusada. */
export type RecusaDeOferta =
  /** A empresa foi arquivada: ela não recebe oferta nova. */
  | 'arquivada'
  /** A oferta é idêntica à que já vale. Versão nova sem mudança é ruído. */
  | 'sem-mudanca'
  /** Aprovar sem preço publicaria uma oferta que ninguém sabe quanto custa. */
  | 'sem-preco'
  /** Aprovar sem capacidade promete entrega que ninguém pode cumprir. */
  | 'sem-capacidade'
  /** Aprovar sem condição escrita deixa "condições aprovadas" sem conteúdo. */
  | 'sem-condicoes'
  /** Esta versão já está aprovada. Aprovar de novo não é uma segunda decisão. */
  | 'ja-aprovada'

/** O estado de conhecimento da margem. */
export type EstadoDaMargem = 'ESTIMADA' | 'TETO' | 'DESCONHECIDA'

/** A margem, como a tela a lê. */
export interface MargemEstimada {
  readonly estado: EstadoDaMargem
  /** O que sobra por unidade vendida. `null` quando não se sabe. */
  readonly porUnidade: number | null
  /** O mesmo em porcentagem do preço. `null` quando não se sabe. */
  readonly percentual: number | null
  /** Quantos custos a pessoa declarou. */
  readonly custosDeclarados: number
  /** Os custos declarados SEM valor, pelo nome. É o que falta saber. */
  readonly custosSemValor: readonly string[]
}

/** Um preço sugerido a partir dos custos — e a declaração de que ele não foi aplicado. */
export interface PrecoSugerido {
  readonly valor: number | null
  /**
   * SEMPRE `false`. O campo existe para que a tela não possa exibir a sugestão
   * sem exibir o fato de que ela não é o preço da oferta.
   */
  readonly aplicado: false
  /** Os custos sem valor que tornam a sugestão um piso, e não um preço justo. */
  readonly custosSemValor: readonly string[]
}

/**
 * O total dos custos que TÊM valor, e os nomes dos que não têm.
 * @param custos - os custos declarados.
 * @returns a soma do que se sabe e o nome do que falta.
 */
export function custosConhecidos(custos: readonly Custo[]): { readonly total: number, readonly semValor: readonly string[] } {
  return {
    total: custos.reduce((soma, custo) => soma + (custo.valor ?? 0), 0),
    semValor: custos.filter(custo => custo.valor === null).map(custo => custo.nome),
  }
}

/**
 * A MARGEM ESTIMADA de uma oferta.
 *
 * Sem preço não há margem — não porque falte um número, mas porque a pergunta
 * "quanto sobra" não existe antes de alguém decidir quanto cobra.
 * @param preco - o preço que a pessoa escreveu, ou `null`.
 * @param custos - os custos declarados.
 * @returns a margem, com o estado do que se sabe.
 */
export function margemEstimada(preco: number | null, custos: readonly Custo[]): MargemEstimada {
  const { total, semValor } = custosConhecidos(custos)
  const vazia = { porUnidade: null, percentual: null, custosDeclarados: custos.length, custosSemValor: semValor } as const
  // Sem custo NENHUM declarado, a margem não é o preço inteiro: é ignorância.
  // Este é o caso que transforma "não sei" em "lucro puro" se alguém o
  // colapsar, e é o motivo de a função existir separada do cálculo.
  if (custos.length === 0 || preco === null || preco <= 0) return { estado: 'DESCONHECIDA', ...vazia }
  const porUnidade = preco - total
  return {
    estado: semValor.length > 0 ? 'TETO' : 'ESTIMADA',
    porUnidade,
    percentual: (porUnidade / preco) * 100,
    custosDeclarados: custos.length,
    custosSemValor: semValor,
  }
}

/**
 * Um preço SUGERIDO a partir dos custos conhecidos e de uma margem desejada.
 *
 * Ele não é publicado, não é gravado e não vira o preço da oferta. A função
 * devolve `aplicado: false` junto do número justamente para que nenhuma tela
 * consiga mostrar a sugestão sem mostrar isso.
 *
 * A margem desejada é fechada abaixo de 100%: a 100% a conta divide por zero, e
 * acima dela o "preço" seria negativo — quem digitou 150% quis outra coisa, e
 * devolver um número sem sentido é pior que devolver `null`.
 * @param custos - os custos declarados.
 * @param margemDesejadaPercentual - quanto se quer que sobre, de 0 a 99.
 * @returns a sugestão, ou `null` quando não há custo conhecido para sugerir de.
 */
export function precoSugerido(custos: readonly Custo[], margemDesejadaPercentual: number): PrecoSugerido {
  const { total, semValor } = custosConhecidos(custos)
  const impossivel = !Number.isFinite(margemDesejadaPercentual) || margemDesejadaPercentual < 0 || margemDesejadaPercentual >= 100
  return {
    valor: total <= 0 || impossivel ? null : total / (1 - margemDesejadaPercentual / 100),
    aplicado: false,
    custosSemValor: semValor,
  }
}

/**
 * A próxima versão de oferta desta empresa, por OFERTA.
 *
 * Uma empresa tem catálogo: várias ofertas, cada uma com seu próprio
 * histórico. Numerar por empresa faria a segunda oferta nascer na versão 4
 * porque a primeira foi revisada três vezes.
 * @param anteriores - as versões já gravadas, de qualquer oferta.
 * @param offerKey - a oferta cuja próxima versão se quer.
 * @returns o número da próxima.
 */
export function proximaVersaoDaOferta(anteriores: readonly RegistroDeOferta[], offerKey: string): number {
  return anteriores
    .filter(registro => registro.offer_key === offerKey)
    .reduce((maior, registro) => Math.max(maior, registro.version), 0) + 1
}

/**
 * A versão que VALE de cada oferta do catálogo.
 *
 * Por versão, e não por instante: dois registros gravados no mesmo
 * milissegundo empatariam por data, e a ordem de leitura decidiria qual oferta
 * a empresa tem.
 * @param registros - todas as versões da empresa.
 * @returns uma entrada por oferta, na ordem alfabética do nome.
 */
export function catalogoVigente(registros: readonly RegistroDeOferta[]): readonly RegistroDeOferta[] {
  const porOferta = new Map<string, RegistroDeOferta>()
  for (const registro of registros) {
    const atual = porOferta.get(registro.offer_key)
    if (atual === undefined || registro.version > atual.version) porOferta.set(registro.offer_key, registro)
  }
  return [...porOferta.values()].sort((esquerda, direita) => esquerda.oferta.nome.localeCompare(direita.oferta.nome, 'pt-BR'))
}

/**
 * O separador de comparação.
 *
 * É um caractere de controle de propósito: qualquer separador que uma pessoa
 * consiga digitar permitiria escrever uma condição que imita a fronteira entre
 * dois campos e fazer duas ofertas diferentes terem a mesma impressão.
 */
const SEPARADOR = String.fromCharCode(31)

/** O que liga o nome de um custo ao valor dele dentro da impressão. */
const IGUAL = String.fromCharCode(30)

/**
 * Um texto normalizado para comparação.
 * @param valor - o texto.
 * @returns o texto sem espaço em volta e sem espaço repetido.
 */
function textoNormalizado(valor: string): string {
  return valor.trim().replaceAll(/\s+/gu, ' ')
}

/**
 * Se duas ofertas dizem a mesma coisa.
 *
 * Condições e custos são comparados como CONJUNTO ordenado: trocar a ordem de
 * duas condições não é uma decisão nova, e gravar uma versão por reordenação
 * encheria o catálogo de mudanças que ninguém tomou.
 * @param esquerda - uma oferta.
 * @param direita - a outra.
 * @returns `true` quando são a mesma oferta.
 */
export function ofertasIguais(esquerda: Oferta, direita: Oferta): boolean {
  const impressao = (oferta: Oferta): string => [
    textoNormalizado(oferta.nome),
    textoNormalizado(oferta.entrega),
    textoNormalizado(oferta.publico),
    oferta.preco === null ? '' : String(oferta.preco),
    oferta.moeda,
    String(oferta.capacidade.quantidade),
    oferta.capacidade.periodo,
    [...oferta.condicoes].map(textoNormalizado).sort().join(SEPARADOR),
    [...oferta.custos].map(custo => [textoNormalizado(custo.nome), custo.valor ?? ''].join(IGUAL)).sort().join(SEPARADOR),
  ].join(SEPARADOR)
  return impressao(esquerda) === impressao(direita)
}

/**
 * Por que uma oferta NOVA (ou revisão) seria recusada.
 * @param empresa - a empresa dona do catálogo.
 * @param vigente - a versão que vale desta oferta, quando existe.
 * @param proposta - a oferta que se quer gravar.
 * @returns a recusa, ou `null` quando ela pode ser gravada.
 */
export function recusaDeOferta(
  empresa: { readonly archived_at: string | null },
  vigente: RegistroDeOferta | undefined,
  proposta: Oferta,
): RecusaDeOferta | null {
  if (empresa.archived_at !== null) return 'arquivada'
  if (vigente !== undefined && ofertasIguais(vigente.oferta, proposta)) return 'sem-mudanca'
  return null
}

/**
 * Por que uma oferta não pode ser APROVADA.
 *
 * Aprovar é o que separa rascunho de oferta: é a versão cujas condições são "as
 * condições aprovadas" que o aceite pede. Por isso o rascunho pode estar
 * incompleto e a aprovação não pode.
 * @param registro - a versão que se quer aprovar.
 * @returns a recusa, ou `null` quando ela pode ser aprovada.
 */
export function recusaDeAprovacao(registro: RegistroDeOferta): RecusaDeOferta | null {
  if (registro.approved_at !== null) return 'ja-aprovada'
  if (registro.oferta.preco === null || registro.oferta.preco <= 0) return 'sem-preco'
  if (registro.oferta.capacidade.quantidade <= 0) return 'sem-capacidade'
  if (registro.oferta.condicoes.length === 0) return 'sem-condicoes'
  return null
}

/**
 * A oferta está aprovada?
 *
 * Existe como função com nome porque "aprovada" é lida em três lugares, e a
 * comparação com `null` espalhada é onde uma delas envelhece sozinha.
 * @param registro - a versão.
 * @returns `true` quando alguém aprovou esta versão.
 */
export function ofertaAprovada(registro: RegistroDeOferta): boolean {
  return registro.approved_at !== null
}

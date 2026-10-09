import { textoNormalizado } from './Empresa'

/**
 * O que a tela do CATÁLOGO decide antes de falar com o servidor — `BUS-03`.
 *
 * Tudo aqui é função pura, pela lição de sempre: a decisão que mora dentro de
 * um JSX não é exercitada por teste nenhum.
 *
 * A tela NÃO refaz a autoridade do servidor — ele continua sendo quem recusa
 * papel, escopo, oferta repetida e aprovação incompleta. O que estas funções
 * fazem é dizer ANTES do envio o que já dá para saber, para a pessoa não
 * descobrir por um código de estado o que podia ter lido enquanto escrevia.
 *
 * ## A margem é calculada AQUI de propósito, e isso não é uma segunda verdade
 *
 * O servidor guarda preço e custos; ele não guarda margem, porque margem é
 * derivada e guardá-la criaria um número que envelhece sozinho no primeiro
 * reajuste. Quem deriva é quem mostra. O que NÃO pode divergir são as regras do
 * estado — DESCONHECIDA, TETO e ESTIMADA —, e elas estão escritas uma vez em
 * `plugins/business/src/oferta.ts` e repetidas aqui pela mesma razão que o
 * estado de custo das Preferências: o servidor decide o que gravar, a tela
 * decide o que mostrar, e divergir produziria um RÓTULO errado, nunca um
 * número errado, porque os números vêm inteiros de lá.
 */

/** Um custo como a tela o carrega: o valor ainda em texto. */
export interface RascunhoDeCusto {
  readonly nome: string
  /** Vazio é "declarei o custo e não sei o valor" — e não zero. */
  readonly valor: string
}

/** A oferta em edição. */
export interface RascunhoDaOferta {
  readonly nome: string
  readonly entrega: string
  readonly publico: string
  readonly preco: string
  readonly moeda: string
  readonly quantidade: string
  readonly periodo: 'dia' | 'semana' | 'mes'
  /** Uma condição por linha, como os limites do plano. */
  readonly condicoes: string
  readonly custos: readonly RascunhoDeCusto[]
}

export const OFERTA_VAZIA: RascunhoDaOferta = {
  nome: '', entrega: '', publico: '', preco: '', moeda: 'BRL',
  quantidade: '', periodo: 'semana', condicoes: '', custos: [],
}

/** A oferta como o servidor a recebe. */
export interface OfertaEnviada {
  readonly nome: string
  readonly entrega: string
  readonly publico: string
  readonly preco: number | null
  readonly moeda: string
  readonly capacidade: { readonly quantidade: number, readonly periodo: 'dia' | 'semana' | 'mes' }
  readonly condicoes: readonly string[]
  readonly custos: readonly { readonly nome: string, readonly valor: number | null }[]
}

/**
 * Um número escrito por gente, do jeito que gente escreve.
 *
 * Aceita vírgula decimal porque este produto é inteiro em português do Brasil e
 * é assim que se digita `12,50` aqui. Devolve `null` para texto vazio ou não
 * numérico — e `null` é "não sei", que é diferente de zero em todo lugar desta
 * fatia.
 * @param texto - o que a pessoa digitou.
 * @returns o número, ou `null`.
 */
export function numeroDoTexto(texto: string): number | null {
  const limpo = texto.trim().replaceAll('.', '').replace(',', '.')
  if (limpo === '') return null
  const valor = Number(limpo)
  return Number.isFinite(valor) ? valor : null
}

/**
 * As condições que a pessoa escreveu, uma por linha.
 *
 * Linha em branco some em vez de virar condição vazia, e duas linhas que só
 * diferem no espaçamento viram uma — a mesma normalização do servidor, para a
 * contagem que a tela mostra ser a que ele vai gravar.
 * @param texto - o campo inteiro.
 * @returns as condições, na ordem em que foram escritas.
 */
export function condicoesDoTexto(texto: string): readonly string[] {
  const vistas = new Set<string>()
  const condicoes: string[] = []
  for (const linha of texto.split('\n')) {
    const limpa = textoNormalizado(linha)
    if (limpa === '' || vistas.has(limpa)) continue
    vistas.add(limpa)
    condicoes.push(limpa)
  }
  return condicoes
}

/**
 * O rascunho virado pedido.
 * @param rascunho - a oferta em edição.
 * @returns a oferta como o servidor a espera.
 */
export function ofertaDoRascunho(rascunho: RascunhoDaOferta): OfertaEnviada {
  return {
    nome: textoNormalizado(rascunho.nome),
    entrega: textoNormalizado(rascunho.entrega),
    publico: textoNormalizado(rascunho.publico),
    preco: numeroDoTexto(rascunho.preco),
    moeda: rascunho.moeda.trim().toUpperCase(),
    capacidade: { quantidade: Math.trunc(numeroDoTexto(rascunho.quantidade) ?? 0), periodo: rascunho.periodo },
    condicoes: condicoesDoTexto(rascunho.condicoes),
    // Custo SEM valor é gravado com `valor: null`. Trocar por zero aqui faria a
    // margem mentir para cima, e é a mentira que o aceite proíbe.
    custos: rascunho.custos
      .filter(custo => textoNormalizado(custo.nome) !== '')
      .map(custo => ({ nome: textoNormalizado(custo.nome), valor: numeroDoTexto(custo.valor) })),
  }
}

/**
 * Por que esta oferta ainda não pode ser GRAVADA, ou `null`.
 *
 * O rascunho pode estar incompleto — é um estado legítimo do trabalho. O que
 * ele não pode é não ter nome, não dizer o que entrega nem para quem.
 * @param rascunho - a oferta em edição.
 * @returns a chave do texto da recusa, ou `null`.
 */
export function recusaDaOferta(rascunho: RascunhoDaOferta): 'erroOfertaNome' | 'erroOfertaEntrega' | 'erroOfertaPublico' | 'erroOfertaMoeda' | null {
  const oferta = ofertaDoRascunho(rascunho)
  if (oferta.nome.length < 2) return 'erroOfertaNome'
  if (oferta.entrega.length < 10) return 'erroOfertaEntrega'
  if (oferta.publico.length < 3) return 'erroOfertaPublico'
  if (!/^[A-Z]{3}$/u.test(oferta.moeda)) return 'erroOfertaMoeda'
  return null
}

/**
 * Por que esta versão ainda não pode ser APROVADA, ou `null`.
 *
 * A mesma escada do servidor, na mesma ordem, e pelo mesmo motivo de repetir:
 * a pessoa precisa ler o que falta enquanto escreve, e não depois de o botão
 * recusar.
 * @param oferta - a versão que ela quer aprovar.
 * @returns a chave do texto da recusa, ou `null`.
 */
export function recusaDeAprovacaoNaTela(oferta: Pick<OfertaEnviada, 'preco' | 'capacidade' | 'condicoes'>):
'erroAprovarPreco' | 'erroAprovarCapacidade' | 'erroAprovarCondicoes' | null {
  if (oferta.preco === null || oferta.preco <= 0) return 'erroAprovarPreco'
  if (oferta.capacidade.quantidade <= 0) return 'erroAprovarCapacidade'
  if (oferta.condicoes.length === 0) return 'erroAprovarCondicoes'
  return null
}

/** A margem, como a tela a mostra. */
export interface MargemLida {
  readonly estado: 'ESTIMADA' | 'TETO' | 'DESCONHECIDA'
  readonly porUnidade: number | null
  readonly percentual: number | null
  readonly custosSemValor: readonly string[]
}

/**
 * A margem estimada desta oferta.
 *
 * As três respostas são diferentes e nenhuma delas é "zero":
 *
 * - sem custo declarado, ou sem preço, é **DESCONHECIDA**;
 * - com custo declarado sem valor, é **TETO** — a real só pode ser menor;
 * - com tudo valorado, é **ESTIMADA**, que ainda é estimativa e não lucro.
 * @param oferta - a oferta lida do servidor.
 * @returns a margem.
 */
export function margemDaOferta(oferta: Pick<OfertaEnviada, 'preco' | 'custos'>): MargemLida {
  const semValor = oferta.custos.filter(custo => custo.valor === null).map(custo => custo.nome)
  const total = oferta.custos.reduce((soma, custo) => soma + (custo.valor ?? 0), 0)
  if (oferta.custos.length === 0 || oferta.preco === null || oferta.preco <= 0) {
    return { estado: 'DESCONHECIDA', porUnidade: null, percentual: null, custosSemValor: semValor }
  }
  const porUnidade = oferta.preco - total
  return {
    estado: semValor.length > 0 ? 'TETO' : 'ESTIMADA',
    porUnidade,
    percentual: (porUnidade / oferta.preco) * 100,
    custosSemValor: semValor,
  }
}

/** A chave do texto que descreve o estado da margem. */
export function chaveDaMargem(margem: MargemLida): 'margemDesconhecida' | 'margemTeto' | 'margemEstimada' {
  if (margem.estado === 'DESCONHECIDA') return 'margemDesconhecida'
  return margem.estado === 'TETO' ? 'margemTeto' : 'margemEstimada'
}

/**
 * A chave do RÓTULO da margem — e ele muda com o estado.
 *
 * Achado da conferência da captura de entrega, e nenhum teste o pegava: o
 * rótulo dizia "Margem estimada" fixo, e a frase explicativa embaixo dizia "é um
 * teto, e não uma estimativa". As duas coisas na mesma caixa se contradizem, e
 * quem lê depressa lê só a primeira — que é justamente a linha em negrito, com
 * o número ao lado.
 *
 * Um rótulo que contradiz a explicação é pior que rótulo nenhum: ele dá ao
 * número a autoridade que a explicação estava tentando tirar.
 * @param margem - a margem calculada.
 * @returns a chave do catálogo.
 */
export function chaveDoRotuloDaMargem(margem: MargemLida): 'margemRotuloDesconhecida' | 'margemRotuloTeto' | 'margemRotuloEstimada' {
  if (margem.estado === 'DESCONHECIDA') return 'margemRotuloDesconhecida'
  return margem.estado === 'TETO' ? 'margemRotuloTeto' : 'margemRotuloEstimada'
}

/**
 * Um valor em dinheiro, escrito como quem lê escreve.
 *
 * A moeda vem da oferta, e não de um padrão: um número sem moeda é ambíguo no
 * primeiro dia em que alguém vender para fora do país. Uma moeda que o
 * navegador não conhece não derruba a tela — ela volta como código antes do
 * número, que é feio e é honesto.
 * @param valor - o número.
 * @param moeda - o código ISO 4217.
 * @returns o texto.
 */
export function dinheiroEmTexto(valor: number, moeda: string): string {
  try {
    return valor.toLocaleString('pt-BR', { style: 'currency', currency: moeda })
  } catch {
    return `${moeda} ${valor.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }
}

/** Uma porcentagem, com uma casa. */
export function percentualEmTexto(valor: number): string {
  return `${valor.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
}

/**
 * O preço SUGERIDO a partir dos custos conhecidos e da margem desejada.
 *
 * Ele é mostrado, e nunca escrito no campo de preço: quem decide quanto a
 * empresa de alguém cobra é essa pessoa. A função existe separada do
 * componente para que a sabotagem que a fizesse virar preço falhe num teste.
 * @param oferta - os custos declarados.
 * @param margemDesejadaPercentual - quanto se quer que sobre, de 0 a 99.
 * @returns o valor sugerido, ou `null` quando não há custo conhecido.
 */
export function sugestaoDePreco(oferta: Pick<OfertaEnviada, 'custos'>, margemDesejadaPercentual: number): number | null {
  const total = oferta.custos.reduce((soma, custo) => soma + (custo.valor ?? 0), 0)
  const impossivel = !Number.isFinite(margemDesejadaPercentual) || margemDesejadaPercentual < 0 || margemDesejadaPercentual >= 100
  if (total <= 0 || impossivel) return null
  return total / (1 - margemDesejadaPercentual / 100)
}

/** Uma versão de oferta, como o servidor a devolve. */
export interface VersaoDaOferta {
  readonly offer_version_id: string
  readonly offer_key: string
  readonly version: number
  readonly oferta: OfertaEnviada
  readonly approved_at: string | null
  readonly approved_by: string | null
}

/**
 * A chave do texto do estado de uma versão.
 *
 * Rascunho e aprovada são coisas diferentes para quem lê, e o aceite depende da
 * diferença: "condições aprovadas" só existem na versão aprovada.
 * @param versao - a versão.
 * @returns a chave do catálogo.
 */
export function chaveDoEstadoDaOferta(versao: Pick<VersaoDaOferta, 'approved_at'>): 'ofertaAprovada' | 'ofertaRascunho' {
  return versao.approved_at === null ? 'ofertaRascunho' : 'ofertaAprovada'
}

/**
 * O rascunho que abre a revisão: a versão vigente, editável.
 * @param oferta - a oferta vigente.
 * @returns o rascunho.
 */
export function rascunhoDaOferta(oferta: OfertaEnviada): RascunhoDaOferta {
  return {
    nome: oferta.nome,
    entrega: oferta.entrega,
    publico: oferta.publico,
    preco: oferta.preco === null ? '' : String(oferta.preco).replace('.', ','),
    moeda: oferta.moeda,
    quantidade: String(oferta.capacidade.quantidade),
    periodo: oferta.capacidade.periodo,
    condicoes: oferta.condicoes.join('\n'),
    custos: oferta.custos.map(custo => ({
      nome: custo.nome,
      valor: custo.valor === null ? '' : String(custo.valor).replace('.', ','),
    })),
  }
}

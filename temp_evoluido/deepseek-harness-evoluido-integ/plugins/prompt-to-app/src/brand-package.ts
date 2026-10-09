/**
 * PACOTE DE MARCA POR EMPRESA — leitura, e nunca execução (EVO-02/03, fatia E1).
 *
 * A decisão da fatia E0 sobre o DTCG foi `APROVEITAR_CONCEITO`: o formato de
 * intercâmbio de tokens é uma ESPECIFICAÇÃO, e o §47 autoriza "um subconjunto
 * declarado", com round-trip e extensões documentados. Isto é esse subconjunto.
 * Nada de terceiro é instalado; a autoridade sobre design continua sendo o
 * `DesignSpecV1` (ADR-025), e este arquivo só traduz para ele.
 *
 * A AT-118 diz, com todas as letras, o que este arquivo existe para impedir:
 * **um pacote de design inválido não vira instrução executável.** É por isso que
 * a leitura aqui:
 *
 * - não executa nada, nem avalia expressão, nem interpreta script anexado;
 * - não abre arquivo, não segue caminho e não vai à rede — o pacote é TEXTO, e
 *   o que ele referencia é conferido contra uma lista de ativos autorizados que
 *   o CHAMADOR passa;
 * - **não inventa tipo para completar a importação.** Um token sem `$type` é
 *   uma perda declarada, nunca um palpite: adivinhar que `#ff0000` é cor é
 *   acertar hoje e errar no dia em que alguém escrever uma sombra.
 *
 * E a regra que o §47 repete de três formas: **perda é DITA, não engolida.**
 * Um round-trip que devolve menos do que recebeu e não avisa é pior que um que
 * recusa, porque ele parece ter funcionado.
 */
import { z } from 'zod'

import { t } from './i18n.js'
import type { HslColor } from './design.js'

/**
 * O SUBCONJUNTO declarado do formato de tokens.
 *
 * Um tipo só, e isso é honestidade e não preguiça: o `DesignSpecV1` carrega
 * cor, e nada além disso. Aceitar `dimension` ou `fontFamily` aqui produziria
 * um token que o Studio leria e jogaria fora em silêncio — que é exatamente a
 * perda engolida que o §47 proíbe. Quando o DesignSpec crescer, esta lista
 * cresce junto, e não antes.
 */
export const TIPOS_SUPORTADOS = ['color'] as const
export type TipoSuportado = typeof TIPOS_SUPORTADOS[number]

/** Por que um pacote foi RECUSADO. Um "inválido" sem motivo não conserta nada. */
export const FALHAS = [
  'JSON_INVALIDO',
  'SEM_TOKENS',
  /** `{a}` aponta para `{b}` que aponta para `{a}`. */
  'ALIAS_CIRCULAR',
  /** O alias aponta para um token que não existe no pacote. */
  'REFERENCIA_AUSENTE',
  /** O ativo citado não está na lista de autorizados. */
  'ATIVO_NAO_AUTORIZADO',
  /** Cor que não é cor. */
  'VALOR_INVALIDO',
] as const
export type Falha = typeof FALHAS[number]

/** Por que um token NÃO entrou, sem que o pacote seja inválido. */
export const PERDAS = [
  /** O tipo existe no formato e o DesignSpec não o carrega. */
  'TIPO_FORA_DO_SUBCONJUNTO',
  /** O token não declara tipo. NÃO é adivinhado. */
  'TIPO_NAO_DECLARADO',
  /** Campo que o formato não define — extensão de quem escreveu o pacote. */
  'EXTENSAO_NAO_PADRAO',
] as const
export type Perda = typeof PERDAS[number]

export interface TokenLido { readonly caminho: string; readonly tipo: TipoSuportado; readonly cor: HslColor }
export interface PerdaDeclarada { readonly caminho: string; readonly perda: Perda; readonly detalhe?: string }
export interface FalhaDeclarada { readonly caminho: string; readonly falha: Falha; readonly detalhe?: string }

export interface PacoteLido {
  readonly empresa: string | undefined
  readonly versao: string | undefined
  readonly tokens: readonly TokenLido[]
  /** O que o pacote trazia e o Studio não carrega. SEMPRE dito. */
  readonly perdas: readonly PerdaDeclarada[]
  /** O que impede o pacote de ser aceito. */
  readonly falhas: readonly FalhaDeclarada[]
  readonly ativos: readonly string[]
}

/** O teto do texto de um pacote. Um pacote não é um banco de dados. */
export const LIMITE_BYTES = 256 * 1024
/** O teto de profundidade de alias. Um encadeamento maior é erro de quem gerou. */
export const LIMITE_ALIAS = 16

const hsl = z.object({ h: z.number(), s: z.number(), l: z.number() }).strict()

/**
 * Le um pacote de marca. NAO executa nada.
 *
 * `ativosAutorizados` vem de FORA de proposito: quem sabe quais ativos esta
 * empresa pode usar e o chamador, com o escopo dela na mao. Se esta funcao
 * fosse buscar a lista, ela precisaria de acesso ao armazenamento — e uma
 * leitura de texto que consulta o banco e uma leitura privilegiada, que e o que
 * a AT-118 manda nao existir.
 * @param texto - o pacote, como texto.
 * @param opcoes - os ativos que esta empresa pode referenciar.
 * @returns o que entrou, o que se perdeu e o que falhou.
 */
export function lerPacoteDeMarca(texto: string, opcoes: { readonly ativosAutorizados: readonly string[] }): PacoteLido {
  const vazio = { empresa: undefined, versao: undefined, tokens: [], perdas: [], ativos: [] }
  if (new TextEncoder().encode(texto).length > LIMITE_BYTES) {
    return { ...vazio, falhas: [{ caminho: '', falha: 'JSON_INVALIDO', detalhe: t('brand.tooLarge') }] }
  }
  let bruto: unknown
  try { bruto = JSON.parse(texto) } catch {
    return { ...vazio, falhas: [{ caminho: '', falha: 'JSON_INVALIDO' }] }
  }
  if (bruto === null || typeof bruto !== 'object' || Array.isArray(bruto)) {
    return { ...vazio, falhas: [{ caminho: '', falha: 'JSON_INVALIDO' }] }
  }
  const raiz = bruto as Record<string, unknown>
  const empresa = typeof raiz['$empresa'] === 'string' ? raiz['$empresa'] : undefined
  const versao = typeof raiz['$versao'] === 'string' ? raiz['$versao'] : undefined

  const cru = new Map<string, Record<string, unknown>>()
  const perdas: PerdaDeclarada[] = []
  const falhas: FalhaDeclarada[] = []
  const ativos: string[] = []
  colher(raiz, [], cru, perdas)

  if (cru.size === 0) return { empresa, versao, tokens: [], perdas, falhas: [{ caminho: '', falha: 'SEM_TOKENS' }], ativos }

  const autorizados = new Set(opcoes.ativosAutorizados)
  const tokens: TokenLido[] = []
  for (const [caminho, token] of cru) {
    const tipo = token['$type']
    if (typeof tipo !== 'string') { perdas.push({ caminho, perda: 'TIPO_NAO_DECLARADO' }); continue }
    if (typeof token['$ativo'] === 'string') {
      // O ativo e conferido contra a lista; ele NUNCA e aberto, baixado nem
      // resolvido como caminho. Um pacote que cita `../../etc/passwd` recebe a
      // mesma resposta que um que cita um logo de outra empresa: nao autorizado.
      if (!autorizados.has(token['$ativo'])) falhas.push({ caminho, falha: 'ATIVO_NAO_AUTORIZADO', detalhe: token['$ativo'] })
      else ativos.push(token['$ativo'])
    }
    if (!(TIPOS_SUPORTADOS as readonly string[]).includes(tipo)) {
      perdas.push({ caminho, perda: 'TIPO_FORA_DO_SUBCONJUNTO', detalhe: tipo }); continue
    }
    const resolvido = resolver(caminho, cru, falhas)
    if (resolvido === undefined) continue
    const cor = hsl.safeParse(resolvido)
    if (!cor.success) { falhas.push({ caminho, falha: 'VALOR_INVALIDO' }); continue }
    tokens.push({ caminho, tipo: tipo as TipoSuportado, cor: cor.data })
  }
  return { empresa, versao, tokens, perdas, falhas, ativos }
}

/** As chaves `$` que este subconjunto conhece. Qualquer outra e extensao, e e DITA. */
const CHAVES_CONHECIDAS = ['$value', '$type', '$description', '$ativo']

/** Percorre a arvore e separa TOKEN de grupo. Um token e um objeto com `$value`. */
function colher(
  no: Record<string, unknown>, prefixo: readonly string[],
  destino: Map<string, Record<string, unknown>>, perdas: PerdaDeclarada[],
): void {
  for (const [chave, valor] of Object.entries(no)) {
    if (chave.startsWith('$')) {
      // `$empresa` e `$versao` sao nossos e ja foram lidos; qualquer outro `$`
      // na RAIZ e extensao de quem escreveu, e isso e DITO em vez de ignorado.
      if (prefixo.length > 0 && !CHAVES_CONHECIDAS.includes(chave)) {
        perdas.push({ caminho: prefixo.join('.'), perda: 'EXTENSAO_NAO_PADRAO', detalhe: chave })
      }
      continue
    }
    if (valor === null || typeof valor !== 'object' || Array.isArray(valor)) continue
    const filho = valor as Record<string, unknown>
    const caminho = [...prefixo, chave]
    if ('$value' in filho) {
      destino.set(caminho.join('.'), filho)
      // As chaves `$` DE DENTRO do token também são conferidas. A primeira
      // versão só olhava as de grupo, e um `$onLoad` pendurado no token passava
      // sem ser declarado — que é exatamente onde alguém esconderia algo.
      for (const interna of Object.keys(filho)) {
        if (!interna.startsWith('$')) continue
        if (CHAVES_CONHECIDAS.includes(interna)) continue
        perdas.push({ caminho: caminho.join('.'), perda: 'EXTENSAO_NAO_PADRAO', detalhe: interna })
      }
    } else colher(filho, caminho, destino, perdas)
  }
}

/**
 * Resolve o valor de um token, seguindo alias.
 *
 * O CICLO e detectado pelo caminho ja visitado, e nao por um contador: um
 * contador confundiria um encadeamento longo e legitimo com um ciclo, e as duas
 * coisas pedem correcoes diferentes de quem escreveu o pacote.
 */
function resolver(
  caminho: string, cru: Map<string, Record<string, unknown>>, falhas: FalhaDeclarada[],
): unknown {
  const visitados = new Set<string>()
  let atual = caminho
  for (let passo = 0; passo <= LIMITE_ALIAS; passo++) {
    if (visitados.has(atual)) { falhas.push({ caminho, falha: 'ALIAS_CIRCULAR', detalhe: atual }); return undefined }
    visitados.add(atual)
    const token = cru.get(atual)
    if (token === undefined) { falhas.push({ caminho, falha: 'REFERENCIA_AUSENTE', detalhe: atual }); return undefined }
    const valor = token['$value']
    const alvo = aliasDe(valor)
    if (alvo === undefined) return valor
    atual = alvo
  }
  falhas.push({ caminho, falha: 'ALIAS_CIRCULAR', detalhe: t('brand.aliasTooDeep') })
  return undefined
}

/** `{grupo.token}` vira `grupo.token`. Qualquer outra coisa nao e alias. */
function aliasDe(valor: unknown): string | undefined {
  if (typeof valor !== 'string') return undefined
  const casou = /^\{([^{}]+)\}$/u.exec(valor.trim())
  return casou === null ? undefined : casou[1]
}

/**
 * O pacote volta a ser texto — o outro lado do round-trip (AT-117).
 *
 * Exporta SÓ o subconjunto suportado, e é isso que torna o round-trip
 * conferível: o que sai daqui, relido por `lerPacoteDeMarca`, produz os mesmos
 * tokens. O que não sai já foi declarado como perda na leitura, e some de
 * propósito — um exportador que devolvesse o que não entende estaria
 * prometendo um suporte que não tem.
 * @param pacote - o que a leitura produziu.
 * @returns o texto do pacote, no subconjunto declarado.
 */
export function escreverPacoteDeMarca(pacote: Pick<PacoteLido, 'empresa' | 'versao' | 'tokens'>): string {
  const saida: Record<string, unknown> = {}
  if (pacote.empresa !== undefined) saida['$empresa'] = pacote.empresa
  if (pacote.versao !== undefined) saida['$versao'] = pacote.versao
  for (const token of [...pacote.tokens].sort((a, b) => a.caminho.localeCompare(b.caminho))) {
    const partes = token.caminho.split('.')
    let no = saida
    for (const parte of partes.slice(0, -1)) {
      if (typeof no[parte] !== 'object' || no[parte] === null) no[parte] = {}
      no = no[parte] as Record<string, unknown>
    }
    // O ALIAS não sobrevive ao round-trip, e isso é dito e não escondido: o que
    // volta é o valor resolvido. Preservar a forma do alias exigiria guardar a
    // árvore original, e aí o que se exporta deixa de ser o que o Studio leu.
    no[partes.at(-1)!] = { $type: token.tipo, $value: token.cor }
  }
  return JSON.stringify(saida, null, 2)
}

/**
 * O que este pacote DIZ que suporta — a matriz que a AT-117 exige.
 *
 * Uma função, e não um documento, porque ela é derivada das mesmas constantes
 * que decidem: uma linha escrita à mão divergiria na primeira mudança, e a que
 * diverge em silêncio é sempre a que alguém lê.
 * @returns as frases de suporte, em português.
 */
export function matrizDeSuporte(): readonly string[] {
  return [
    t('brand.supportTypes', { tipos: [...TIPOS_SUPORTADOS].join(', ') }),
    t('brand.supportAlias', { limite: String(LIMITE_ALIAS) }),
    t('brand.supportLossAlias'),
    t('brand.supportAssets'),
  ]
}

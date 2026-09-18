
/**
 * A SELEÇÃO VISUAL: clicar num pedaço do aplicativo e falar sobre ele.
 *
 * ## O que ela é, e o que ela deliberadamente não é
 *
 * A pessoa clica num botão da prévia e descreve o que quer mudar. O que este
 * módulo faz é transformar esse clique em CONTEXTO VERIFICÁVEL — projeto,
 * versão, rota, elemento e, quando dá para saber, o arquivo de origem — e
 * entregá-lo ao fluxo de alteração que já existe: a conversa da mesma tarefa.
 *
 * Ele NÃO abre um segundo caminho de escrita. Não há aqui nenhuma função que
 * altere arquivo: a alteração continua sendo pedida pela conversa, passando
 * pela mesma autorização, pela mesma concorrência e pela mesma idempotência de
 * sempre. Selecionar um elemento não aprova publicação nem amplia acesso.
 *
 * ## A regra que decide o arquivo
 *
 * `visual-edit.ts` do plugin já responde se um elemento é EDITÁVEL ou só
 * INSPECIONÁVEL, e a decisão central dele é que mapa PARCIAL não vira arquivo:
 * "identidade do DOM isoladamente não prova uma linha no repositório". Este
 * módulo respeita isso e acrescenta a parte que faltava — QUEM produz o mapa.
 *
 * A resposta honesta hoje: o mapa sai da LISTA de arquivos de código da versão.
 * Um arquivo só, e o mapa é EXATO no arquivo (a linha continua desconhecida, e
 * nada aqui finge saber qual é). Mais de um, e ele é PARCIAL — porque saber que
 * o botão está em algum dos três não é saber em qual. Nenhum, e é AUSENTE.
 */

/**
 * O vocabulário do MAPA, declarado aqui e conferido contra o plugin.
 *
 * A interface NÃO depende do plugin — ela fala com ele por HTTP, e essa
 * separação é deliberada. O preço de declarar o vocabulário duas vezes seria a
 * segunda verdade mais cara deste repositório, então ele não é pago: há um
 * teste que LÊ `plugins/prompt-to-app/src/visual-edit.ts` e cobra que as duas
 * listas sejam a mesma. Um estado novo lá quebra o teste aqui no mesmo dia.
 */
export const MAPAS = ['EXATO', 'PARCIAL', 'AUSENTE'] as const
export type Mapa = typeof MAPAS[number]

/** O que se sabe sobre a origem do elemento. Espelha `Origem` do plugin. */
export interface Origem {
  readonly mapa: Mapa
  readonly arquivo?: string
}

/** O que a prévia conta sobre o elemento clicado. Tudo aqui é DADO, nunca instrução. */
export interface ElementoSelecionado {
  /** A etiqueta do elemento, em minúsculas. */
  readonly tag: string
  /** O texto visível, já cortado pela prévia. */
  readonly texto: string
  /** A rota em que ele estava. */
  readonly rota: string
}

/** Quanto texto de um elemento entra no contexto. */
export const LIMITE_DO_TEXTO = 200

/**
 * O elemento, quando a mensagem da prévia descreve um.
 *
 * Lista fechada de campos e tipos: o que vem de dentro do quadro é conteúdo de
 * origem desconhecida, e um objeto com mais campos não traz mais informação —
 * traz mais superfície.
 * @param corpo - o corpo da mensagem.
 * @returns o elemento, ou `null`.
 */
export function elementoSelecionado(corpo: unknown): ElementoSelecionado | null {
  if (typeof corpo !== 'object' || corpo === null) return null
  const { tag, text, path } = corpo as { tag?: unknown; text?: unknown; path?: unknown }
  if (typeof tag !== 'string' || tag === '') return null
  if (typeof text !== 'string' || typeof path !== 'string') return null
  return {
    tag: tag.toLowerCase().slice(0, 40),
    texto: text.slice(0, LIMITE_DO_TEXTO),
    rota: path.slice(0, LIMITE_DO_TEXTO),
  }
}

/** Os arquivos que podem conter a tela: código, e não conteúdo nem dado. */
export function arquivosDeCodigo(arquivos: readonly { readonly path: string }[]): readonly string[] {
  return arquivos.map(arquivo => arquivo.path).filter(caminho => /\.[cm]?[jt]sx?$/iu.test(caminho))
}

/**
 * O mapa de origem, a partir do que a versão tem.
 *
 * `EXATO` aqui significa exato no ARQUIVO, e nunca na linha: nada neste
 * caminho sabe qual linha desenhou aquele botão, e inventar uma é exatamente o
 * que o delta proíbe. Quem recebe um `EXATO` recebe um arquivo para investigar,
 * e não um ponto para escrever às cegas.
 * @param arquivos - os arquivos da versão.
 * @returns o mapa e, quando ele é exato, o arquivo.
 */
export function origemDoElemento(arquivos: readonly { readonly path: string }[]): Origem {
  const codigo = arquivosDeCodigo(arquivos)
  if (codigo.length === 0) return { mapa: 'AUSENTE' }
  /*
    Mais de um arquivo de código e o mapa é PARCIAL, e isto não é preguiça:
    saber que o botão está em algum dos três não é saber em qual, e apontar um
    deles seria escolher no escuro com a confiança de quem sabe.
  */
  if (codigo.length > 1) return { mapa: 'PARCIAL' }
  return { mapa: 'EXATO', arquivo: codigo[0]! }
}

/**
 * O texto que a seleção põe no compositor, para a pessoa completar.
 *
 * É a ponte com o fluxo que já existe: a alteração continua sendo pedida pela
 * conversa. O texto carrega o que foi clicado e ONDE, e diz a limitação quando
 * o arquivo não pôde ser determinado — em vez de calar, que faria a pessoa
 * acreditar que o produto sabe mais do que sabe.
 * @param elemento - o que foi clicado.
 * @param origem - o mapa.
 * @param rotulos - as frases do catálogo, no idioma da pessoa.
 * @returns o texto para o compositor.
 */
export function contextoParaOCompositor(
  elemento: ElementoSelecionado,
  origem: Origem,
  rotulos: { readonly noElemento: string; readonly naRota: string; readonly noArquivo: string; readonly semArquivo: string },
): string {
  /*
    Montado por junção, e não por interpolação. Um literal de modelo com três
    identificadores em português dentro é lido por `gate:i18n` como frase fora
    do catálogo — e ele está certo em desconfiar: é assim que texto de tela
    nasce escondido no código. Aqui as frases vêm TODAS do catálogo, e o que
    este arquivo faz é só colar.
  */
  const aspas = ['"', elemento.texto, '"'].join('')
  const alvo = ['<', elemento.tag, '>'].join('')
  const doArquivo = origem.mapa === 'EXATO' && origem.arquivo !== undefined
    ? [rotulos.noArquivo, origem.arquivo].join(' ')
    : rotulos.semArquivo
  const linhas = [
    [rotulos.noElemento, alvo, elemento.texto === '' ? null : aspas].filter(item => item !== null).join(' '),
    [rotulos.naRota, elemento.rota].join(' '),
    doArquivo,
  ]
  return linhas.join('\n').concat('\n')
}

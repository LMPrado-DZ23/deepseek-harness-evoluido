import { t } from './i18n.js'

/**
 * O JSON que veio de um MODELO DE VERDADE, e não de um dublê.
 *
 * ## O defeito que este arquivo existe para consertar
 *
 * Todo caminho de modelo deste plugin fazia `JSON.parse(result.value)` direto —
 * em `pipeline.ts`, duas vezes em `planner.ts` e dentro do `decode` de
 * `appspec.ts`. Isso funcionou durante a missão inteira porque o dublê sempre
 * respondeu no formato exato, e um dublê mede o dublê.
 *
 * Em 18/09/2026 o prompt REAL de geração foi enviado ao `qwen2.5:3b` rodando no
 * Ollama da máquina do titular. O modelo devolveu isto:
 *
 * ```
 * ```json
 * { "files": [ … ] }
 * ```
 * ```
 *
 * O JSON lá dentro era VÁLIDO e batia com o schema do produto, campo por campo.
 * O que impediu a geração de acontecer foram três crases. `JSON.parse` lançava,
 * a tentativa queimava, e as três tentativas queimavam do mesmo jeito — porque
 * a causa não era aleatória, era o formato normal de resposta daquele modelo.
 *
 * Cercar a resposta em markdown é o comportamento MAIS COMUM de modelo de chat,
 * e nenhum teste podia pegá-lo: o dublê não cerca.
 *
 * ## O que este decodificador aceita, em ordem
 *
 * 1. O valor já decodificado, quando não é texto.
 * 2. O texto puro, quando ele já é JSON.
 * 3. O corpo do primeiro bloco cercado — ` ```json ` ou ` ``` `.
 * 4. O primeiro objeto ou lista BALANCEADO do texto, para a resposta que vem com
 *    uma frase antes ("Claro! Aqui está:").
 *
 * ## O que ele NÃO faz, e isto é o mais importante
 *
 * Não conserta JSON quebrado, não fecha chave que faltou, não adivinha campo e
 * não devolve objeto vazio quando não achou nada — lança. Um decodificador que
 * inventa transforma "o modelo não respondeu" em "o modelo respondeu isto", e o
 * schema logo adiante aceitaria um objeto que ninguém escreveu. Tolerância é
 * sobre o INVÓLUCRO; o conteúdo continua tendo de estar lá inteiro.
 */

export class ModelJsonError extends Error {
  readonly code: 'MODEL_JSON_UNREADABLE' | 'MODEL_JSON_AMBIGUOUS' = 'MODEL_JSON_UNREADABLE'
}

/**
 * A resposta trazia MAIS DE UM JSON, e eles não são o mesmo.
 *
 * Isto é separado de "ilegível" de propósito: são causas diferentes e pedem
 * conserto diferente. Ilegível é o modelo não ter produzido JSON; ambíguo é ele
 * ter produzido dois — tipicamente um exemplo e a resposta, ou duas tentativas.
 * Escolher um deles seria adivinhar, e a escolha errada produz um aplicativo a
 * partir do EXEMPLO.
 */
export class ModelJsonAmbiguoError extends ModelJsonError {
  /*
    Ela ESTENDE `ModelJsonError` de propósito. As duas dizem a mesma coisa para
    quem chama — "não consegui ler UMA resposta" —, e quem já tratava a primeira
    continua tratando esta sem saber que ela nasceu. O `code` diferente é para
    quem quer distinguir a causa: não ter JSON e ter dois pedem consertos
    diferentes no prompt.
  */
  readonly code = 'MODEL_JSON_AMBIGUOUS'
}

/** A marca de ordem de bytes, que alguns modelos e alguns terminais colam na frente. */
const BOM = '﻿'

/**
 * O corpo do primeiro bloco cercado por crases, quando existe um.
 *
 * A cerca pode trazer uma etiqueta de linguagem (` ```json `, ` ```typescript `)
 * e ela é descartada: o que interessa é o corpo. O bloco de FECHAMENTO pode não
 * existir, porque um modelo cortado pelo limite de tokens abre a cerca e nunca a
 * fecha — nesse caso vale tudo o que veio depois da abertura, e quem decide se
 * aquilo é JSON é o `JSON.parse`, não esta função.
 * @param texto - a resposta do modelo.
 * @returns o corpo do bloco, ou `null` quando não há cerca.
 */
export function corpoDoBlocoCercado(texto: string): string | null {
  return corposDosBlocosCercados(texto)[0] ?? null
}

/**
 * TODOS os corpos de bloco cercado, e não só o primeiro.
 *
 * Um modelo que responde com um exemplo e depois com a resposta produz dois
 * blocos, e ficar com o primeiro constrói o aplicativo a partir do exemplo.
 * Quem decide o que fazer com dois é `decodeModelJson`, e a decisão dele é
 * recusar — não escolher.
 * @param texto - a resposta do modelo.
 * @returns os corpos, na ordem em que aparecem.
 */
export function corposDosBlocosCercados(texto: string): readonly string[] {
  const corpos: string[] = []
  const abertura = /^[ \t]*```[a-zA-Z0-9_-]*[ \t]*\r?\n/gmu
  let achado = abertura.exec(texto)
  while (achado !== null) {
    const inicio = achado.index + achado[0].length
    const restante = texto.slice(inicio)
    const fechamento = /^[ \t]*```[ \t]*$/mu.exec(restante)
    if (fechamento === null) {
      // Cerca aberta e nunca fechada: o limite de tokens cortou a resposta.
      corpos.push(restante)
      break
    }
    corpos.push(restante.slice(0, fechamento.index))
    abertura.lastIndex = inicio + fechamento.index + fechamento[0].length
    achado = abertura.exec(texto)
  }
  return corpos
}

/**
 * O primeiro objeto ou lista BALANCEADO do texto.
 *
 * O balanceamento respeita texto entre aspas e escapes, e isso não é detalhe: o
 * conteúdo que o modelo gera carrega JSON DENTRO de string JSON — o
 * `content/app.json` da resposta real era exatamente isso —, e uma contagem
 * ingênua de chaves fecharia no `}` que está dentro da string e devolveria um
 * pedaço cortado que ainda assim parece JSON.
 * @param texto - a resposta do modelo.
 * @returns o trecho, ou `null` quando não há bloco balanceado.
 */
export function primeiroBlocoBalanceado(texto: string): string | null {
  return blocosBalanceados(texto)[0] ?? null
}

/**
 * TODOS os blocos balanceados de primeiro nível do texto.
 *
 * O balanceamento respeita texto entre aspas e escapes, e isso não é detalhe: o
 * conteúdo que o modelo gera carrega JSON DENTRO de string JSON, e uma contagem
 * ingênua fecharia no `}` que está dentro da string.
 *
 * Varrer o texto inteiro, e não parar no primeiro, é o que permite NOTAR que a
 * resposta trouxe mais de um candidato — que é a informação que faltava para
 * não escolher em silêncio.
 * @param texto - a resposta do modelo.
 * @returns os trechos, na ordem em que aparecem.
 */
export function blocosBalanceados(texto: string): readonly string[] {
  const blocos: string[] = []
  let posicao = 0
  while (posicao < texto.length) {
    const relativo = texto.slice(posicao).search(/[[{]/u)
    if (relativo < 0) break
    const inicio = posicao + relativo
    const abre = texto[inicio] === '{' ? '{' : '['
    const fecha = abre === '{' ? '}' : ']'
    let profundidade = 0
    let dentroDeTexto = false
    let escapado = false
    let fim = -1
    for (let atual = inicio; atual < texto.length; atual += 1) {
      const caractere = texto[atual]
      if (escapado) { escapado = false; continue }
      if (caractere === '\\') { escapado = true; continue }
      if (caractere === '"') { dentroDeTexto = !dentroDeTexto; continue }
      if (dentroDeTexto) continue
      if (caractere === abre) profundidade += 1
      else if (caractere === fecha) {
        profundidade -= 1
        if (profundidade === 0) { fim = atual; break }
      }
    }
    if (fim < 0) break
    blocos.push(texto.slice(inicio, fim + 1))
    posicao = fim + 1
  }
  return blocos
}

/**
 * O valor que o modelo quis dizer.
 * @param value - o que o adaptador do modelo devolveu.
 * @returns o valor decodificado, pronto para o schema conferir.
 */
export function decodeModelJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const texto = (value.startsWith(BOM) ? value.slice(BOM.length) : value).trim()
  if (texto === '') throw new ModelJsonError(t('errors.invalidJson'))

  /*
    TODOS os candidatos são coletados, e não o primeiro que der certo.

    Parar no primeiro era escolher em silêncio. Uma resposta que traz um EXEMPLO
    antes da resposta de verdade — "Por exemplo: {...}. Agora: {...}" — fazia o
    produto construir o aplicativo a partir do exemplo, e ninguém saberia por quê.
  */
  const candidatos = [texto, ...corposDosBlocosCercados(texto), ...blocosBalanceados(texto)]
  const lidos: unknown[] = []
  for (const candidato of candidatos) {
    const limpo = candidato.trim()
    if (limpo === '') continue
    try {
      const valor = JSON.parse(limpo)
      // Dois candidatos que dizem a MESMA coisa não são ambiguidade: o texto
      // inteiro e o corpo da cerca são o mesmo JSON visto de dois jeitos.
      if (!lidos.some(anterior => JSON.stringify(anterior) === JSON.stringify(valor))) lidos.push(valor)
    } catch {
      // Um candidato que não é JSON não é erro: é o próximo da fila.
      continue
    }
  }
  if (lidos.length === 1) return lidos[0]
  if (lidos.length > 1) {
    /*
      NÃO escolher é a resposta certa. O schema adiante aceitaria qualquer um dos
      dois, e o errado produz um aplicativo inteiro a partir de um exemplo. Quem
      chama tem uma rodada de reparo para pedir de novo — e agora ela sabe o que
      pedir.
    */
    throw new ModelJsonAmbiguoError(t('errors.modelJsonAmbiguous', { quantos: String(lidos.length) }))
  }
  /*
    O texto do modelo NÃO entra na mensagem de erro.

    Ele pode trazer qualquer coisa que a pessoa escreveu no pedido, e a mensagem
    de erro viaja para registro, trace e tela. `gate:secrets` existe por causa
    disso, e o mesmo cuidado vale para o que um modelo devolve.
  */
  throw new ModelJsonError(t('errors.invalidJson'))
}

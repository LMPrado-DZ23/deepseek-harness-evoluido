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
  readonly code = 'MODEL_JSON_UNREADABLE'
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
  const abertura = /^[ \t]*```[a-zA-Z0-9_-]*[ \t]*\r?\n/mu.exec(texto)
  if (abertura === null) return null
  const inicio = abertura.index + abertura[0].length
  const fechamento = /^[ \t]*```[ \t]*$/mu.exec(texto.slice(inicio))
  return fechamento === null ? texto.slice(inicio) : texto.slice(inicio, inicio + fechamento.index)
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
  const inicio = texto.search(/[[{]/u)
  if (inicio < 0) return null
  const abre = texto[inicio] === '{' ? '{' : '['
  const fecha = abre === '{' ? '}' : ']'
  let profundidade = 0
  let dentroDeTexto = false
  let escapado = false
  for (let posicao = inicio; posicao < texto.length; posicao += 1) {
    const caractere = texto[posicao]
    if (escapado) { escapado = false; continue }
    if (caractere === '\\') { escapado = true; continue }
    if (caractere === '"') { dentroDeTexto = !dentroDeTexto; continue }
    if (dentroDeTexto) continue
    if (caractere === abre) profundidade += 1
    else if (caractere === fecha) {
      profundidade -= 1
      if (profundidade === 0) return texto.slice(inicio, posicao + 1)
    }
  }
  return null
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

  const tentativas = [texto, corpoDoBlocoCercado(texto), primeiroBlocoBalanceado(texto)]
  for (const candidato of tentativas) {
    if (candidato === null) continue
    const limpo = candidato.trim()
    if (limpo === '') continue
    try {
      return JSON.parse(limpo)
    } catch {
      /*
        Um candidato que não é JSON não é erro: é o próximo da fila. O erro só
        existe quando NENHUM dos três serve, e aí ele é lançado — nunca
        substituído por um objeto vazio, que faria o schema adiante reclamar de
        campo faltando em vez de dizer que a resposta era ilegível.
      */
      continue
    }
  }
  /*
    O texto do modelo NÃO entra na mensagem de erro.

    Ele pode trazer qualquer coisa que a pessoa escreveu no pedido, e a mensagem
    de erro viaja para registro, trace e tela. `gate:secrets` existe por causa
    disso, e o mesmo cuidado vale para o que um modelo devolve.
  */
  throw new ModelJsonError(t('errors.invalidJson'))
}

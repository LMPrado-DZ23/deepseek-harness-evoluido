import { z } from 'zod'
import { decodeModelJson, ModelJsonError } from './model-json.js'

/**
 * A LEITURA do pedido: o que a pessoa já disse, para não perguntar de novo.
 *
 * ## Por que um propósito próprio, e não `intake`
 *
 * `intake` serve a duas saídas de forma oposta — a especificação (JSON) e a
 * resposta recomendada (uma frase). Por isso ele não pode ter gramática. A
 * leitura é JSON fechado, e com propósito próprio ganha a sua: o servidor
 * local obriga a forma, em vez de o prompt pedir e torcer.
 *
 * ## O que ela NÃO faz
 *
 * Não inventa. Um campo que o texto não diz volta `null`, e `null` vira
 * pergunta. Uma leitura que preenchesse o que a pessoa não disse trocaria uma
 * pergunta por um palpite gravado como se fosse dela — por isso o que ela
 * extrai é gravado como resposta RECOMENDADA, que é a procedência honesta (o
 * modelo leu, a pessoa não confirmou) e tem correção pela tela.
 */

/** As perguntas que a leitura pode responder. A confirmação de dado sensível NUNCA. */
export const PERGUNTAS_DA_LEITURA = ['audience', 'goal', 'content'] as const
export type PerguntaDaLeitura = typeof PERGUNTAS_DA_LEITURA[number]

const campo = z.string().trim().max(2_000).nullable()

/** A forma que o modelo devolve. Campo extra é descartado; campo ausente é `null`. */
export const leituraSchema = z.object({
  audience: campo.default(null),
  goal: campo.default(null),
  content: campo.default(null),
})

/** O JSON Schema da leitura, para o caminho estruturado do servidor local. */
export function esquemaJsonDaLeitura(): Record<string, unknown> {
  return z.object({ audience: z.string().nullable(), goal: z.string().nullable(), content: z.string().nullable() })
    .strict().toJSONSchema() as Record<string, unknown>
}

/**
 * O que a leitura devolveu, só para as perguntas que ainda faltam.
 *
 * Uma resposta ilegível NÃO é erro para quem chamou: ela vira "não li nada", e
 * a conversa segue perguntando. A leitura é um atalho — perder o atalho não
 * pode travar o questionário, que funcionava antes dela existir.
 * @param valor - o que o modelo devolveu.
 * @param faltando - as perguntas ainda sem resposta.
 * @returns as respostas lidas, sem texto vazio.
 */
export function respostasLidas(valor: unknown, faltando: readonly PerguntaDaLeitura[]): Partial<Record<PerguntaDaLeitura, string>> {
  let decodificado: unknown
  try { decodificado = decodeModelJson(valor) } catch (erro) {
    if (erro instanceof ModelJsonError) return {}
    throw erro
  }
  const lido = leituraSchema.safeParse(decodificado)
  if (!lido.success) return {}
  const saida: Partial<Record<PerguntaDaLeitura, string>> = {}
  for (const id of faltando) {
    const texto = lido.data[id]
    if (texto !== null && texto !== '') saida[id] = texto
  }
  return saida
}

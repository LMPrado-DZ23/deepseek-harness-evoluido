import { CONVERSATION_ENDPOINT, type ConversationPort } from '../assistant/conversationApi'

/** Um lembrete como o servidor o devolve (`plugins/studio-web/src/assistant-schedules.ts`). */
export interface Lembrete {
  readonly id: string
  readonly tipo: 'uma-vez' | 'repetido'
  readonly proximo: string
  readonly atrasado: boolean
  readonly intervaloSegundos?: number
  readonly texto: string
}

export type LeituraDosLembretes =
  | { readonly estado: 'ok'; readonly lembretes: readonly Lembrete[] }
  | { readonly estado: 'ilegivel' }

function ehLembrete(valor: unknown): valor is Lembrete {
  if (typeof valor !== 'object' || valor === null) return false
  const v = valor as Record<string, unknown>
  return typeof v.id === 'string' && (v.tipo === 'uma-vez' || v.tipo === 'repetido') && typeof v.proximo === 'string'
    && typeof v.atrasado === 'boolean' && typeof v.texto === 'string'
    && (v.intervaloSegundos === undefined || typeof v.intervaloSegundos === 'number')
}

/**
 * Lê os lembretes da conversa. Resposta fora do formato vira erro, e não uma
 * lista vazia: "sem lembretes" é uma afirmação que a tela só faz com prova.
 * @param conversa - a conversa do espaço.
 * @param porta - o `fetch`.
 * @returns a leitura.
 */
export async function lerLembretes(conversa: string, porta: ConversationPort = { fetch: (a, b) => fetch(a, b) }): Promise<LeituraDosLembretes> {
  const resposta = await porta.fetch(`${CONVERSATION_ENDPOINT}/${encodeURIComponent(conversa)}/schedules`, { method: 'GET', credentials: 'same-origin' })
  if (!resposta.ok) throw new Error(String(resposta.status))
  const corpo = await resposta.json() as { estado?: unknown; lembretes?: unknown }
  if (corpo.estado === 'ilegivel') return { estado: 'ilegivel' }
  if (corpo.estado !== 'ok' || !Array.isArray(corpo.lembretes) || !corpo.lembretes.every(ehLembrete)) throw new Error('formato')
  return { estado: 'ok', lembretes: corpo.lembretes }
}

/**
 * O intervalo de um lembrete repetido, em palavras.
 * @param segundos - o intervalo.
 * @param textos - as frases do catálogo.
 * @returns o texto.
 */
export function intervaloEmTexto(segundos: number, textos: { readonly minutos: string; readonly horas: string; readonly dias: string }): string {
  if (segundos % 86_400 === 0) return textos.dias.replace('{n}', String(segundos / 86_400))
  if (segundos % 3_600 === 0) return textos.horas.replace('{n}', String(segundos / 3_600))
  return textos.minutos.replace('{n}', String(Math.round(segundos / 60)))
}

/**
 * O pedido de cancelamento, como a conversa o recebe.
 *
 * Cancelar é a ferramenta `schedule_delete` do próprio agente, dentro da
 * transação dele: a tela não apaga o registro por fora. O texto leva o
 * identificador exato, que é o argumento que a ferramenta exige.
 * @param id - o lembrete.
 * @param modelo - a frase do catálogo.
 * @returns a mensagem.
 */
export function pedidoDeCancelamento(id: string, modelo: string): string {
  return modelo.replace('{id}', id)
}

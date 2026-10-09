import { foldScheduleEvents, scheduleView } from '@deepseek-ai/dsh-schedule'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * Um lembrete da conversa, como a tela Agendado o mostra.
 *
 * A fonte é o REGISTRO da conversa, dobrado pela mesma função que o Harness
 * usa para decidir o que disparar (`foldScheduleEvents`): a tela não tem uma
 * segunda contabilidade de lembretes que pudesse discordar da que dispara.
 */
export interface LembreteDaConversa {
  readonly id: string
  /** Uma vez (depois de um tempo ou numa hora) ou a cada intervalo. */
  readonly tipo: 'uma-vez' | 'repetido'
  /** A próxima vez que ele vale, em ISO. */
  readonly proximo: string
  /** Se a hora já passou e ele espera a conversa ficar livre. */
  readonly atrasado: boolean
  /** O intervalo em segundos, só nos repetidos. */
  readonly intervaloSegundos?: number
  /** O que ele vai dizer. */
  readonly texto: string
}

/** O resultado da leitura: os lembretes, ou o aviso de que o registro não fecha. */
export type LeituraDosLembretes =
  | { readonly estado: 'ok'; readonly lembretes: readonly LembreteDaConversa[] }
  | { readonly estado: 'ilegivel' }

/**
 * Os lembretes ATIVOS de uma conversa.
 *
 * Um registro que não dobra (troca com versão desconhecida, identificador
 * reaproveitado) vira `ilegivel`, e NÃO lista vazia: "nenhum lembrete" e "não
 * consegui ler" são respostas diferentes, e a tela diz a certa.
 * @param events - o registro da conversa.
 * @param agora - o relógio, em milissegundos.
 * @returns a leitura.
 */
export function lembretesDaConversa(events: readonly SessionEvent[], agora: number): LeituraDosLembretes {
  let ativos
  try {
    ativos = foldScheduleEvents(events).active
  } catch {
    // `ScheduleLogError`/`ScheduleInputError`: o registro não fecha. Quem lê
    // recebe `ilegivel`; nenhuma outra exceção sai de uma dobra pura.
    return { estado: 'ilegivel' }
  }
  const lembretes = ativos.map(registro => {
    const visto = scheduleView(registro, agora)
    return {
      id: String(visto.id),
      tipo: visto.kind === 'every' ? 'repetido' as const : 'uma-vez' as const,
      proximo: visto.scheduledAt,
      atrasado: visto.state === 'overdue',
      ...(visto.kind === 'every' ? { intervaloSegundos: visto.everySeconds } : {}),
      texto: visto.prompt,
    }
  })
  return { estado: 'ok', lembretes: lembretes.sort((a, b) => a.proximo.localeCompare(b.proximo)) }
}

import type { AssistantConversationSnapshot } from './assistant-conversation.js'

/**
 * O laço que empurra a conversa para a tela enquanto ela acontece.
 *
 * ## O que isto é, e o que NÃO é
 *
 * A tela relia a conversa inteira a cada 1,5 segundo. Duas consequências, e a
 * segunda é a que incomoda: uma resposta pronta podia esperar um segundo e meio
 * parada até alguém perguntar por ela; e uma conversa PARADA custava uma
 * requisição a cada 1,5 s, por aba aberta, para sempre — o preço de não estar
 * acontecendo nada era o mesmo de estar acontecendo tudo.
 *
 * Aqui o servidor segura a conexão e manda o que mudou assim que vê a mudança.
 * **Ele vê relendo**: a costura do Harness (`sessions.inspect`) não oferece
 * assinatura, então não existe evento vindo de cima para reencaminhar. Chamar
 * isto de "streaming do modelo, símbolo a símbolo" seria mentira — o que a
 * pessoa ganha é latência e um navegador que para de perguntar.
 *
 * ## Por que a releitura fica no SERVIDOR e não no navegador
 *
 * Porque no servidor ela é uma leitura local por conversa, e no navegador era
 * uma requisição HTTP autenticada, atravessando a borda, por aba. Dez abas
 * abertas na mesma conversa eram dez leituras; agora continuam sendo uma cada,
 * mas sem o custo de rede — e o intervalo pode ser bem menor sem que ninguém
 * pague por isso.
 */

/** Para onde os bytes vão. Uma interface para o teste não precisar de socket. */
export interface AssistantStreamSink {
  write(chunk: string): void
  end(): void
}

export interface AssistantStreamOptions {
  /** Relê a conversa. É o mesmo `snapshot` que a rota de leitura já usa. */
  readonly read: (signal?: AbortSignal) => Promise<AssistantConversationSnapshot>
  readonly sink: AssistantStreamSink
  /** Cancela quando a pessoa fecha a aba. */
  readonly signal: AbortSignal
  /** De quanto em quanto tempo reler. */
  readonly intervalMs?: number
  /** Tempo máximo de vida da conexão. O navegador reconecta sozinho. */
  readonly maxMs?: number
  /** Injetáveis para o teste não depender de relógio de parede. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  readonly now?: () => number
}

export type AssistantStreamOutcome = 'closed' | 'expired' | 'unavailable'

/** Intervalo de releitura. Seis vezes mais rápido que o antigo 1,5 s. */
export const ASSISTANT_STREAM_INTERVAL_MS = 250
/**
 * Vida máxima de uma conexão.
 *
 * Ela EXISTE de propósito. Uma conexão eterna guarda um `inspect` em laço para
 * uma aba que a pessoa talvez tenha esquecido aberta há dias, e nenhum
 * intermediário no caminho respeita isso — ela seria cortada por fora, na hora
 * errada e sem aviso. Cortando por dentro, o fim é limpo e o `EventSource`
 * reconecta sozinho, que é o comportamento padrão dele.
 */
export const ASSISTANT_STREAM_MAX_MS = 10 * 60_000
/** Comentário periódico que impede um intermediário de matar a conexão parada. */
export const ASSISTANT_STREAM_HEARTBEAT_MS = 15_000

/** Quantas releituras seguidas podem falhar antes de encerrar. */
const READ_FAILURE_LIMIT = 3

/** Cabeçalhos da resposta. `no-transform` porque um proxy que comprime engasga. */
export const ASSISTANT_STREAM_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store, no-transform',
  connection: 'keep-alive',
  // Sem isto, um proxy que armazena em buffer segura os eventos e devolve o
  // atraso que a conexão existe para tirar.
  'x-accel-buffering': 'no',
}

function sseEvent(name: string, payload: unknown): string {
  // Uma linha `data:` por linha do JSON: um `\n` cru dentro do campo encerraria
  // o evento no meio e o navegador leria metade de um objeto.
  const body = JSON.stringify(payload).split('\n').map(line => `data: ${line}`).join('\n')
  return `event: ${name}\n${body}\n\n`
}

const defaultSleep = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  const timer = setTimeout(finish, ms)
  function finish() { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
  signal.addEventListener('abort', finish, { once: true })
})

/**
 * Segura a conexão e manda o que mudou.
 *
 * O PRIMEIRO envio é a conversa inteira, e não um "espere a próxima mudança":
 * quem acabou de abrir a tela precisa ver o que já existe. Depois disso só
 * viajam os eventos com `seq` maior que o último enviado — o diário é
 * append-only, e reenviar tudo a cada mudança desfaria o ganho.
 *
 * @param options - leitura, destino, cancelamento e os tempos.
 * @returns como a conexão terminou.
 */
export async function streamAssistantConversation(options: AssistantStreamOptions): Promise<AssistantStreamOutcome> {
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? (() => Date.now())
  const intervalMs = options.intervalMs ?? ASSISTANT_STREAM_INTERVAL_MS
  const maxMs = options.maxMs ?? ASSISTANT_STREAM_MAX_MS
  const startedAt = now()
  let lastSeq = -1
  let lastBeatAt = startedAt
  let failures = 0

  const send = (name: string, payload: unknown) => { options.sink.write(sseEvent(name, payload)) }

  try {
    while (!options.signal.aborted) {
      let snapshot: AssistantConversationSnapshot
      try {
        snapshot = await options.read(options.signal)
        failures = 0
      } catch {
        failures += 1
        // Uma falha isolada de leitura não derruba a conexão: a tela mostraria
        // um erro por causa de um soluço. Falhas SEGUIDAS derrubam, porque aí
        // não é soluço - e uma conexão viva que não entrega nada é pior que
        // uma conexão fechada, que pelo menos faz o navegador reconectar.
        if (failures >= READ_FAILURE_LIMIT) { send('unavailable', {}); return 'unavailable' }
        if (options.signal.aborted) break
        await sleep(intervalMs, options.signal)
        continue
      }
      const fresh = snapshot.events.filter(item => item.seq > lastSeq)
      if (fresh.length > 0 || lastSeq === -1) {
        send('snapshot', {
          conversation_id: snapshot.conversation_id,
          cursor: snapshot.cursor,
          truncated: snapshot.truncated,
          events: fresh,
        })
        lastSeq = fresh.reduce((highest, item) => Math.max(highest, item.seq), lastSeq)
        lastBeatAt = now()
      } else if (now() - lastBeatAt >= ASSISTANT_STREAM_HEARTBEAT_MS) {
        // Comentário SSE: mantém a conexão viva sem inventar um evento que a
        // tela teria de aprender a ignorar.
        options.sink.write(': .\n\n')
        lastBeatAt = now()
      }
      if (now() - startedAt >= maxMs) return 'expired'
      if (options.signal.aborted) break
      await sleep(intervalMs, options.signal)
    }
    return 'closed'
  } finally {
    options.sink.end()
  }
}

import { Clock } from 'lucide-react'
import { useEffect, useState } from 'react'
import copy from '../i18n/assistant.pt-BR.json'
import { ConversationRequestError, type ConversationPort } from './conversationApi'

export const STUCK_RUNS_ENDPOINT = '/studio/assistant/stuck-runs'
export const STUCK_RUNS_POLL_MS = 10_000

const RUN_ID = /^[A-Za-z0-9_.:-]{1,128}$/u

export interface StuckRun {
  readonly run_id: string
  readonly workspace_id: string
  readonly provider: string
  readonly since: string
}

/** Uma linha só é desenhada quando é inteira: meia informação aqui assusta à toa. */
export function isStuckRun(value: unknown): value is StuckRun {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return typeof row.run_id === 'string' && RUN_ID.test(row.run_id)
    && typeof row.workspace_id === 'string' && row.workspace_id !== ''
    && typeof row.provider === 'string' && row.provider !== ''
    && typeof row.since === 'string' && row.since !== ''
}

const defaultPort: ConversationPort = { fetch: (input, init) => fetch(input, init) }

export async function listStuckRuns(
  port: ConversationPort = defaultPort,
  signal?: AbortSignal,
): Promise<readonly StuckRun[]> {
  const response = await port.fetch(STUCK_RUNS_ENDPOINT, {
    method: 'GET',
    credentials: 'same-origin',
    ...(signal === undefined ? {} : { signal }),
  })
  const body = await response.json().catch(() => undefined) as { readonly runs?: unknown } | undefined
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : copy.stuckRunsError
    throw new ConversationRequestError(response.status, message, response.status >= 500)
  }
  if (!Array.isArray(body?.runs)) {
    throw new ConversationRequestError(response.status, copy.invalidServerResponse, false)
  }
  return body.runs.filter(isStuckRun)
}

export interface StuckRunsProps {
  readonly port?: ConversationPort
  readonly pollMs?: number
}

/**
 * Mostra as execuções que ficaram paradas sem prova de que terminaram.
 *
 * Por que isto existe: enquanto uma execução está nesse estado, os arquivos do
 * projeto seguem reservados. Até agora isso acontecia em silêncio. A tela diz o
 * que está preso, desde quando, e a frase exata que a pessoa pode dizer ao
 * assistente para encerrar - o encerramento continua exigindo a confirmação
 * dela, com chave de acesso e motivo escrito.
 *
 * Um erro de leitura NÃO vira "não há nada parado": esse é o único jeito de
 * a tela mentir sobre algo que continua bloqueando o trabalho.
 */
export function StuckRuns({ port, pollMs = STUCK_RUNS_POLL_MS }: StuckRunsProps) {
  const [runs, setRuns] = useState<readonly StuckRun[]>([])
  const [error, setError] = useState<ConversationRequestError | null>(null)

  useEffect(() => {
    let live = true
    const controller = new AbortController()
    const read = async (): Promise<void> => {
      try {
        const rows = await listStuckRuns(port, controller.signal)
        if (!live) return
        setRuns(rows)
        setError(null)
      } catch (caught) {
        if (!live || controller.signal.aborted) return
        setError(caught instanceof ConversationRequestError
          ? caught
          : new ConversationRequestError(0, copy.stuckRunsError, true))
      }
    }
    void read()
    const timer = setInterval(() => { void read() }, pollMs)
    return () => { live = false; controller.abort(); clearInterval(timer) }
  }, [port, pollMs])

  return <StuckRunsList runs={runs} error={error} />
}

/**
 * A parte visível, pura. Separada para que o desenho seja provável sem
 * depender de quando a leitura assíncrona termina.
 */
export function StuckRunsList({ runs, error }: {
  readonly runs: readonly StuckRun[]
  readonly error: ConversationRequestError | null
}) {
  // Nada parado e nenhuma falha de leitura: a seção some. Um aviso permanente
  // sobre um problema que não existe treina a pessoa a ignorar avisos.
  if (runs.length === 0 && error === null) return null

  return <section className="stuck-runs" aria-labelledby="stuck-runs-title">
    {/* O título não pode afirmar que há trabalho parado quando a leitura
        falhou: o cabeçalho contradiria o corpo. */}
    <h2 id="stuck-runs-title"><Clock aria-hidden="true" />{error === null ? copy.stuckRunsTitle : copy.stuckRunsUnknownTitle}</h2>
    {error === null
      ? <p className="stuck-runs-intro">{copy.stuckRunsIntro}</p>
      : <p className="error" role="alert">{error.message}</p>}
    <ul className="stuck-runs-list">
      {runs.map(run => <li key={run.run_id} className="stuck-run-item">
        <p className="stuck-run-id">{copy.stuckRunLine.replace('{run}', run.run_id).replace('{since}', formatSince(run.since))}</p>
        <p className="stuck-run-hint">{copy.stuckRunHint.replace('{run}', run.run_id)}</p>
      </li>)}
    </ul>
  </section>
}

/**
 * Data legível, e o texto original quando não dá para ler. Uma data inválida
 * nunca vira "agora": isso apagaria justamente a informação de há quanto tempo
 * os arquivos estão presos.
 */
export function formatSince(value: string): string {
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) return value
  return new Date(parsed).toLocaleString('pt-BR')
}

import { OctagonX, ShieldAlert, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import t from './i18n/pt-BR.json'

export interface EmergencyStopState {
  readonly stopped: boolean
  readonly engaged_by: string | null
  readonly engaged_at: string | null
  readonly reason: string | null
  readonly released_by: string | null
  readonly released_at: string | null
  readonly release_reason: string | null
}

/** O que o servidor conseguiu interromper, e o que ele NÃO conseguiu provar morto. */
export interface StopSurfaceOutcome {
  readonly surface: string
  readonly cancelled: number
  readonly unproven: readonly { readonly what: string; readonly why: string }[]
}

/** O tamanho mínimo do motivo da retomada, igual ao do servidor. */
export const MIN_RESUME_REASON_LENGTH = 10

/**
 * Aceita só o formato que o servidor promete.
 *
 * Desenhar meio estado seria pior aqui do que em qualquer outra tela: esta
 * responde "o Studio está parado?", e uma resposta inventada é uma resposta
 * errada sobre segurança.
 * @param value - o corpo devolvido pela rota.
 * @returns se é um estado utilizável.
 */
export function isEmergencyStopState(value: unknown): value is EmergencyStopState {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (typeof record.stopped !== 'boolean') return false
  return (['engaged_by', 'engaged_at', 'reason', 'released_by', 'released_at', 'release_reason'] as const)
    .every(field => record[field] === null || typeof record[field] === 'string')
}

/** Data legível; o texto original quando não puder ser lida, em vez de um traço mudo. */
export function formatMoment(value: string): string {
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? value : new Date(parsed).toLocaleString('pt-BR')
}

/** Um motivo de retomada só conta como motivo quando alguém escreveu algo. */
export function resumeReasonAccepted(reason: string): boolean {
  return reason.trim().length >= MIN_RESUME_REASON_LENGTH
}

export interface EmergencyStopPort {
  read(): Promise<unknown>
  engage(reason: string): Promise<unknown>
  release(reason: string): Promise<unknown>
}

const ENDPOINT = '/api/studio/apps/emergency-stop'

/** O acesso padrão à rota, com o mesmo CSRF de todas as outras mutações da tela. */
export function browserEmergencyStopPort(getCsrf: () => Promise<string>): EmergencyStopPort {
  const post = async (path: string, body: unknown): Promise<unknown> => {
    const response = await fetch(`${ENDPOINT}${path}`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-dz23-csrf': await getCsrf() },
      body: JSON.stringify(body),
    })
    const value = await response.json().catch(() => null) as { error?: string } | null
    if (!response.ok) throw new Error(value?.error ?? t.emergency.actionFailed)
    return value
  }
  return {
    async read() {
      const response = await fetch(ENDPOINT, { credentials: 'same-origin' })
      if (!response.ok) throw new Error(t.emergency.readFailed)
      return await response.json() as unknown
    },
    engage: reason => post('/engage', reason.trim() === '' ? {} : { reason: reason.trim() }),
    release: reason => post('/release', { reason: reason.trim() }),
  }
}

function stateOf(value: unknown): EmergencyStopState | null {
  const body = typeof value === 'object' && value !== null ? (value as { emergency_stop?: unknown }).emergency_stop : undefined
  return isEmergencyStopState(body) ? body : null
}

function surfacesOf(value: unknown): readonly StopSurfaceOutcome[] {
  const rows = typeof value === 'object' && value !== null ? (value as { surfaces?: unknown }).surfaces : undefined
  if (!Array.isArray(rows)) return []
  return rows.filter((row): row is StopSurfaceOutcome => typeof row === 'object' && row !== null
    && typeof (row as StopSurfaceOutcome).surface === 'string'
    && typeof (row as StopSurfaceOutcome).cancelled === 'number'
    && Array.isArray((row as StopSurfaceOutcome).unproven))
}

/**
 * O relato do aperto: o que parou e o que o Studio não pôde provar que parou.
 *
 * As duas listas existem separadas porque somá-las seria mentir na única tela
 * em que a pessoa precisa saber onde ainda olhar.
 * @param props - o resultado devolvido pelo servidor.
 * @returns a seção do relato, ou nada quando não houve aperto nesta visita.
 */
export function StopOutcome({ surfaces }: { readonly surfaces: readonly StopSurfaceOutcome[] }) {
  const cancelled = surfaces.filter(surface => surface.cancelled > 0)
  const unproven = surfaces.flatMap(surface => surface.unproven)
  if (cancelled.length === 0 && unproven.length === 0) {
    return <p className="context-note">{t.emergency.nothingRunning}</p>
  }
  return <div className="emergency-outcome">
    {cancelled.length === 0 ? null : <section>
      <h4>{t.emergency.cancelledTitle}</h4>
      <ul>{cancelled.map(surface => <li key={surface.surface}>
        {surface.surface}: {surface.cancelled} {t.emergency.cancelledCount}
      </li>)}</ul>
    </section>}
    {unproven.length === 0 ? null : <section className="emergency-unproven">
      <h4><TriangleAlert aria-hidden="true" />{t.emergency.unprovenTitle}</h4>
      <p className="context-note">{t.emergency.unprovenHelp}</p>
      <ul>{unproven.map(item => <li key={`${item.what}:${item.why}`}>
        <code dir="ltr">{item.what}</code> <span>{item.why}</span>
      </li>)}</ul>
    </section>}
  </div>
}

export interface EmergencyStopPanelProps {
  readonly state: EmergencyStopState | null
  readonly surfaces: readonly StopSurfaceOutcome[]
  readonly confirming: boolean
  readonly busy: 'engage' | 'release' | null
  readonly reason: string
  readonly resumeReason: string
  readonly error: string
  readonly onAskConfirm: () => void
  readonly onCancelConfirm: () => void
  readonly onReason: (value: string) => void
  readonly onResumeReason: (value: string) => void
  readonly onEngage: () => void
  readonly onRelease: () => void
  /** Uma linha só enquanto nada está parado — para caber junto da conversa. */
  readonly compacto?: boolean | undefined
}

/**
 * A classe da seção. Compacta SÓ enquanto o FRIGG funciona e ninguém está
 * confirmando: parado, a tela precisa mostrar quem parou, por quê e como
 * voltar, e isso nunca encolhe.
 *
 * Medido em 20/09/2026 no computador do titular (tela de 1280×672 com escala
 * de 150%): o cartão inteiro, fixo abaixo da conversa, deixava para a conversa
 * 32 pixels de altura.
 * @param compacto - se o lugar pede a versão de uma linha.
 * @param state - o estado lido, ou nada enquanto carrega.
 * @param confirming - se a pessoa está confirmando a parada.
 * @returns as classes da seção.
 */
export function classeDaParada(compacto: boolean, state: EmergencyStopState | null, confirming: boolean): string {
  return compacto && state !== null && !state.stopped && !confirming ? 'emergency-stop emergency-stop-compacto' : 'emergency-stop'
}

/**
 * O botão e o estado, sem nenhuma leitura de rede: é esta metade que o teste
 * de tela consegue exercer inteira, em todos os estados que a pessoa vê.
 * @param props - o estado e os manipuladores.
 * @returns a seção da tela.
 */
export function EmergencyStopPanel(props: EmergencyStopPanelProps) {
  const { state, busy } = props
  return <section className={classeDaParada(props.compacto === true, state, props.confirming)} aria-labelledby="emergency-title">
    <h2 id="emergency-title"><OctagonX aria-hidden="true" />{t.emergency.title}</h2>
    {state === null
      ? <p className="context-note" role="status">{props.error === '' ? t.emergency.loading : props.error}</p>
      : state.stopped
        ? <StoppedView {...props} state={state} />
        : <RunningView {...props} state={state} />}
    {state !== null && props.error !== '' ? <p className="emergency-error" role="alert">{props.error}</p> : null}
    {busy === null ? null : <p className="context-note" role="status">
      {busy === 'engage' ? t.emergency.stopping : t.emergency.resuming}
    </p>}
  </section>
}

function RunningView(props: EmergencyStopPanelProps & { readonly state: EmergencyStopState }) {
  return <>
    <p className="emergency-running">{t.emergency.runningTitle}</p>
    <p className="context-note">{t.emergency.help}</p>
    {props.state.released_by === null ? null : <p className="context-note">
      {t.emergency.releasedBy} {props.state.released_by}
      {props.state.released_at === null ? '' : ` · ${formatMoment(props.state.released_at)}`}
    </p>}
    {props.confirming
      // Parar é permitido e não pede senha - mas é grave, e uma confirmação é o
      // que separa "eu quis parar" de um toque acidental no celular.
      ? <div className="emergency-confirm">
        <h3>{t.emergency.confirmTitle}</h3>
        <p className="context-note">{t.emergency.confirmHelp}</p>
        <label htmlFor="emergency-reason">{t.emergency.reasonLabel}</label>
        <input id="emergency-reason" type="text" value={props.reason} maxLength={500}
          placeholder={t.emergency.reasonPlaceholder}
          onChange={event => { props.onReason(event.target.value) }} />
        <button type="button" className="emergency-danger" disabled={props.busy !== null} onClick={props.onEngage}>
          {t.emergency.confirmStop}
        </button>
        <button type="button" disabled={props.busy !== null} onClick={props.onCancelConfirm}>{t.emergency.cancel}</button>
      </div>
      : <button type="button" className="emergency-danger" disabled={props.busy !== null} onClick={props.onAskConfirm}>
        {t.emergency.stop}
      </button>}
  </>
}

function StoppedView(props: EmergencyStopPanelProps & { readonly state: EmergencyStopState }) {
  const { state } = props
  const accepted = resumeReasonAccepted(props.resumeReason)
  return <>
    <p className="emergency-stopped" role="alert"><ShieldAlert aria-hidden="true" />{t.emergency.stoppedTitle}</p>
    <p>{t.emergency.stoppedNothingNew}</p>
    <dl className="emergency-facts">
      <dt>{t.emergency.stoppedBy}</dt><dd>{state.engaged_by ?? ''}</dd>
      <dt>{t.emergency.stoppedAt}</dt><dd>{state.engaged_at === null ? '' : formatMoment(state.engaged_at)}</dd>
      <dt>{t.emergency.stoppedReason}</dt><dd>{state.reason ?? t.emergency.noReason}</dd>
    </dl>
    <StopOutcome surfaces={props.surfaces} />
    <section className="emergency-resume">
      <h3>{t.emergency.resumeTitle}</h3>
      {/* A tela DIZ o que falta para voltar. Uma parada sem caminho de volta
          escrito vira um chamado de suporte no pior momento possível. */}
      <p className="context-note">{t.emergency.resumeHelp}</p>
      <label htmlFor="emergency-resume-reason">{t.emergency.resumeReasonLabel}</label>
      <textarea id="emergency-resume-reason" value={props.resumeReason} maxLength={500} rows={2}
        placeholder={t.emergency.resumeReasonPlaceholder}
        onChange={event => { props.onResumeReason(event.target.value) }} />
      {props.resumeReason !== '' && !accepted
        ? <p className="context-note">{t.emergency.resumeReasonShort}</p>
        : null}
      <button type="button" disabled={props.busy !== null || !accepted} onClick={props.onRelease}>
        {t.emergency.resume}
      </button>
    </section>
  </>
}

/**
 * O botão de emergência ligado ao servidor.
 *
 * A tela nunca decide sozinha que o Studio voltou: todo estado exibido é o que
 * a rota devolveu. Enquanto a primeira leitura não chega, ela diz que está
 * lendo, em vez de afirmar que está tudo funcionando.
 * @param props - o acesso à rota.
 * @returns a seção da tela.
 */
export function EmergencyStop({ port, compacto }: { readonly port: EmergencyStopPort; readonly compacto?: boolean }) {
  const [state, setState] = useState<EmergencyStopState | null>(null)
  const [surfaces, setSurfaces] = useState<readonly StopSurfaceOutcome[]>([])
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState<'engage' | 'release' | null>(null)
  const [reason, setReason] = useState('')
  const [resumeReason, setResumeReason] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let live = true
    void port.read()
      .then(value => {
        if (!live) return
        const read = stateOf(value)
        if (read === null) setError(t.emergency.readFailed); else { setState(read); setError('') }
      })
      .catch((cause: unknown) => { if (live) setError(cause instanceof Error ? cause.message : t.emergency.readFailed) })
    return () => { live = false }
  }, [port])

  const engage = useCallback(async () => {
    setBusy('engage'); setError('')
    try {
      const value = await port.engage(reason)
      const read = stateOf(value)
      if (read === null) { setError(t.emergency.actionFailed); return }
      setState(read); setSurfaces(surfacesOf(value)); setConfirming(false); setReason('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t.emergency.actionFailed)
    } finally { setBusy(null) }
  }, [port, reason])

  const release = useCallback(async () => {
    setBusy('release'); setError('')
    try {
      const value = await port.release(resumeReason)
      const read = stateOf(value)
      if (read === null) { setError(t.emergency.actionFailed); return }
      // O relato do aperto só vale enquanto a parada durou: mantê-lo depois da
      // retomada faria a tela mostrar interrupções antigas como atuais.
      setState(read); setSurfaces([]); setResumeReason('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t.emergency.actionFailed)
    } finally { setBusy(null) }
  }, [port, resumeReason])

  return <EmergencyStopPanel
    state={state} surfaces={surfaces} confirming={confirming} busy={busy}
    reason={reason} resumeReason={resumeReason} error={error}
    onAskConfirm={() => { setConfirming(true) }}
    onCancelConfirm={() => { setConfirming(false) }}
    onReason={setReason} onResumeReason={setResumeReason}
    onEngage={() => { void engage() }} onRelease={() => { void release() }}
    compacto={compacto}
  />
}

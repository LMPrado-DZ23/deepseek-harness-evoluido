import { Bell, LogOut, Menu, Sparkles, UserRound } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, apiResponse, type HealthState } from './api'
import type { Category } from './categories'
import t from './i18n/pt-BR.json'
import { currentStepIndex, permanentTruthKind, privacyNotice, resultSentence, type ProjectUiState } from './presentation'
import { apiFailureMessage, apiFailureText, type ApiCallKind } from './pwa/apiFailure'
import { GENERATION_REJECTED_STATE, postGeneration, startGeneration } from './pwa/generation'
import { NotificationOptIn } from './pwa/NotificationOptIn'
import { dispatchGenerationFinished } from './pwa/notifications'
import { signOutInBrowser } from './session/signOut'
import { currentSessionMode } from './session/currentSession'
import { StudioSidebar } from './Navigation'
import { NAV_MENU_ID, activeNavId } from './navigation'

type DesignPreset = 'modern' | 'professional' | 'colorful' | 'brand'
type Question = { id: 'audience' | 'goal' | 'content' | 'sensitive-confirmation'; text: string }
type Plan = { slices: Array<{ slice_id: string; title: string; description: string; acceptance_criteria: string[] }> }
type AcceptanceCheck = { id: string; label: string; status: 'PENDING' | 'PASSED' | 'FAILED' | 'NOT_AUTOMATED' }
type VerificationCode = { email: string; code: string; expires_at: string }
type PipelineResult = { state: 'VERIFIED_PROTOTYPE' | 'BUILD_FAILED' | 'TESTS_FAILED' | 'BLOCKED_EXTERNAL' | 'CANCELLED' | 'INTERRUPTED'; attempts: number; message: string; checks?: AcceptanceCheck[]; verificationCodes?: VerificationCode[] }
type ProjectDetails = { project: { state: ProjectUiState }; current_run: null | { operation_id: string; state: 'PENDING' | 'RUNNING' | 'PASSED' | 'FAILED' | 'BLOCKED_EXTERNAL' | 'BUDGET_EXCEEDED' | 'CANCELLED'; stage: string; attempt: number; failure_code: string | null; acceptance_checks: AcceptanceCheck[]; verification_codes?: VerificationCode[] } }
type Preview = { preview_id: string; state: 'REQUESTED' | 'STARTING' | 'READY' | 'STOPPING' | 'STOPPED' | 'FAILED' | 'EXPIRED'; health: 'PENDING' | 'OK' | 'DOWN'; url: string; expires_at: string }
const steps = [
  [t.progress.idea, t.progress.ideaDetail], [t.progress.questions, t.progress.questionsDetail],
  [t.progress.plan, t.progress.planDetail], [t.progress.creation, t.progress.creationDetail],
  [t.progress.verification, t.progress.verificationDetail],
] as const

export function App() {
  const [brief, setBrief] = useState('')
  const [category, setCategory] = useState<Category>('landing-page')
  const [privacy, setPrivacy] = useState<'local-only' | 'any'>('local-only')
  const [designPreset, setDesignPreset] = useState<DesignPreset>('modern')
  const [brandColor, setBrandColor] = useState('#075ee5')
  const [font, setFont] = useState<'geist-sans' | 'source-serif'>('geist-sans')
  const [radius, setRadius] = useState<'compact' | 'balanced' | 'rounded'>('balanced')
  const [density, setDensity] = useState<'compact' | 'comfortable'>('comfortable')
  const [tone, setTone] = useState<'friendly' | 'formal'>('friendly')
  const [logo, setLogo] = useState<File | null>(null)
  const [showDesignAdvanced, setShowDesignAdvanced] = useState(false)
  const [route, setRoute] = useState<string | null>(null)
  const [projectId, setProjectId] = useState<string | null>(null)
  const [projectState, setProjectState] = useState<ProjectUiState | null>(null)
  const [question, setQuestion] = useState<Question | null>(null)
  const [answer, setAnswer] = useState('')
  const [plan, setPlan] = useState<Plan | null>(null)
  const [changeReason, setChangeReason] = useState('')
  const [result, setResult] = useState<PipelineResult | null>(null)
  const [health, setHealth] = useState<HealthState>({ state: 'ATTENTION', route: null, builder: 'BLOCKED_EXTERNAL', disk: 'ATTENTION' })
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [admissionTicket, setAdmissionTicket] = useState<string | null>(null)
  const [previewCodes, setPreviewCodes] = useState<VerificationCode[]>([])
  const [signingOut, setSigningOut] = useState(false)
  const [authenticatedSession, setAuthenticatedSession] = useState(false)
  const previewFrame = useRef<HTMLIFrameElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuButton = useRef<HTMLButtonElement>(null)
  // Fechar devolve o foco ao botão que abriu: sem isso, quem navega por teclado
  // ou leitor de tela é largado no começo da página depois de fechar a gaveta.
  function closeMenu() { setMenuOpen(false); menuButton.current?.focus() }
  useEffect(() => {
    if (!menuOpen) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { setMenuOpen(false); menuButton.current?.focus() } }
    window.addEventListener('keydown', onKey)
    document.body.classList.add('menu-open')
    return () => { window.removeEventListener('keydown', onKey); document.body.classList.remove('menu-open') }
  }, [menuOpen])
  useEffect(() => {
    let active = true
    void currentSessionMode().then(mode => { if (active) setAuthenticatedSession(mode === 'authenticated') })
    return () => { active = false }
  }, [])
  useEffect(() => { void api<HealthState>('/health').then(value => { setHealth(value); setRoute(value.route) }).catch((cause: unknown) => {
    const message = apiFailureMessage(cause, navigator.onLine, 'read')
    if (message !== undefined) setError(message)
  }) }, [])
  useEffect(() => {
    if (preview === null) return
    const previewOrigin = new URL(preview.url).origin
    const receive = (event: MessageEvent) => {
      if (event.origin !== previewOrigin || event.source !== previewFrame.current?.contentWindow || typeof event.data !== 'object' || event.data === null) return
      const type = (event.data as { readonly type?: unknown }).type
      if (type === 'DZ23_PREVIEW_READY' && admissionTicket !== null) {
        previewFrame.current?.contentWindow?.postMessage({ type: 'DZ23_PREVIEW_ADMISSION', ticket: admissionTicket }, previewOrigin)
      }
      if (type === 'DZ23_PREVIEW_ADMITTED') {
        setAdmissionTicket(null)
        refreshPreviewAdmission(preview.url)
      }
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [preview, admissionTicket])
  useEffect(() => {
    if (projectId === null || preview?.state !== 'READY') return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      try {
        const response = await api<{ messages: VerificationCode[] }>(`/projects/${projectId}/previews/${encodeURIComponent(preview.preview_id)}/messages`)
        if (active) setPreviewCodes(response.messages)
      } catch { /* A prévia continua utilizável; a falha é mostrada na próxima ação explícita. */ }
      if (active) timer = setTimeout(() => { void refresh() }, 1_500)
    }
    void refresh()
    return () => { active = false; if (timer !== undefined) clearTimeout(timer) }
  }, [projectId, preview?.preview_id, preview?.state])
  useEffect(() => {
    if (projectId === null || preview?.state !== 'READY') return
    let active = true
    const heartbeat = () => {
      void api<{ preview: Preview }>(`/projects/${projectId}/previews/${encodeURIComponent(preview.preview_id)}/heartbeat`, { method: 'POST', body: '{}' })
        .then(response => {
          if (active) {
            setPreview(response.preview)
            setError('')
            refreshPreviewAdmission(response.preview.url)
          }
        })
        .catch((cause: unknown) => { if (active) setError(apiFailureText(cause, navigator.onLine, 'mutation', t.preview.heartbeatFailed)) })
    }
    heartbeat()
    const timer = setInterval(heartbeat, 30_000)
    return () => { active = false; clearInterval(timer) }
  }, [projectId, preview?.preview_id, preview?.state])
  const ready = useMemo(() => brief.trim().length >= 10, [brief])
  async function safely(action: () => Promise<void>, call: ApiCallKind = 'mutation') {
    setError('')
    try { await action() } catch (cause) { setError(apiFailureText(cause, navigator.onLine, call, t.health.attention)) }
  }
  async function create() {
    if (!ready) { setError(t.idea.empty); return }
    await safely(async () => {
      const created = await api<{ project: { project_id: string; state: ProjectUiState }; next: Question }>('/projects', {
        method: 'POST', body: JSON.stringify({ name: brief.trim().slice(0, 60), original_brief: brief.trim(), category, privacy }),
      })
      setProjectId(created.project.project_id); setProjectState(created.project.state); setQuestion(created.next)
      await api(`/projects/${created.project.project_id}/design`, {
        method: 'POST', body: JSON.stringify({ preset: designPreset, ...(designPreset === 'brand' ? { primary: hexToHsl(brandColor) } : {}), font, radius, density, tone }),
      })
      if (logo !== null) await api(`/projects/${created.project.project_id}/design/logo`, { method: 'POST', body: logo, headers: { 'content-type': logo.type } })
    })
  }
  async function submitAnswer(recommend: boolean, confirmSensitive?: boolean) {
    if (projectId === null) return
    await safely(async () => {
      const response = await api<{ next?: Question | null; spec?: unknown; blocked?: boolean; message?: string }>(`/projects/${projectId}/intake/answer`, {
        method: 'POST', body: JSON.stringify({ answer, recommend, ...(confirmSensitive === undefined ? {} : { confirm_sensitive: confirmSensitive }) }),
      })
      if (response.blocked === true) { setError(response.message ?? t.health.attention); return }
      setAnswer(''); setQuestion(response.next ?? null)
      if (response.next == null) setProjectState('SPEC_READY')
    })
  }
  async function preparePlan() {
    if (projectId === null) return
    await safely(async () => { const response = await api<{ plan: Plan }>(`/projects/${projectId}/plan`, { method: 'POST', body: '{}' }); setPlan(response.plan); setProjectState('PLAN_PROPOSED') })
  }
  async function approvePlan() {
    if (projectId === null) return
    await safely(async () => { await api(`/projects/${projectId}/plan/approve`, { method: 'POST', body: '{}' }); setProjectState('PLAN_APPROVED') })
  }
  async function requestPlanChange() {
    if (projectId === null || changeReason.trim().length < 3) return
    await safely(async () => {
      await api(`/projects/${projectId}/plan/change`, { method: 'POST', body: JSON.stringify({ reason: changeReason.trim() }) })
      setPlan(null); setChangeReason('')
    })
  }
  async function generate() {
    if (projectId === null) return
    setError('')
    const started = await startGeneration(
      () => postGeneration(projectId, (path, init) => apiResponse(path, init)),
      () => navigator.onLine,
      t.health.attention,
    )
    if (started.runId === null) {
      setProjectState(GENERATION_REJECTED_STATE)
      setError(started.message)
      return
    }
    setResult(null)
    setProjectState('GENERATING')
    await safely(() => pollProject(started.runId), 'read')
  }
  async function pollProject(runId: string) {
    if (projectId === null) return
    for (let poll = 0; poll < 1_800; poll++) {
      const details = await api<ProjectDetails>(`/projects/${projectId}`)
      const current = details.current_run
      if (current?.operation_id !== runId) {
        await new Promise(resolve => setTimeout(resolve, 250))
        continue
      }
      setProjectState(details.project.state)
      if (current?.operation_id === runId && ['PASSED', 'FAILED', 'BLOCKED_EXTERNAL', 'BUDGET_EXCEEDED', 'CANCELLED'].includes(current.state)) {
        const state: PipelineResult['state'] = details.project.state === 'INTERRUPTED' ? 'INTERRUPTED'
          : current.state === 'PASSED' ? 'VERIFIED_PROTOTYPE'
          : current.state === 'BLOCKED_EXTERNAL' ? 'BLOCKED_EXTERNAL'
            : current.state === 'CANCELLED' ? 'CANCELLED'
              : current.stage === 'test' ? 'TESTS_FAILED' : 'BUILD_FAILED'
        setResult({ state, attempts: current.attempt, message: current.failure_code ?? (state === 'VERIFIED_PROTOTYPE' ? t.truth.verified : t.verification.failure), checks: current.acceptance_checks, ...(current.verification_codes === undefined ? {} : { verificationCodes: current.verification_codes }) })
        if (state === 'BLOCKED_EXTERNAL') setProjectState('PLAN_APPROVED')
        dispatchGenerationFinished(window, { state, runId })
        return
      }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    throw new Error(t.verification.failure)
  }
  async function cancelGeneration() {
    if (projectId === null) return
    await safely(async () => { await api(`/projects/${projectId}/generate/cancel`, { method: 'POST', body: '{}' }) })
  }
  async function startPreview() {
    if (projectId === null) return
    await safely(async () => {
      const started = await api<{ preview: Preview; admission: { ticket: string } }>(`/projects/${projectId}/previews`, { method: 'POST', body: '{}' })
      setPreview(started.preview)
      setAdmissionTicket(started.admission.ticket)
      setPreviewCodes([])
    })
  }
  async function stopPreview() {
    if (projectId === null || preview === null) return
    await safely(async () => {
      const stopped = await api<{ preview: Preview }>(`/projects/${projectId}/previews/${encodeURIComponent(preview.preview_id)}`, { method: 'DELETE', body: '{}' })
      setPreview(stopped.preview)
      setAdmissionTicket(null)
      setPreviewCodes([])
    })
  }
  async function signOut() {
    setError('')
    setSigningOut(true)
    try { await signOutInBrowser() }
    catch { setError(t.account.signOutFailed); setSigningOut(false) }
  }
  function chooseSuggestion(value: string, selected: Category) { setBrief(value); setCategory(selected) }
  return <div className="shell">
    <StudioSidebar active={activeNavId(window.location.pathname)} open={menuOpen} onClose={closeMenu} />
    {menuOpen ? <button type="button" className="drawer-scrim" aria-label={t.mobile.close} onClick={closeMenu} /> : null}
    <section className="workspace"><header className="topbar"><button ref={menuButton} type="button" className="mobile-menu" aria-label={menuOpen ? t.mobile.close : t.mobile.menu} aria-expanded={menuOpen} aria-controls={NAV_MENU_ID} onClick={() => setMenuOpen(!menuOpen)}><Menu aria-hidden="true" /></button><Status health={health} /><div className="top-actions"><NotificationOptIn /><Bell aria-hidden="true" /><UserRound aria-hidden="true" />{authenticatedSession ? <button className="signout-button" type="button" disabled={signingOut} aria-busy={signingOut} onClick={() => void signOut()}><LogOut aria-hidden="true" /><span>{signingOut ? t.account.signingOut : t.account.signOut}</span></button> : null}</div></header>
      <main className="canvas"><section className="idea-panel">
        {projectState === null ? <Idea brief={brief} setBrief={setBrief} privacy={privacy} setPrivacy={setPrivacy} route={route ?? health.route} ready={ready} chooseSuggestion={chooseSuggestion} create={create}
          designPreset={designPreset} setDesignPreset={setDesignPreset} brandColor={brandColor} setBrandColor={setBrandColor}
          font={font} setFont={setFont} radius={radius} setRadius={setRadius} density={density} setDensity={setDensity}
          tone={tone} setTone={setTone} logo={logo} setLogo={setLogo} showDesignAdvanced={showDesignAdvanced} setShowDesignAdvanced={setShowDesignAdvanced} /> : null}
        {projectState === 'DRAFT' && question !== null ? <Questions question={question} answer={answer} setAnswer={setAnswer} submit={submitAnswer} /> : null}
        {projectState === 'SPEC_READY' ? <Action title={t.plan.title} detail={t.progress.planDetail} button={t.plan.prepare} action={preparePlan} /> : null}
        {projectState === 'PLAN_PROPOSED' && plan !== null ? <PlanView plan={plan} approve={approvePlan} reason={changeReason} setReason={setChangeReason} requestChange={requestPlanChange} /> : null}
        {projectState === 'PLAN_PROPOSED' && plan === null ? <Action title={t.plan.title} detail={t.progress.planDetail} button={t.plan.revision} action={preparePlan} /> : null}
        {projectState === 'PLAN_APPROVED' ? <Action title={t.creation.title} detail={t.truth.creation} button={t.creation.start} action={generate} /> : null}
        {projectState === 'GENERATING' || projectState === 'BUILD_OK' || projectState === 'TESTS_OK' ? <Action title={t.creation.title} detail={t.creation.working} button={t.creation.cancel} action={cancelGeneration} /> : null}
        {result !== null ? <Verification result={result} previewActive={preview?.state === 'READY'} startPreview={startPreview} retry={generate} /> : null}
        {preview?.state === 'READY' ? <section className="preview-card"><div className="preview-heading"><div><h2>{t.preview.title}</h2><p>{t.preview.localOnly}</p></div><button className="secondary compact" onClick={() => void stopPreview()}>{t.preview.stop}</button></div><p className="truth">{t.preview.notPublished}</p>{previewCodes.length === 0 ? null : <section className="preview-codes" aria-live="polite"><h3>{t.preview.accessCodes}</h3><p>{t.preview.accessCodesHelp}</p><ul>{previewCodes.map(item => <li key={`${item.email}-${item.expires_at}-${item.code}`}><strong>{item.email}</strong>: <code>{item.code}</code></li>)}</ul></section>}<iframe ref={previewFrame} title={t.preview.frameTitle} src={`${preview.url}/__dz23/admission`} sandbox="allow-scripts allow-forms allow-same-origin" referrerPolicy="no-referrer" /></section> : null}
        {preview !== null && ['FAILED', 'EXPIRED', 'STOPPED'].includes(preview.state) ? <p className="context-note">{t.preview.closed}</p> : null}
        {error === '' ? null : <p className="error" role="alert">{error}</p>}
      </section><Progress state={projectState} /></main>
    </section>
  </div>
}

function Idea(props: {
  brief: string; setBrief(v: string): void; privacy: 'local-only' | 'any'; setPrivacy(v: 'local-only' | 'any'): void; route: string | null; ready: boolean; chooseSuggestion(v: string, c: Category): void; create(): Promise<void>
  designPreset: DesignPreset; setDesignPreset(v: DesignPreset): void; brandColor: string; setBrandColor(v: string): void
  font: 'geist-sans' | 'source-serif'; setFont(v: 'geist-sans' | 'source-serif'): void; radius: 'compact' | 'balanced' | 'rounded'; setRadius(v: 'compact' | 'balanced' | 'rounded'): void
  density: 'compact' | 'comfortable'; setDensity(v: 'compact' | 'comfortable'): void; tone: 'friendly' | 'formal'; setTone(v: 'friendly' | 'formal'): void
  logo: File | null; setLogo(v: File | null): void; showDesignAdvanced: boolean; setShowDesignAdvanced(v: boolean): void
}) {
  const presets: Array<[DesignPreset, string, string]> = [
    ['modern', t.design.modern, t.design.modernDetail], ['professional', t.design.professional, t.design.professionalDetail],
    ['colorful', t.design.colorful, t.design.colorfulDetail], ['brand', t.design.brand, t.design.brandDetail],
  ]
  return <><div className="heading"><Sparkles aria-hidden="true"/><div><h1>{t.idea.title}</h1><p>{t.idea.subtitle}</p></div></div><label className="sr-only" htmlFor="brief">{t.idea.title}</label>
    <textarea id="brief" maxLength={1000} value={props.brief} onChange={event => props.setBrief(event.target.value)} placeholder={t.idea.placeholder} /><div className="counter" aria-live="polite">{props.brief.length} {t.idea.counter}</div>
    <h2>{t.idea.suggestions}</h2><button className="suggestion" onClick={() => props.chooseSuggestion(t.idea.landing, 'landing-page')}>{t.idea.landing}</button><button className="suggestion" onClick={() => props.chooseSuggestion(t.idea.catalog, 'catalog')}>{t.idea.catalog}</button><button className="suggestion" onClick={() => props.chooseSuggestion(t.idea.formDatabase, 'form-database')}>{t.idea.formDatabase}</button><button className="suggestion" onClick={() => props.chooseSuggestion(t.idea.crudPanel, 'crud-panel')}>{t.idea.crudPanel}</button><button className="suggestion" onClick={() => props.chooseSuggestion(t.idea.scheduling, 'scheduling')}>{t.idea.scheduling}</button><button className="suggestion" onClick={() => props.chooseSuggestion(t.idea.dashboard, 'dashboard')}>{t.idea.dashboard}</button><button className="suggestion" onClick={() => props.chooseSuggestion(t.idea.saas, 'saas-authenticated')}>{t.idea.saas}</button><p className="coming">{t.idea.betaNotice}</p>
    <h2>{t.design.title}</h2><p className="coming">{t.design.subtitle}</p><div className="design-grid">{presets.map(([value, label, detail]) => <button type="button" key={value} className={props.designPreset === value ? 'design-card selected' : 'design-card'} aria-pressed={props.designPreset === value} onClick={() => props.setDesignPreset(value)}><strong>{label}</strong><span>{detail}</span></button>)}</div>
    <button type="button" className="advanced" aria-expanded={props.showDesignAdvanced} onClick={() => props.setShowDesignAdvanced(!props.showDesignAdvanced)}>{props.showDesignAdvanced ? t.design.hideAdvanced : t.design.advanced}</button>
    {props.showDesignAdvanced ? <section className="design-advanced">
      {props.designPreset === 'brand' ? <label>{t.design.primaryColor}<input type="color" value={props.brandColor} onChange={event => props.setBrandColor(event.target.value)} /></label> : null}
      <label>{t.design.font}<select value={props.font} onChange={event => props.setFont(event.target.value as typeof props.font)}><option value="geist-sans">{t.design.fontSans}</option><option value="source-serif">{t.design.fontSerif}</option></select></label>
      <label>{t.design.radius}<select value={props.radius} onChange={event => props.setRadius(event.target.value as typeof props.radius)}><option value="compact">{t.design.radiusCompact}</option><option value="balanced">{t.design.radiusBalanced}</option><option value="rounded">{t.design.radiusRounded}</option></select></label>
      <label>{t.design.density}<select value={props.density} onChange={event => props.setDensity(event.target.value as typeof props.density)}><option value="compact">{t.design.densityCompact}</option><option value="comfortable">{t.design.densityComfortable}</option></select></label>
      <label>{t.design.tone}<select value={props.tone} onChange={event => props.setTone(event.target.value as typeof props.tone)}><option value="friendly">{t.design.toneFriendly}</option><option value="formal">{t.design.toneFormal}</option></select></label>
      <label>{t.design.logo}<input type="file" accept="image/png,image/jpeg" onChange={event => props.setLogo(event.target.files?.[0] ?? null)} /></label><small>{props.logo === null ? t.design.logoHelp : props.logo.name}</small>
    </section> : null}
    <fieldset><legend>{t.privacy.title}</legend><label><input type="radio" checked={props.privacy === 'local-only'} onChange={() => props.setPrivacy('local-only')} />{t.privacy.local}</label><label><input type="radio" checked={props.privacy === 'any'} onChange={() => props.setPrivacy('any')} />{t.privacy.configured}{props.route === null ? '' : ` (${props.route})`}</label></fieldset>
    <p className="privacy-notice">{privacyNotice(props.privacy, props.route, t.privacy)}</p><p className="context-note">{t.truth.idea}</p><button className="primary" disabled={!props.ready} onClick={() => void props.create()}>{t.idea.continue}</button></>
}
function Questions({ question, answer, setAnswer, submit }: { question: Question; answer: string; setAnswer(v: string): void; submit(recommend: boolean, confirm?: boolean): Promise<void> }) {
  const sensitive = question.id === 'sensitive-confirmation'
  return <><div className="heading"><Sparkles/><div><h1>{t.questions.title}</h1><p>{t.questions.subtitle}</p></div></div><section className="task-card"><h2>{question.text}</h2>{sensitive ? <div className="button-row"><button className="primary" onClick={() => void submit(false, true)}>{t.questions.confirm}</button><button className="secondary" onClick={() => void submit(false, false)}>{t.questions.reject}</button></div> : <><label htmlFor="answer">{t.questions.answer}</label><textarea id="answer" value={answer} onChange={event => setAnswer(event.target.value)} placeholder={t.questions.answerPlaceholder}/><button className="primary" disabled={answer.trim() === ''} onClick={() => void submit(false)}>{t.questions.continue}</button><button className="secondary" onClick={() => void submit(true)}>{t.questions.recommend}</button></>}</section></>
}
function PlanView({ plan, approve, reason, setReason, requestChange }: { plan: Plan; approve(): Promise<void>; reason: string; setReason(v: string): void; requestChange(): Promise<void> }) { return <><div className="heading"><Sparkles/><div><h1>{t.plan.title}</h1><p>{t.progress.planDetail}</p></div></div><div className="plan-list">{plan.slices.map(slice => <section className="task-card" key={slice.slice_id}><h2>{slice.title}</h2><p>{slice.description}</p><strong>{t.plan.criterion}</strong><ul>{slice.acceptance_criteria.map(value => <li key={value}>{value}</li>)}</ul></section>)}</div><button className="primary" onClick={() => void approve()}>{t.plan.approve}</button><section className="task-card"><h2>{t.plan.change}</h2><label htmlFor="change-reason">{t.plan.changeLabel}</label><textarea id="change-reason" value={reason} onChange={event => setReason(event.target.value)} placeholder={t.plan.changePlaceholder}/><button className="secondary" disabled={reason.trim().length < 3} onClick={() => void requestChange()}>{t.plan.sendChange}</button></section></> }
function Action({ title, detail, button, action }: { title: string; detail: string; button?: string; action?: () => Promise<void> }) { return <><div className="heading"><Sparkles/><div><h1>{title}</h1><p>{detail}</p></div></div>{button === undefined || action === undefined ? null : <button className="primary" onClick={() => void action()}>{button}</button>}</> }
function Verification({ result, previewActive, startPreview, retry }: { result: PipelineResult; previewActive: boolean; startPreview(): Promise<void>; retry(): Promise<void> }) { const ok = result.state === 'VERIFIED_PROTOTYPE'; const cancelled = result.state === 'CANCELLED'; const interrupted = result.state === 'INTERRUPTED'; return <section className="task-card"><h1>{t.verification.title}</h1><p>{resultSentence(result.state, t.verification)}</p><p>{t.verification.attempts}: {result.attempts}</p>{ok && !previewActive ? <button className="primary" onClick={() => void startPreview()}>{t.preview.open}</button> : null}{interrupted ? <button className="primary" onClick={() => void retry()}>{t.creation.retry}</button> : null}{result.verificationCodes === undefined || result.verificationCodes.length === 0 ? null : <section><h2>{t.verification.testCodes}</h2><p>{t.verification.testCodesHelp}</p><ul>{result.verificationCodes.map(item => <li key={`${item.email}-${item.expires_at}-${item.code}`}><strong>{item.email}</strong>: <code>{item.code}</code></li>)}</ul></section>}{result.checks === undefined ? null : <><h2>{t.verification.checks}</h2><ul>{result.checks.map(check => <li key={check.id}>{check.label}: {checkStatus(check.status)}</li>)}</ul></>}<details className="result-technical"><summary>{t.verification.technicalTitle}</summary><p>{t.verification.technicalCode}: <code>{result.state}</code></p>{result.message === '' ? null : <p>{t.verification.technicalFailure}: <code>{result.message}</code></p>}</details></section> }

function refreshPreviewAdmission(previewUrl: string): void {
  const probe = document.createElement('iframe')
  probe.hidden = true
  probe.setAttribute('aria-hidden', 'true')
  probe.setAttribute('sandbox', '')
  probe.referrerPolicy = 'no-referrer'
  const timeout = window.setTimeout(() => probe.remove(), 5_000)
  const remove = () => {
    window.clearTimeout(timeout)
    probe.remove()
  }
  probe.addEventListener('load', remove, { once: true })
  probe.addEventListener('error', remove, { once: true })
  probe.src = new URL(`/__dz23/refresh?at=${Date.now()}`, previewUrl).toString()
  document.body.append(probe)
}
function checkStatus(status: AcceptanceCheck['status']): string { return status === 'PASSED' ? t.verification.passed : status === 'FAILED' ? t.verification.failed : status === 'NOT_AUTOMATED' ? t.verification.notAutomated : t.verification.pending }
function Status({ health }: { health: HealthState }) { const ok = health.state === 'OK'; return <button className={ok ? 'status ok' : 'status attention'} aria-label={ok ? t.health.ok : t.health.attention}><span />{ok ? t.health.ok : t.health.attention}</button> }
function Progress({ state }: { state: ProjectUiState | null }) { const current = currentStepIndex(state); const truthKind = permanentTruthKind(state); return <section className="progress-panel" aria-label={t.progress.title}><h2>{t.progress.title}</h2><p className="mobile-progress-subtitle">{t.mobile.subtitle}</p><ol>{steps.map(([title, detail], index) => <li key={title} className={index === current ? 'current' : ''}><span className="step-number">{index + 1}</span><div><strong>{index + 1}. {title}</strong><p>{detail}</p><small>{index < current ? t.progress.done : index === current ? t.progress.current : t.progress.waiting}</small></div></li>)}</ol>{truthKind === null ? null : <p className="truth">{t.truth[truthKind]}</p>}</section> }

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const value = Number.parseInt(hex.slice(1), 16); const r = ((value >> 16) & 255) / 255; const g = ((value >> 8) & 255) / 255; const b = (value & 255) / 255
  const max = Math.max(r, g, b); const min = Math.min(r, g, b); const delta = max - min; const l = (max + min) / 2
  let h = 0
  if (delta !== 0) h = max === r ? 60 * (((g - b) / delta) % 6) : max === g ? 60 * ((b - r) / delta + 2) : 60 * ((r - g) / delta + 4)
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1))
  return { h: Math.round((h + 360) % 360), s: Math.round(s * 100), l: Math.round(l * 100) }
}

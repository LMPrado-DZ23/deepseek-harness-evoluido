import { Bell, CircleHelp, Eye, FolderKanban, Home, LineChart, Menu, Settings, Sparkles, UserRound } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { api, type HealthState } from './api'
import t from './i18n/pt-BR.json'
import { currentStepIndex, permanentTruthKind, privacyNotice, type ProjectUiState } from './presentation'

type Category = 'landing-page' | 'catalog'
type Question = { id: 'audience' | 'goal' | 'content' | 'sensitive-confirmation'; text: string }
type Plan = { slices: Array<{ slice_id: string; title: string; description: string; acceptance_criteria: string[] }> }
type AcceptanceCheck = { id: string; label: string; status: 'PENDING' | 'PASSED' | 'FAILED' | 'NOT_AUTOMATED' }
type PipelineResult = { state: 'VERIFIED_PROTOTYPE' | 'BUILD_FAILED' | 'TESTS_FAILED' | 'BLOCKED_EXTERNAL' | 'CANCELLED'; attempts: number; message: string; checks?: AcceptanceCheck[] }
type ProjectDetails = { project: { state: ProjectUiState }; current_run: null | { operation_id: string; state: 'PENDING' | 'RUNNING' | 'PASSED' | 'FAILED' | 'BLOCKED_EXTERNAL' | 'BUDGET_EXCEEDED' | 'CANCELLED'; stage: string; attempt: number; failure_code: string | null; acceptance_checks: AcceptanceCheck[] } }
const steps = [
  [t.progress.idea, t.progress.ideaDetail], [t.progress.questions, t.progress.questionsDetail],
  [t.progress.plan, t.progress.planDetail], [t.progress.creation, t.progress.creationDetail],
  [t.progress.verification, t.progress.verificationDetail],
] as const

export function App() {
  const [brief, setBrief] = useState('')
  const [category, setCategory] = useState<Category>('landing-page')
  const [privacy, setPrivacy] = useState<'local-only' | 'any'>('local-only')
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
  useEffect(() => { void api<HealthState>('/health').then(value => { setHealth(value); setRoute(value.route) }).catch(() => undefined) }, [])
  const ready = useMemo(() => brief.trim().length >= 10, [brief])
  async function safely(action: () => Promise<void>) { setError(''); try { await action() } catch (cause) { setError(cause instanceof Error ? cause.message : t.health.attention) } }
  async function create() {
    if (!ready) { setError(t.idea.empty); return }
    await safely(async () => {
      const created = await api<{ project: { project_id: string; state: ProjectUiState }; next: Question }>('/projects', {
        method: 'POST', body: JSON.stringify({ name: brief.trim().slice(0, 60), original_brief: brief.trim(), category, privacy }),
      })
      setProjectId(created.project.project_id); setProjectState(created.project.state); setQuestion(created.next)
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
    setProjectState('GENERATING')
    await safely(async () => {
      const response = await api<{ run_id: string }>(`/projects/${projectId}/generate`, { method: 'POST', body: '{}' })
      await pollProject(response.run_id)
    })
  }
  async function pollProject(runId: string) {
    if (projectId === null) return
    for (let poll = 0; poll < 1_800; poll++) {
      const details = await api<ProjectDetails>(`/projects/${projectId}`)
      setProjectState(details.project.state)
      const current = details.current_run
      if (current?.operation_id === runId && ['PASSED', 'FAILED', 'BLOCKED_EXTERNAL', 'BUDGET_EXCEEDED', 'CANCELLED'].includes(current.state)) {
        const state: PipelineResult['state'] = current.state === 'PASSED' ? 'VERIFIED_PROTOTYPE'
          : current.state === 'BLOCKED_EXTERNAL' ? 'BLOCKED_EXTERNAL'
            : current.state === 'CANCELLED' ? 'CANCELLED'
              : current.stage === 'test' ? 'TESTS_FAILED' : 'BUILD_FAILED'
        setResult({ state, attempts: current.attempt, message: current.failure_code ?? (state === 'VERIFIED_PROTOTYPE' ? t.truth.verified : t.verification.failure), checks: current.acceptance_checks })
        if (state === 'BLOCKED_EXTERNAL') setProjectState('PLAN_APPROVED')
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
  function chooseSuggestion(value: string, selected: Category) { setBrief(value); setCategory(selected) }
  return <div className="shell">
    <aside className="sidebar"><img src="/studio/brand/dz23-studio-logo.jpg" alt={t.brand} className="brand" /><nav aria-label={t.brand}>
      <Nav icon={<Home />} label={t.nav.home} active /><Nav icon={<FolderKanban />} label={t.nav.projects} /><Nav icon={<LineChart />} label={t.nav.progress} /><Nav icon={<Eye />} label={t.nav.result} />
    </nav><div className="sidebar-footer"><button aria-label={t.nav.help}><CircleHelp /></button><button aria-label={t.nav.settings}><Settings /></button></div></aside>
    <section className="workspace"><header className="topbar"><button className="mobile-menu" aria-label={t.mobile.menu}><Menu /></button><Status health={health} /><div className="top-actions"><Bell /><UserRound /></div></header>
      <main className="canvas"><section className="idea-panel">
        {projectState === null ? <Idea brief={brief} setBrief={setBrief} privacy={privacy} setPrivacy={setPrivacy} route={route ?? health.route} ready={ready} chooseSuggestion={chooseSuggestion} create={create} /> : null}
        {projectState === 'DRAFT' && question !== null ? <Questions question={question} answer={answer} setAnswer={setAnswer} submit={submitAnswer} /> : null}
        {projectState === 'SPEC_READY' ? <Action title={t.plan.title} detail={t.progress.planDetail} button={t.plan.prepare} action={preparePlan} /> : null}
        {projectState === 'PLAN_PROPOSED' && plan !== null ? <PlanView plan={plan} approve={approvePlan} reason={changeReason} setReason={setChangeReason} requestChange={requestPlanChange} /> : null}
        {projectState === 'PLAN_PROPOSED' && plan === null ? <Action title={t.plan.title} detail={t.progress.planDetail} button={t.plan.revision} action={preparePlan} /> : null}
        {projectState === 'PLAN_APPROVED' ? <Action title={t.creation.title} detail={t.truth.creation} button={t.creation.start} action={generate} /> : null}
        {projectState === 'GENERATING' || projectState === 'BUILD_OK' || projectState === 'TESTS_OK' ? <Action title={t.creation.title} detail={t.creation.working} button={t.creation.cancel} action={cancelGeneration} /> : null}
        {result !== null ? <Verification result={result} /> : null}
        {error === '' ? null : <p className="error" role="alert">{error}</p>}
      </section><Progress state={projectState} /></main>
    </section>
  </div>
}

function Idea(props: { brief: string; setBrief(v: string): void; privacy: 'local-only' | 'any'; setPrivacy(v: 'local-only' | 'any'): void; route: string | null; ready: boolean; chooseSuggestion(v: string, c: Category): void; create(): Promise<void> }) {
  return <><div className="heading"><Sparkles aria-hidden="true"/><div><h1>{t.idea.title}</h1><p>{t.idea.subtitle}</p></div></div><label className="sr-only" htmlFor="brief">{t.idea.title}</label>
    <textarea id="brief" maxLength={1000} value={props.brief} onChange={event => props.setBrief(event.target.value)} placeholder={t.idea.placeholder} /><div className="counter" aria-live="polite">{props.brief.length} {t.idea.counter}</div>
    <h2>{t.idea.suggestions}</h2><button className="suggestion" onClick={() => props.chooseSuggestion(t.idea.landing, 'landing-page')}>{t.idea.landing}</button><button className="suggestion" onClick={() => props.chooseSuggestion(t.idea.catalog, 'catalog')}>{t.idea.catalog}</button><p className="coming">{t.idea.coming}</p>
    <fieldset><legend>{t.privacy.title}</legend><label><input type="radio" checked={props.privacy === 'local-only'} onChange={() => props.setPrivacy('local-only')} />{t.privacy.local}</label><label><input type="radio" checked={props.privacy === 'any'} onChange={() => props.setPrivacy('any')} />{t.privacy.configured}{props.route === null ? '' : ` (${props.route})`}</label></fieldset>
    <p className="privacy-notice">{privacyNotice(props.privacy, props.route, t.privacy)}</p><p className="context-note">{t.truth.idea}</p><button className="primary" disabled={!props.ready} onClick={() => void props.create()}>{t.idea.continue}</button><button className="advanced">{t.idea.advanced}</button></>
}
function Questions({ question, answer, setAnswer, submit }: { question: Question; answer: string; setAnswer(v: string): void; submit(recommend: boolean, confirm?: boolean): Promise<void> }) {
  const sensitive = question.id === 'sensitive-confirmation'
  return <><div className="heading"><Sparkles/><div><h1>{t.questions.title}</h1><p>{t.questions.subtitle}</p></div></div><section className="task-card"><h2>{question.text}</h2>{sensitive ? <div className="button-row"><button className="primary" onClick={() => void submit(false, true)}>{t.questions.confirm}</button><button className="secondary" onClick={() => void submit(false, false)}>{t.questions.reject}</button></div> : <><label htmlFor="answer">{t.questions.answer}</label><textarea id="answer" value={answer} onChange={event => setAnswer(event.target.value)} placeholder={t.questions.answerPlaceholder}/><button className="primary" disabled={answer.trim() === ''} onClick={() => void submit(false)}>{t.questions.continue}</button><button className="secondary" onClick={() => void submit(true)}>{t.questions.recommend}</button></>}</section></>
}
function PlanView({ plan, approve, reason, setReason, requestChange }: { plan: Plan; approve(): Promise<void>; reason: string; setReason(v: string): void; requestChange(): Promise<void> }) { return <><div className="heading"><Sparkles/><div><h1>{t.plan.title}</h1><p>{t.progress.planDetail}</p></div></div><div className="plan-list">{plan.slices.map(slice => <section className="task-card" key={slice.slice_id}><h2>{slice.title}</h2><p>{slice.description}</p><strong>{t.plan.criterion}</strong><ul>{slice.acceptance_criteria.map(value => <li key={value}>{value}</li>)}</ul></section>)}</div><button className="primary" onClick={() => void approve()}>{t.plan.approve}</button><section className="task-card"><h2>{t.plan.change}</h2><label htmlFor="change-reason">{t.plan.changeLabel}</label><textarea id="change-reason" value={reason} onChange={event => setReason(event.target.value)} placeholder={t.plan.changePlaceholder}/><button className="secondary" disabled={reason.trim().length < 3} onClick={() => void requestChange()}>{t.plan.sendChange}</button></section></> }
function Action({ title, detail, button, action }: { title: string; detail: string; button?: string; action?: () => Promise<void> }) { return <><div className="heading"><Sparkles/><div><h1>{title}</h1><p>{detail}</p></div></div>{button === undefined || action === undefined ? null : <button className="primary" onClick={() => void action()}>{button}</button>}</> }
function Verification({ result }: { result: PipelineResult }) { const ok = result.state === 'VERIFIED_PROTOTYPE'; const cancelled = result.state === 'CANCELLED'; return <section className="task-card"><h1>{t.verification.title}</h1><p>{ok ? t.verification.success : cancelled ? t.verification.cancelled : t.verification.failure}</p><p>{t.verification.attempts}: {result.attempts}</p><code>{result.state}</code><p>{result.message}</p>{result.checks === undefined ? null : <><h2>{t.verification.checks}</h2><ul>{result.checks.map(check => <li key={check.id}>{check.label}: {checkStatus(check.status)}</li>)}</ul></>}</section> }
function checkStatus(status: AcceptanceCheck['status']): string { return status === 'PASSED' ? t.verification.passed : status === 'FAILED' ? t.verification.failed : status === 'NOT_AUTOMATED' ? t.verification.notAutomated : t.verification.pending }
function Nav({ icon, label, active = false }: { icon: React.ReactNode; label: string; active?: boolean }) { return <button className={active ? 'nav active' : 'nav'}>{icon}<span>{label}</span></button> }
function Status({ health }: { health: HealthState }) { const ok = health.state === 'OK'; return <button className={ok ? 'status ok' : 'status attention'} aria-label={ok ? t.health.ok : t.health.attention}><span />{ok ? t.health.ok : t.health.attention}</button> }
function Progress({ state }: { state: ProjectUiState | null }) { const current = currentStepIndex(state); const truthKind = permanentTruthKind(state); return <section className="progress-panel" aria-label={t.progress.title}><h2>{t.progress.title}</h2><p className="mobile-progress-subtitle">{t.mobile.subtitle}</p><ol>{steps.map(([title, detail], index) => <li key={title} className={index === current ? 'current' : ''}><span className="step-number">{index + 1}</span><div><strong>{index + 1}. {title}</strong><p>{detail}</p><small>{index < current ? t.progress.done : index === current ? t.progress.current : t.progress.waiting}</small></div></li>)}</ol>{truthKind === null ? null : <p className="truth">{t.truth[truthKind]}</p>}</section> }

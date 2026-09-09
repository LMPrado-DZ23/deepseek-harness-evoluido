import { LogOut, Menu, Sparkles } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, apiResponse, csrfToken, type HealthState } from './api'
import { PendingButton } from './PendingButton'
import { STUDIO_CATEGORIES, type Category } from './categories'
import t from './i18n/pt-BR.json'
import { categoryGuess, type CategoryGuess } from './categorySuggestion'
import { attemptSentence, stageSentence, type RunningStage } from './creationProgress'

/** De onde veio o tipo mostrado na tela. `person` é a escolha à mão, que o palpite não faz. */
type CategoryBasis = CategoryGuess['basis'] | 'person'
import { creationBlocked, currentStepIndex, permanentTruthKind, privacyNotice, resultSentence, routeReasonNotice, type PipelineResultState, type PrivacyProfile, type ProjectUiState } from './presentation'
import { apiFailureMessage, apiFailureText, type ApiCallKind } from './pwa/apiFailure'
import { GENERATION_REJECTED_STATE, postGeneration, startGeneration } from './pwa/generation'
import { NotificationOptIn } from './pwa/NotificationOptIn'
import { browserEmergencyStopPort, EmergencyStop } from './EmergencyStop'
import { Checkpoints, RunReport, isCheckpointList, isRunReport, type CheckpointListValue, type RunReportValue } from './RunReport'
import { dispatchGenerationFinished } from './pwa/notifications'
import { signOutInBrowser } from './session/signOut'
import { currentSessionMode } from './session/currentSession'
import { StudioSidebar } from './Navigation'
import { NAV_MENU_ID, activeNavId } from './navigation'
import { PlanEditor } from './plan/PlanEditor'
import type { PlanEditRequest } from './plan/planEdit'

type DesignPreset = 'modern' | 'professional' | 'colorful' | 'brand'
type Question = { id: 'audience' | 'goal' | 'content' | 'sensitive-confirmation'; text: string }
type Plan = { revision?: number; edited_by_person?: boolean; slices: Array<{ slice_id: string; title: string; description: string; acceptance_criteria: string[] }> }
// `label` é o identificador de máquina (`page:Início`); `title` é a mesma
// conferência em português. A tela lê o título e mantém o identificador ao lado,
// pequeno, porque é ele que se cola num pedido de ajuda.
type AcceptanceCheck = { id: string; label: string; title?: string; status: 'PENDING' | 'PASSED' | 'FAILED' | 'NOT_AUTOMATED' }
type VerificationCode = { email: string; code: string; expires_at: string }
// O estado final vem do MESMO tipo que a frase usa: duas listas separadas foi
// como `BUDGET_EXCEEDED` acabou sem frase própria.
type PipelineResult = { state: PipelineResultState; attempts: number; message: string; checks?: AcceptanceCheck[]; verificationCodes?: VerificationCode[] }
type ProjectDetails = { project: { state: ProjectUiState }; plan?: Plan | null; current_run: null | { operation_id: string; state: 'PENDING' | 'RUNNING' | 'PASSED' | 'FAILED' | 'BLOCKED_EXTERNAL' | 'BUDGET_EXCEEDED' | 'CANCELLED'; stage: string; attempt: number; failure_code: string | null; acceptance_checks: AcceptanceCheck[]; verification_codes?: VerificationCode[] } }
type Preview = { preview_id: string; state: 'REQUESTED' | 'STARTING' | 'READY' | 'STOPPING' | 'STOPPED' | 'FAILED' | 'EXPIRED'; health: 'PENDING' | 'OK' | 'DOWN'; url: string; expires_at: string }
/**
 * O acesso do botão de emergência à rota, criado UMA vez fora do componente.
 * Recriá-lo a cada pintura faria a tela reler o estado sem parar, e a leitura
 * roda em um efeito que depende dele.
 */
const emergencyPort = browserEmergencyStopPort(csrfToken)
/**
 * Os três perfis na ordem em que a tela os oferece, cada um com a frase que
 * diz o que ele faz com os dados de quem escreve. O nome sozinho ("Equilibrado")
 * não conta nada a quem não programa: o que decide a escolha é a frase.
 */
const PRIVACY_PROFILES: ReadonlyArray<readonly [PrivacyProfile, string, string]> = [
  ['privado-local', t.privacy.privadoLocal, t.privacy.privadoLocalDetail],
  ['equilibrado', t.privacy.equilibrado, t.privacy.equilibradoDetail],
  ['melhor-qualidade', t.privacy.melhorQualidade, t.privacy.melhorQualidadeDetail],
]
const steps = [
  [t.progress.idea, t.progress.ideaDetail], [t.progress.questions, t.progress.questionsDetail],
  [t.progress.plan, t.progress.planDetail], [t.progress.creation, t.progress.creationDetail],
  [t.progress.verification, t.progress.verificationDetail],
] as const

export function App() {
  const [brief, setBrief] = useState('')
  const [category, setCategory] = useState<Category>('landing-page')
  const [privacy, setPrivacy] = useState<PrivacyProfile>('privado-local')
  const [designPreset, setDesignPreset] = useState<DesignPreset>('modern')
  const [brandColor, setBrandColor] = useState('#075ee5')
  const [font, setFont] = useState<'geist-sans' | 'source-serif'>('geist-sans')
  const [radius, setRadius] = useState<'compact' | 'balanced' | 'rounded'>('balanced')
  const [density, setDensity] = useState<'compact' | 'comfortable'>('comfortable')
  const [tone, setTone] = useState<'friendly' | 'formal'>('friendly')
  const [logo, setLogo] = useState<File | null>(null)
  const [showDesignAdvanced, setShowDesignAdvanced] = useState(false)
  const [categoryChosenByPerson, setCategoryChosenByPerson] = useState(false)
  // Quatro estados, porque a tela tem quatro coisas diferentes a dizer:
  // entendi o pedido, reconheci só o ramo, não entendi nada, e - o quarto -
  // foi VOCÊ quem escolheu. Dizer "entendemos isto pelo seu texto" depois de a
  // pessoa corrigir o tipo à mão é a mesma mentira dos outros casos, com o
  // agravante de que ela sabe que não foi assim.
  const [categoryBasis, setCategoryBasis] = useState<CategoryBasis>('none')
  // A etapa da execução em curso, lida do mesmo laço que já acompanha o estado.
  const [running, setRunning] = useState<RunningStage | null>(null)
  const [route, setRoute] = useState<string | null>(null)
  const [projectId, setProjectId] = useState<string | null>(null)
  const [projectState, setProjectState] = useState<ProjectUiState | null>(null)
  const [question, setQuestion] = useState<Question | null>(null)
  const [answer, setAnswer] = useState('')
  const [plan, setPlan] = useState<Plan | null>(null)
  const [changeReason, setChangeReason] = useState('')
  const [result, setResult] = useState<PipelineResult | null>(null)
  const [health, setHealth] = useState<HealthState>({ state: 'UNKNOWN', route: null, builder: 'BLOCKED_EXTERNAL', disk: 'ATTENTION' })
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [admissionTicket, setAdmissionTicket] = useState<string | null>(null)
  const [previewCodes, setPreviewCodes] = useState<VerificationCode[]>([])
  const [signingOut, setSigningOut] = useState(false)
  const [authenticatedSession, setAuthenticatedSession] = useState(false)
  const [runReport, setRunReport] = useState<RunReportValue | null>(null)
  const [checkpoints, setCheckpoints] = useState<CheckpointListValue | null>(null)
  const [confirmingUndo, setConfirmingUndo] = useState<string | null>(null)
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
  /**
   * Um projeto sobrevive a recarregar a página.
   *
   * O identificador do projeto só existia na memória desta tela: recarregar,
   * clicar em qualquer item do menu (que navega de verdade, com recarga) ou
   * fechar a aba sem querer apagava o trabalho inteiro da vista — e não há
   * "Meus projetos" para reencontrá-lo. Agora ele fica no endereço, e a tela o
   * lê ao abrir.
   *
   * A restauração é DELIBERADAMENTE parcial: ela só assume o projeto quando
   * existe plano ou execução, ou seja, quando há para onde a pessoa voltar.
   * Restaurar no meio das perguntas deixaria a tela sem a próxima pergunta e a
   * pessoa presa numa etapa sem saída - pior do que recomeçar.
   */
  useEffect(() => {
    const saved = savedProjectOf(window.location.href)
    if (saved === null) return
    let active = true
    void api<ProjectDetails>(`/projects/${saved}`).then(details => {
      if (!active) return
      const plan = details.plan ?? null
      if (plan === null && details.current_run === null) { forgetSavedProject(); return }
      setProjectId(saved)
      setProjectState(details.project.state)
      setPlan(plan)
      // E o RESULTADO, quando a execução já terminou: sem isto, recarregar
      // depois da criação devolvia uma coluna vazia — sem os critérios, sem o
      // relato, sem os pontos seguros e sem o botão de ver o protótipo —
      // enquanto a coluna ao lado dizia "Protótipo verificado".
      const finished = resultOfRun(details)
      if (finished !== null) {
        setResult(finished)
        void refreshRunReport(saved)
        void api<unknown>(`/projects/${saved}/checkpoints`)
          .then(response => { if (active) setCheckpoints(isCheckpointList(response) ? response : null) })
          .catch(() => { if (active) setCheckpoints(null) })
      }
    }).catch(() => { if (active) forgetSavedProject() })
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
      setProjectId(created.project.project_id); rememberProject(created.project.project_id); setProjectState(created.project.state); setQuestion(created.next)
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
  /** E-03: manda UMA alteração e adota o plano que voltou, com a revisão nova. */
  async function editPlan(edit: PlanEditRequest) {
    if (projectId === null) return
    await safely(async () => {
      const response = await api<{ plan: Plan }>(`/projects/${projectId}/plan/edit`, { method: 'POST', body: JSON.stringify(edit) })
      setPlan(response.plan)
    })
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
    setRunReport(null)
    setCheckpoints(null)
    setConfirmingUndo(null)
    setProjectState('GENERATING')
    await safely(() => pollProject(started.runId), 'read')
  }
  /**
   * Acompanha uma criação até ela terminar.
   *
   * Duas coisas aqui já foram erradas e viraram regra. A primeira: o limite era
   * de 1800 voltas de 250 ms — 7 min e meio de espera para uma execução que
   * pode levar mais de 9 (três tentativas de 180 s), e ao estourar a tela dizia
   * `verification.failure`, isto é, culpava uma verificação que nunca reprovou.
   * Agora o limite é de RELÓGIO, folgado, e o que ele diz é a verdade: esta
   * tela perdeu o acompanhamento, a criação segue no computador.
   *
   * A segunda: uma única leitura que falhasse (rede oscilando, servidor
   * reiniciando) encerrava o acompanhamento para sempre. Agora ela tolera
   * falhas seguidas e só desiste quando elas param de ser exceção.
   */
  async function pollProject(runId: string) {
    if (projectId === null) return
    const deadline = Date.now() + 30 * 60_000
    let consecutiveFailures = 0
    while (Date.now() < deadline) {
      let details: ProjectDetails
      try {
        details = await api<ProjectDetails>(`/projects/${projectId}`)
        consecutiveFailures = 0
      } catch (cause) {
        consecutiveFailures += 1
        if (consecutiveFailures > 20) throw cause
        await new Promise(resolve => setTimeout(resolve, 1_000))
        continue
      }
      const current = details.current_run
      if (current?.operation_id !== runId) {
        await new Promise(resolve => setTimeout(resolve, 250))
        continue
      }
      setProjectState(details.project.state)
      setRunning(current === null ? null : { stage: current.stage, attempt: current.attempt })
      if (current?.operation_id === runId && ['PASSED', 'FAILED', 'BLOCKED_EXTERNAL', 'BUDGET_EXCEEDED', 'CANCELLED'].includes(current.state)) {
        const finished = resultOfRun(details)!
        const state = finished.state
        setResult(finished)
        if (state === 'BLOCKED_EXTERNAL') setProjectState('PLAN_APPROVED')
        // O relato é lido DEPOIS que a execução termina: é ele que tira a
        // pessoa de um código em inglês e mostra o que realmente aconteceu.
        await refreshRunReport(projectId)
        // Depois do relato vem a pergunta seguinte de quem acabou de ver uma
        // falha: para onde eu volto? A resposta pode ser "não há ponto seguro",
        // e ela vem com o motivo — inventar um verde aqui seria pior do que
        // dizer que não há.
        await refreshCheckpoints()
        dispatchGenerationFinished(window, { state, runId })
        return
      }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    throw new Error(t.verification.followLost)
  }
  /** O relato do que aconteceu, para a tela que acabou de abrir e para a que acompanhou. */
  async function refreshRunReport(project: string) {
    await api<{ report: unknown }>(`/projects/${project}/report`)
      .then(response => { setRunReport(isRunReport(response.report) ? response.report : null) })
      .catch(() => { setRunReport(null) })
  }
  async function refreshCheckpoints() {
    if (projectId === null) return
    await api<unknown>(`/projects/${projectId}/checkpoints`)
      .then(response => { setCheckpoints(isCheckpointList(response) ? response : null) })
      .catch(() => { setCheckpoints(null) })
  }
  /**
   * Volta para um ponto seguro. NADA é apagado: o servidor não toca em disco, e
   * o que muda é qual tentativa o Studio mostra como atual.
   * @param runId - a tentativa escolhida.
   */
  async function undoToCheckpoint(runId: string) {
    if (projectId === null) return
    await safely(async () => {
      const undone = await api<{ project: { state: ProjectUiState } }>(`/projects/${projectId}/undo`, {
        method: 'POST', body: JSON.stringify({ run_id: runId }),
      })
      setConfirmingUndo(null)
      setProjectState(undone.project.state)
      await refreshCheckpoints()
    })
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
  /**
   * Uma sugestão pronta preenche o texto SÓ quando não há texto.
   *
   * Antes ela sobrescrevia o que a pessoa tinha escrito, e como a categoria só
   * mudava por aqui, não havia como ter o texto próprio e a categoria certa ao
   * mesmo tempo: corrigir a categoria custava a ideia inteira.
   */
  function chooseSuggestion(value: string, selected: Category) {
    if (brief.trim() === '') setBrief(value)
    setCategory(selected)
    setCategoryChosenByPerson(true)
    setCategoryBasis('person')
  }
  /** A pessoa corrigiu o tipo: o palpite para de mexer nisso. */
  function chooseCategory(selected: Category) { setCategory(selected); setCategoryChosenByPerson(true); setCategoryBasis('person') }
  /**
   * Enquanto a pessoa escreve, o palpite acompanha — até ela corrigir.
   *
   * O palpite é local e determinístico (`suggestCategory`): nada sai do
   * computador para descobrir o tipo do aplicativo.
   */
  function updateBrief(value: string) {
    setBrief(value)
    if (categoryChosenByPerson) return
    const guess = categoryGuess(value)
    setCategory(guess.category)
    setCategoryBasis(guess.basis)
  }
  return <div className="shell">
    <StudioSidebar active={activeNavId(window.location.pathname)} open={menuOpen} onClose={closeMenu} />
    {menuOpen ? <div className="drawer-scrim" aria-hidden="true" onClick={closeMenu} /> : null}
    <section className="workspace"><header className="topbar"><button ref={menuButton} type="button" className="mobile-menu" aria-label={t.mobile.menu} aria-expanded={menuOpen} aria-controls={NAV_MENU_ID} onClick={() => setMenuOpen(!menuOpen)}><Menu aria-hidden="true" /></button><Status health={health} />{/* O sino e o boneco eram ÍCONES: sem `button`, sem destino, sem ação. Para
        quem olha, são o sino e a conta de qualquer aplicativo — e clicar não
        fazia nada. Saíram; o que existe de verdade continua aqui. */}
      <div className="top-actions"><NotificationOptIn />{authenticatedSession ? <button className="signout-button" type="button" disabled={signingOut} aria-busy={signingOut} onClick={() => void signOut()}><LogOut aria-hidden="true" /><span>{signingOut ? t.account.signingOut : t.account.signOut}</span></button> : null}</div></header>
      <main className="canvas"><section className="idea-panel">
        {projectState === null ? <Idea brief={brief} setBrief={updateBrief} privacy={privacy} setPrivacy={setPrivacy} route={route ?? health.route} localRoute={health.local_route} routeReason={health.route_reason_code ?? null} ready={ready} chooseSuggestion={chooseSuggestion} category={category} categoryBasis={categoryBasis} chooseCategory={chooseCategory} create={create}
          designPreset={designPreset} setDesignPreset={setDesignPreset} brandColor={brandColor} setBrandColor={setBrandColor}
          font={font} setFont={setFont} radius={radius} setRadius={setRadius} density={density} setDensity={setDensity}
          tone={tone} setTone={setTone} logo={logo} setLogo={setLogo} showDesignAdvanced={showDesignAdvanced} setShowDesignAdvanced={setShowDesignAdvanced} /> : null}
        {projectState === 'DRAFT' && question !== null ? <Questions question={question} answer={answer} setAnswer={setAnswer} submit={submitAnswer} /> : null}
        {projectState === 'SPEC_READY' ? <Action title={t.plan.title} detail={t.progress.planDetail} button={t.plan.prepare} busyButton={t.plan.prepareBusy} action={preparePlan} /> : null}
        {projectState === 'PLAN_PROPOSED' && plan !== null ? <PlanEditor plan={plan} submit={editPlan} approve={approvePlan} reason={changeReason} setReason={setChangeReason} requestChange={requestPlanChange} /> : null}
        {projectState === 'PLAN_PROPOSED' && plan === null ? <Action title={t.plan.title} detail={t.progress.planDetail} button={t.plan.revision} busyButton={t.plan.revisionBusy} action={preparePlan} /> : null}
        {projectState === 'PLAN_APPROVED' ? <Action title={t.creation.title} detail={t.truth.creation} button={t.creation.start} busyButton={t.creation.startBusy} action={generate} /> : null}
        {projectState === 'GENERATING' || projectState === 'BUILD_OK' || projectState === 'TESTS_OK' ? <Action title={t.creation.title} detail={t.creation.working} button={t.creation.cancel} busyButton={t.creation.cancelBusy} action={cancelGeneration} progress={running} /> : null}
        {result !== null ? <Verification result={result} previewActive={preview?.state === 'READY'} startPreview={startPreview} retry={generate} /> : null}
        {runReport === null ? null : <RunReport report={runReport} />}
        {checkpoints === null ? null : <Checkpoints list={checkpoints} confirmingRunId={confirmingUndo}
          askConfirm={setConfirmingUndo} cancelConfirm={() => setConfirmingUndo(null)}
          undo={runId => void undoToCheckpoint(runId)}
          {...(result === null || result.state === 'VERIFIED_PROTOTYPE' ? {} : { restart: () => void generate() })} />}
        {preview?.state === 'READY' ? <section className="preview-card"><div className="preview-heading"><div><h2>{t.preview.title}</h2><p>{t.preview.localOnly}</p></div><PendingButton className="secondary compact" label={t.preview.stop} busyLabel={t.preview.stopBusy} action={stopPreview} /></div><p className="truth">{t.preview.notPublished}</p>{previewCodes.length === 0 ? null : <section className="preview-codes" aria-live="polite"><h3>{t.preview.accessCodes}</h3><p>{t.preview.accessCodesHelp}</p><ul>{previewCodes.map(item => <li key={`${item.email}-${item.expires_at}-${item.code}`}><strong>{item.email}</strong>: <code>{item.code}</code></li>)}</ul></section>}<iframe ref={previewFrame} title={t.preview.frameTitle} src={`${preview.url}/__dz23/admission`} sandbox="allow-scripts allow-forms allow-same-origin" referrerPolicy="no-referrer" /></section> : null}
        {preview !== null && ['FAILED', 'EXPIRED', 'STOPPED'].includes(preview.state) ? <p className="context-note">{t.preview.closed}</p> : null}
        {error === '' ? null : <p className="error" role="alert">{error}</p>}
        {/* O botão de emergência fica VISÍVEL o tempo todo, e não escondido em
            configurações: quem precisa dele está com pressa. */}
        <EmergencyStop port={emergencyPort} />
      </section><Progress state={projectState} /></main>
    </section>
  </div>
}

/**
 * As sugestões prontas, e quais delas são protótipo INICIAL.
 *
 * O terceiro campo é a honestidade chegando na hora da escolha, e não num
 * parágrafo embaixo dos sete botões.
 */
const SUGGESTIONS: readonly (readonly [string, Category, boolean])[] = [
  [t.idea.landing, 'landing-page', false],
  [t.idea.catalog, 'catalog', false],
  [t.idea.formDatabase, 'form-database', false],
  [t.idea.crudPanel, 'crud-panel', false],
  [t.idea.scheduling, 'scheduling', true],
  [t.idea.dashboard, 'dashboard', true],
  [t.idea.saas, 'saas-authenticated', true],
]

function Idea(props: {
  brief: string; setBrief(v: string): void; privacy: PrivacyProfile; setPrivacy(v: PrivacyProfile): void; route: string | null; localRoute: string | null | undefined; routeReason: string | null; ready: boolean; chooseSuggestion(v: string, c: Category): void; category: Category; categoryBasis: CategoryBasis; chooseCategory(v: Category): void; create(): Promise<void>
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
    <h2>{t.idea.kindTitle}</h2><p className="coming">{props.categoryBasis === 'text' ? t.idea.kindHelp : props.categoryBasis === 'trade' ? t.idea.kindHelpTrade : props.categoryBasis === 'person' ? t.idea.kindHelpChosen : t.idea.kindHelpUnknown}</p>
    <label className="kind">{t.idea.kindLabel}<select value={props.category} onChange={event => props.chooseCategory(event.target.value as Category)}>{STUDIO_CATEGORIES.map(value => <option key={value} value={value}>{t.idea.kinds[value]}</option>)}</select></label>
    <h2>{t.idea.suggestions}</h2>
    {/* O aviso de que três destas sugestões são protótipos iniciais ficava
        SOZINHO embaixo das sete, depois do ponto de decisão, e exigia que a
        pessoa casasse três palavras com três dos sete botões. O selo vai no
        próprio cartão, onde ela escolhe. */}
    {SUGGESTIONS.map(([text, category, early]) => <button key={category} className="suggestion" onClick={() => props.chooseSuggestion(text, category)}>
      {text}{early ? <span className="badge-beta">{t.idea.betaBadge}</span> : null}
    </button>)}
    <p className="coming">{t.idea.betaNotice}</p>
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
    <fieldset className="privacy-profiles"><legend>{t.privacy.title}</legend>{PRIVACY_PROFILES.map(([value, label, detail]) => <label key={value}><input type="radio" name="privacy-profile" checked={props.privacy === value} onChange={() => props.setPrivacy(value)} /><strong>{label}</strong><span>{detail}</span></label>)}</fieldset>
    <p className="privacy-notice">{privacyNotice(props.privacy, props.route, t.privacy, props.localRoute)}</p>{routeReasonNotice(props.privacy, props.routeReason, t.privacy.reasons) === null ? null : <p className="privacy-notice">{t.privacy.routeReason} {routeReasonNotice(props.privacy, props.routeReason, t.privacy.reasons)}</p>}<p className="context-note">{t.truth.idea}</p><PendingButton label={t.idea.continue} busyLabel={t.idea.continueBusy} disabled={!props.ready || creationBlocked(props.privacy, props.localRoute)} action={props.create} /></>
}
function Questions({ question, answer, setAnswer, submit }: { question: Question; answer: string; setAnswer(v: string): void; submit(recommend: boolean, confirm?: boolean): Promise<void> }) {
  const sensitive = question.id === 'sensitive-confirmation'
  return <><div className="heading"><Sparkles/><div><h1>{t.questions.title}</h1><p>{t.questions.subtitle}</p></div></div><section className="task-card"><h2>{question.text}</h2>{sensitive ? <div className="button-row"><PendingButton label={t.questions.confirm} busyLabel={t.questions.confirmBusy} action={() => submit(false, true)} /><PendingButton className="secondary" label={t.questions.reject} busyLabel={t.questions.rejectBusy} action={() => submit(false, false)} /></div> : <><label htmlFor="answer">{t.questions.answer}</label><textarea id="answer" value={answer} onChange={event => setAnswer(event.target.value)} placeholder={t.questions.answerPlaceholder}/><PendingButton label={t.questions.continue} busyLabel={t.questions.continueBusy} disabled={answer.trim() === ''} action={() => submit(false)} /><PendingButton className="secondary" label={t.questions.recommend} busyLabel={t.questions.recommendBusy} action={() => submit(true)} /></>}</section></>
}
function Action({ title, detail, button, busyButton, action, progress }: { title: string; detail: string; button?: string; busyButton?: string; action?: () => Promise<void>; progress?: RunningStage | null }) { return <><div className="heading"><Sparkles/><div><h1>{title}</h1><p>{detail}</p></div></div>{/* O que está acontecendo AGORA. O servidor manda a etapa a cada 1,5 s e a
        tela jogava fora: durante os minutos mais longos do produto a pessoa via
        um texto imóvel e não tinha como saber se algo estava andando.
        `aria-live` porque quem ouve a tela precisa do mesmo aviso. */}
    {stageSentence(progress ?? null) === null ? null : <p className="creation-stage" aria-live="polite">
      <span className="creation-spinner" aria-hidden="true" />{stageSentence(progress ?? null)}
      {attemptSentence(progress ?? null) === null ? null : <small>{attemptSentence(progress ?? null)}</small>}
    </p>}
    {button === undefined || action === undefined ? null : <PendingButton label={button} busyLabel={busyButton ?? button} action={action} />}</> }
function Verification({ result, previewActive, startPreview, retry }: { result: PipelineResult; previewActive: boolean; startPreview(): Promise<void>; retry(): Promise<void> }) { const ok = result.state === 'VERIFIED_PROTOTYPE'; const cancelled = result.state === 'CANCELLED'; const interrupted = result.state === 'INTERRUPTED'; return <section className="task-card"><h1>{t.verification.title}</h1><p>{resultSentence(result.state, t.verification)}</p><p>{t.verification.attempts}: {result.attempts}</p>{ok && !previewActive ? <PendingButton label={t.preview.open} busyLabel={t.preview.openBusy} action={startPreview} /> : null}{interrupted ? <PendingButton label={t.creation.retry} busyLabel={t.creation.retryBusy} action={retry} /> : null}{result.verificationCodes === undefined || result.verificationCodes.length === 0 ? null : <section><h2>{t.verification.testCodes}</h2><p>{t.verification.testCodesHelp}</p><ul>{result.verificationCodes.map(item => <li key={`${item.email}-${item.expires_at}-${item.code}`}><strong>{item.email}</strong>: <code>{item.code}</code></li>)}</ul></section>}{result.checks === undefined ? null : <><h2>{t.verification.checks}</h2><ul>{result.checks.map(check => <li key={check.id}>{check.title ?? check.label}: {checkStatus(check.status)}{check.title === undefined || check.title === check.label ? null : <> <span className="check-id"><code>{check.label}</code></span></>}</li>)}</ul></>}<details className="result-technical"><summary>{t.verification.technicalTitle}</summary><p>{t.verification.technicalCode}: <code>{result.state}</code></p>{result.message === '' ? null : <p>{t.verification.technicalFailure}: <code>{result.message}</code></p>}</details></section> }

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
/**
 * O estado do Studio — e o que fazer com ele.
 *
 * Era um `<button>` SEM `onClick`: recebia foco pelo teclado, era anunciado
 * como botão por leitor de tela e não fazia nada. Quando dizia "Atenção", não
 * havia como descobrir o que estava errado — e os três campos que respondem
 * isso (rota, ambiente de criação, disco) já vinham no mesmo `/health`.
 *
 * Ele também começava em `ATTENTION` antes de `/health` responder: um alarme
 * falso a cada carregamento. Agora o estado desconhecido diz "Verificando…".
 */
function Status({ health }: { health: HealthState }) {
  const [open, setOpen] = useState(false)
  const unknown = health.state === 'UNKNOWN'
  const ok = health.state === 'OK'
  const label = unknown ? t.health.checking : ok ? t.health.ok : t.health.attention
  const className = unknown ? 'status checking' : ok ? 'status ok' : 'status attention'
  return <div className="status-wrap">
    <button type="button" className={className} aria-expanded={open} aria-controls="status-details"
      aria-label={`${label}: ${open ? t.health.hide : t.health.show}`}
      onClick={() => setOpen(!open)}><span />{label}</button>
    <div id="status-details" hidden={!open} className="status-details">
      <strong>{t.health.detailsTitle}</strong>
      <ul>
        <li>{health.route === null ? t.health.routeAttention : t.health.routeOk}</li>
        <li>{health.builder === 'OK' ? t.health.builderOk : t.health.builderAttention}</li>
        <li>{health.disk === 'OK' ? t.health.diskOk : t.health.diskAttention}</li>
      </ul>
    </div>
  </div>
}
function Progress({ state }: { state: ProjectUiState | null }) { const current = currentStepIndex(state); const truthKind = permanentTruthKind(state); return <section className="progress-panel" aria-label={t.progress.title}><h2>{t.progress.title}</h2><p className="mobile-progress-subtitle">{t.mobile.subtitle}</p><ol>{steps.map(([title, detail], index) => <li key={title} className={index === current ? 'current' : ''}><span className="step-number">{index + 1}</span><div><strong>{index + 1}. {title}</strong><p>{detail}</p><small>{index < current ? t.progress.done : index === current ? t.progress.current : t.progress.waiting}</small></div></li>)}</ol>{truthKind === null ? null : <p className="truth">{t.truth[truthKind]}</p>}</section> }

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const value = Number.parseInt(hex.slice(1), 16); const r = ((value >> 16) & 255) / 255; const g = ((value >> 8) & 255) / 255; const b = (value & 255) / 255
  const max = Math.max(r, g, b); const min = Math.min(r, g, b); const delta = max - min; const l = (max + min) / 2
  let h = 0
  if (delta !== 0) h = max === r ? 60 * (((g - b) / delta) % 6) : max === g ? 60 * ((b - r) / delta + 2) : 60 * ((r - g) / delta + 4)
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1))
  return { h: Math.round((h + 360) % 360), s: Math.round(s * 100), l: Math.round(l * 100) }
}

/**
 * O endereço com — ou sem — o projeto aberto.
 *
 * É função pura de propósito: o endereço é a única memória do projeto entre
 * uma recarga e outra, e uma regra dessas tem de poder ser conferida por teste
 * sem navegador.
 * @param href - o endereço atual, inteiro.
 * @param projectId - o projeto a guardar, ou `null` para tirá-lo.
 * @returns o novo endereço, preservando o que já estava nele.
 */
export function projectAddress(href: string, projectId: string | null): string {
  const url = new URL(href)
  if (projectId === null || projectId === '') url.searchParams.delete('projeto')
  else url.searchParams.set('projeto', projectId)
  return url.toString()
}

/** O projeto guardado num endereço, ou `null` quando não há. */
export function savedProjectOf(href: string): string | null {
  const value = new URL(href).searchParams.get('projeto')
  return value === null || value === '' ? null : value
}

/** Os estados em que uma execução ACABOU. */
const TERMINAL_RUN_STATES = ['PASSED', 'FAILED', 'BLOCKED_EXTERNAL', 'BUDGET_EXCEEDED', 'CANCELLED']

/**
 * O resultado da criação a partir do que o servidor conta, ou `null` enquanto
 * ela ainda está correndo.
 *
 * Isto era código de dentro do laço de acompanhamento, e por isso o resultado
 * só existia para quem tinha ficado com a tela aberta. Quem recarregava depois
 * de a criação terminar — e a própria tela MANDA recarregar quando perde o
 * acompanhamento — voltava para uma coluna vazia: sem o resultado, sem os
 * critérios, sem o relato e sem o botão de ver o protótipo, enquanto a coluna
 * ao lado dizia "Protótipo verificado".
 * @param details - o projeto como o servidor devolve.
 * @returns o resultado terminal, ou `null`.
 */
export function resultOfRun(details: ProjectDetails): PipelineResult | null {
  const current = details.current_run
  if (current === null || !TERMINAL_RUN_STATES.includes(current.state)) return null
  const state: PipelineResultState = details.project.state === 'INTERRUPTED' ? 'INTERRUPTED'
    : current.state === 'PASSED' ? 'VERIFIED_PROTOTYPE'
      : current.state === 'BLOCKED_EXTERNAL' ? 'BLOCKED_EXTERNAL'
        : current.state === 'CANCELLED' ? 'CANCELLED'
          // `BUDGET_EXCEEDED` estava na lista de estados terminais e não estava
          // aqui: caía no último ramo e virava "verificação encontrou um problema".
          : current.state === 'BUDGET_EXCEEDED' ? 'BUDGET_EXCEEDED'
            : current.stage === 'test' ? 'TESTS_FAILED' : 'BUILD_FAILED'
  return {
    state,
    attempts: current.attempt,
    message: current.failure_code ?? (state === 'VERIFIED_PROTOTYPE' ? t.truth.verified : t.verification.failure),
    checks: current.acceptance_checks,
    ...(current.verification_codes === undefined ? {} : { verificationCodes: current.verification_codes }),
  }
}

/** Guarda o projeto aberto no endereço, sem empilhar história do navegador. */
function rememberProject(projectId: string): void {
  window.history.replaceState(null, '', projectAddress(window.location.href, projectId))
}

/** Tira o projeto do endereço quando ele não pode mais ser retomado. */
function forgetSavedProject(): void {
  window.history.replaceState(null, '', projectAddress(window.location.href, null))
}

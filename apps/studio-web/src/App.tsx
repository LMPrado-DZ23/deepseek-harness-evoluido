import { generationSettled } from './creationProgress'
import { LogOut, Settings, Sparkles } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, apiResponse, csrfToken, type HealthState } from './api'
import { PendingButton } from './PendingButton'
import { STUDIO_CATEGORIES, type Category } from './categories'
import t from './i18n/pt-BR.json'
import { categoryGuess, type CategoryGuess } from './categorySuggestion'
import type { RunStepRecord } from './BuildSteps'
import { projectNameFromBrief } from './projectName'
import { impressaoDoEnvioLocal, intencaoPorImpressao, type IntencaoDeCriacao } from './creationIntent'

import { sinteseParada } from './sinteseParada'
import { HEADLINE_CAPABILITY, capabilityLines, capabilityName, creationBlocked, currentStepIndex, permanentTruthKind, privacyNotice, resultSentence, routeReasonNotice, type PipelineResultState, type PrivacyProfile, type ProjectUiState } from './presentation'
import { apiFailureMessage, apiFailureText, type ApiCallKind } from './pwa/apiFailure'
import { GENERATION_REJECTED_STATE, postGeneration, startGeneration } from './pwa/generation'
import { podeTentarDeNovo } from './tentarDeNovo'
import { NotificationOptIn } from './pwa/NotificationOptIn'
import { browserEmergencyStopPort, EmergencyStop } from './EmergencyStop'
import { Checkpoints, RunReport, isCheckpointList, isRunReport, type CheckpointListValue, type RunReportValue } from './RunReport'
import { dispatchGenerationFinished } from './pwa/notifications'
import { signOutInBrowser } from './session/signOut'
import { currentSessionMode, currentSessionPrincipal, currentSessionScope } from './session/currentSession'
import { confirmPlanIntent, preparePlanIntent, prepareCreationIntent, prepareRevisionIntent, prepareQuestionIntent, type PendingIntent, type PendingPlanIntent } from './plan/pendingIntent'
import { PlanEditor, type ConsultedView } from './plan/PlanEditor'
import { TAREFAS_MUDARAM, WorkspaceShell } from './shell/WorkspaceShell'
import { HomeScreen } from './home/HomeScreen'
import { TaskScreen, type PainelAberto } from './tarefa/TaskScreen'
import { createHubApi } from './hub/hubApi'
import type { IntegracaoDoMenu } from './tarefa/menusDoCompositor'
import { UsoDaTarefa } from './tarefa/UsoDaTarefa'
import { Preferencias } from './preferencias/Preferencias'
import { useCatalogos } from './i18n/IdiomaProvider'
import { iniciaisDaConta } from './shell/tarefasDoTrilho'
import tarefaCopy from './i18n/tarefa.pt-BR.json'
import type { CategoryBasis, DesignPreset } from './home/opcoes'
import type { PlanEditRequest } from './plan/planEdit'
import { PainelDePrevia } from './previa/PainelDePrevia'
import { DIVISAO_PADRAO, proximoLayout, type EstadoDoPainel } from './previa/layout'
import { Arquivos } from './previa/Arquivos'

/** O cliente do Hub, criado UMA vez: um por render refaria a leitura a cada estado novo. */
const hubApi = createHubApi()

type Question = { id: 'audience' | 'goal' | 'content' | 'sensitive-confirmation'; text: string }
type Plan = { plan_id: string; status: string; updated_at: string; revision?: number; edited_by_person?: boolean; slices: Array<{ slice_id: string; title: string; description: string; acceptance_criteria: string[] }> }
// `label` é o identificador de máquina (`page:Início`); `title` é a mesma
// conferência em português. A tela lê o título e mantém o identificador ao lado,
// pequeno, porque é ele que se cola num pedido de ajuda.
type AcceptanceCheck = { id: string; label: string; title?: string; status: 'PENDING' | 'PASSED' | 'FAILED' | 'NOT_AUTOMATED' }
type VerificationCode = { email: string; code: string; expires_at: string }
// O estado final vem do MESMO tipo que a frase usa: duas listas separadas foi
// como `BUDGET_EXCEEDED` acabou sem frase própria.
type PipelineResult = { state: PipelineResultState; attempts: number; message: string; notice?: string; checks?: AcceptanceCheck[]; verificationCodes?: VerificationCode[]; resumed?: boolean }
type RunDetails = { run_id: string; operation_id: string; state: 'PENDING' | 'RUNNING' | 'PASSED' | 'FAILED' | 'BLOCKED_EXTERNAL' | 'BUDGET_EXCEEDED' | 'CANCELLED'; stage: string; attempt: number; started_at: string; finished_at?: string | null; steps?: RunStepRecord[]; resumed_from_run_id?: string; failure_code: string | null; acceptance_checks: AcceptanceCheck[]; verification_codes?: VerificationCode[] }
/*
  O CORPO da tarefa, como `GET /projects/:id` já o devolve.

  Ele cresceu, e o que cresceu não é campo novo no servidor: são os campos que
  a rota sempre mandou e que esta tela descartava — `turns`, `runs`, `evidence`
  e os dados do próprio projeto. Declarar só três deles foi o que fez a
  conversa parecer impossível sem um diário à parte.
*/
type ProjectDetails = {
  project: { project_id: string; name: string; state: ProjectUiState; original_brief: string; created_at?: string; pending_revision?: { spec_id: string; requested_by: string } }
  turns?: Array<{ turn_id: string; question_id: string; question: string; answer: string; recommended: boolean; created_at: string }>
  plan?: Plan | null
  runs?: RunDetails[]
  current_run: null | RunDetails
  evidence?: Array<{ evidence_id: string; run_id: string; kind: string; relative_path: string; size_bytes: number }>
  next?: Question | null
  revisions?: Array<{ spec_id: string; request: string; created_at: string }>
}
type Preview = { preview_id: string; state: 'REQUESTED' | 'STARTING' | 'READY' | 'STOPPING' | 'STOPPED' | 'FAILED' | 'EXPIRED'; health: 'PENDING' | 'OK' | 'DOWN'; url: string; expires_at: string }
/**
 * O acesso do botão de emergência à rota, criado UMA vez fora do componente.
 * Recriá-lo a cada pintura faria a tela reler o estado sem parar, e a leitura
 * roda em um efeito que depende dele.
 */
const emergencyPort = browserEmergencyStopPort(csrfToken)
const steps = [
  [t.progress.idea, t.progress.ideaDetail], [t.progress.questions, t.progress.questionsDetail],
  [t.progress.plan, t.progress.planDetail], [t.progress.creation, t.progress.creationDetail],
  [t.progress.verification, t.progress.verificationDetail],
] as const

export function App() {
  const { preferencias: preferenciasTexto } = useCatalogos()
  const enviosTexto = preferenciasTexto.envios
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
  const [route, setRoute] = useState<string | null>(null)
  const [projectId, setProjectId] = useState<string | null>(null)
  const [projectState, setProjectState] = useState<ProjectUiState | null>(null)
  const [question, setQuestion] = useState<Question | null>(null)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [consulted, setConsulted] = useState<ConsultedView | undefined>(undefined)
  const [changeReason, setChangeReason] = useState('')
  const [result, setResult] = useState<PipelineResult | null>(null)
  const [health, setHealth] = useState<HealthState>({ state: 'UNKNOWN', route: null, builder: 'BLOCKED_EXTERNAL', disk: 'ATTENTION' })
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [admissionTicket, setAdmissionTicket] = useState<string | null>(null)
  const [previewCodes, setPreviewCodes] = useState<VerificationCode[]>([])
  const [signingOut, setSigningOut] = useState(false)
  const [authenticatedSession, setAuthenticatedSession] = useState(false)
  /* O nome de quem está na sessão, para o avatar do rodapé. Sem sessão, `null`. */
  const [sessionName, setSessionName] = useState<string | null>(null)
  const [runReport, setRunReport] = useState<RunReportValue | null>(null)
  const [checkpoints, setCheckpoints] = useState<CheckpointListValue | null>(null)
  const [confirmingUndo, setConfirmingUndo] = useState<string | null>(null)
  const previewFrame = useRef<HTMLIFrameElement>(null)
  // A gaveta do celular mora na `WorkspaceShell` — foco, `Escape` e trava de
  // rolagem junto com ela, em vez de repetidos em cada tela.
  const [atalhosAbertos, setAtalhosAbertos] = useState(false)
  /*
    O CORPO INTEIRO da tarefa, como o servidor o devolve.
    A tela lia três campos dele e jogava fora `turns`, `runs` e `evidence` —
    que é exatamente o histórico que faltava para existir uma conversa. Guardar
    o corpo inteiro não cria armazenamento novo: é a mesma leitura, sem descarte.
  */
  const [detalhes, setDetalhes] = useState<ProjectDetails | null>(null)
  /* O rascunho do compositor mora AQUI para sobreviver a abrir e fechar painel. */
  const [rascunho, setRascunho] = useState('')
  const [preferenciasAbertas, setPreferenciasAbertas] = useState(false)
  /*
    O que está LIGADO, para os menus do compositor (F08/F09).

    `null` é "ainda não li", e é diferente de lista vazia: o botão não mostra
    número nenhum antes da resposta, porque escrever "0" antes de perguntar é
    afirmar que não há nenhuma sem ter olhado. Uma falha de leitura mantém o
    `null` — o menu diz que está lendo, e não que não existe nada.
  */
  const [integracoes, setIntegracoes] = useState<readonly IntegracaoDoMenu[] | null>(null)
  useEffect(() => {
    let vivo = true
    void (async () => {
      try {
        const catalogo = await hubApi.integrations({})
        if (vivo) setIntegracoes(catalogo.integrations)
      } catch { /* sem leitura, o menu continua dizendo que está lendo. */ }
    })()
    return () => { vivo = false }
  }, [])
  const [painel, setPainel] = useState<PainelAberto | null>(null)
  /*
    O LAYOUT do painel mora aqui, junto com o rascunho, pelo mesmo motivo: ele
    tem de sobreviver a abrir, fechar, expandir e trocar de painel. As
    transições passam por `proximoLayout`, que tem teste próprio e que, por
    construção, não alcança execução nem prévia — fechar o painel não pode
    interromper a construção nem encerrar a prévia.
  */
  const [layout, setLayout] = useState<EstadoDoPainel>({
    modo: 'fechado', tarefaId: null, rascunho: '', posicaoDeLeitura: 0,
    divisao: DIVISAO_PADRAO, viewport: 'desktop',
  })
  useEffect(() => {
    let active = true
    void currentSessionMode().then(mode => { if (active) setAuthenticatedSession(mode === 'authenticated') })
    void currentSessionPrincipal().then(principal => { if (active) setSessionName(principal) })
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
      /*
        A restauração deixou de ser parcial.

        Ela desistia quando não havia plano nem tentativa, e o comentário
        original explicava por quê: sem a próxima pergunta, a tela ficava presa
        numa etapa sem saída. Isso valia para o wizard. Na conversa a pergunta
        aberta VEM no corpo (`next`) e vira um lance como qualquer outro — quem
        recarrega no meio das perguntas volta a vê-las, e quem não tem pergunta
        nenhuma volta a ver o próprio pedido. Não há mais etapa sem saída para
        proteger, e desistir aqui apagaria a tarefa da vista pelo motivo errado.
      */
      setProjectId(saved)
      setProjectState(details.project.state)
      setPlan(plan)
      // O corpo inteiro, e não três campos dele: recarregar a página precisa
      // devolver a CONVERSA, e a conversa é o histórico.
      setDetalhes(details)
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
  // Pronto para continuar exige tipo DECIDIDO. Enquanto o palpite não
  // entendeu e a pessoa não escolheu, seguir em frente construiria uma coisa
  // que ninguém pediu — e a pessoa só descobriria no fim.
  const ready = useMemo(() => brief.trim().length >= 10 && categoryBasis !== 'none', [brief, categoryBasis])
  async function safely(action: () => Promise<void>, call: ApiCallKind = 'mutation') {
    await safelyWithResult(action, call)
  }
  async function safelyWithResult(action: () => Promise<void | boolean>, call: ApiCallKind = 'mutation'): Promise<boolean> {
    setError('')
    try { return (await action()) !== false } catch (cause) {
      setError(apiFailureText(cause, navigator.onLine, call, t.health.attention))
      return false
    }
  }
  /*
    Respostas do questionario e pedidos de mudanca ainda conservam a chave
    apenas nesta montagem. Criacao, pergunta, revisao e edicao/etapa de plano
    usam IndexedDB; estes dois envios continuam pendentes de migracao.
  */
  const intencaoDaResposta = useRef<IntencaoDeCriacao | null>(null)
  const intencaoDaMudanca = useRef<IntencaoDeCriacao | null>(null)
  async function create() {
    if (!ready) { setError(t.idea.empty); return }
    await safely(async () => {
      const pedido = { name: projectNameFromBrief(brief), original_brief: brief.trim(), category, privacy }
      const scope = await currentSessionScope()
      if (scope === null) throw new Error(enviosTexto.identidade)
      let envio: PendingIntent
      try { envio = await prepareCreationIntent(scope, JSON.stringify(pedido)) }
      catch { throw new Error(enviosTexto.indisponivel) }
      const created = await api<{ project: { project_id: string; state: ProjectUiState }; next: Question }>('/projects', {
        method: 'POST', body: JSON.stringify({ ...pedido, request_key: envio.key }),
      })
      // A tarefa existe: a intenção terminou. A próxima é outra, e leva chave
      // nova — senão o segundo aplicativo da pessoa seria recusado por conflito
      // com o primeiro.
      setProjectId(created.project.project_id); rememberProject(created.project.project_id); setProjectState(created.project.state); setQuestion(created.next)
      /*
        ENVIAR ABRE A CONVERSA. Não há passo intermediário e não há wizard: a
        tarefa existe, e o que a pessoa escreveu já é o primeiro lance dela. A
        conversa é montada com o que a resposta da criação traz — o pedido e a
        primeira pergunta — e completada pela leitura seguinte. Esperar a
        leitura para desenhar qualquer coisa deixaria a tela vazia no instante
        em que a pessoa mais precisa ver que o pedido chegou.
      */
      setDetalhes({
        project: {
          project_id: created.project.project_id, name: pedido.name,
          state: created.project.state, original_brief: pedido.original_brief,
        },
        current_run: null, next: created.next,
      })
      await acknowledgePlanIntent(envio)
      setRascunho(''); setPainel(null)
      // A lateral precisa saber que nasceu uma tarefa: o endereço muda por
      // `replaceState` e a casca não remonta.
      window.dispatchEvent(new Event(TAREFAS_MUDARAM))
      await api(`/projects/${created.project.project_id}/design`, {
        method: 'POST', body: JSON.stringify({ preset: designPreset, ...(designPreset === 'brand' ? { primary: hexToHsl(brandColor) } : {}), font, radius, density, tone }),
      })
      if (logo !== null) await api(`/projects/${created.project.project_id}/design/logo`, { method: 'POST', body: logo, headers: { 'content-type': logo.type } })
      await refreshDetalhes(created.project.project_id)
    })
  }
  /**
   * Responde a pergunta de admissão aberta.
   *
   * O texto chega por PARÂMETRO, e não de um estado desta tela.
   *
   * Ele vinha de um `answer` próprio, alimentado pelo campo do cartão de
   * perguntas. Esse cartão saiu — a resposta agora é escrita no compositor de
   * baixo, como tudo o mais — e guardar uma segunda cópia do texto aqui seria
   * ter dois lugares onde a resposta mora, com um deles sempre atrasado.
   *
   * Sem texto e sem `recommend`, o servidor recusa: é ele quem decide o que é
   * resposta vazia, e não esta tela.
   */
  async function submitAnswer(recommend: boolean, confirmSensitive?: boolean, texto?: string) {
    if (projectId === null) return false
    /*
      A impressão local carrega o que a PESSOA mandou, e não a pergunta aberta:
      o servidor calcula a pergunta a partir do que já foi respondido, então o
      próprio primeiro envio a muda — e incluí-la faria o reenvio virar conflito
      justamente no caso para o qual a chave existe.

      A marca de recomendação entra: sem ela, escrever algo, mandar, e depois
      pedir recomendação sem limpar o campo devolveria o que a pessoa digitou
      apresentado como recomendação do modelo.
    */
    const material = [recommend ? '@recomendado' : (texto ?? ''), String(confirmSensitive ?? '')].join('|')
    const envio = intencaoPorImpressao(intencaoDaResposta.current, impressaoDoEnvioLocal('resposta', projectId, material))
    intencaoDaResposta.current = envio
    return safelyWithResult(async () => {
      const response = await api<{ next?: Question | null; spec?: unknown; blocked?: boolean; message?: string }>(`/projects/${projectId}/intake/answer`, {
        method: 'POST', body: JSON.stringify({ answer: texto ?? '', recommend, request_key: envio.chave, ...(confirmSensitive === undefined ? {} : { confirm_sensitive: confirmSensitive }) }),
      })
      if (response.blocked === true) { setError(response.message ?? t.health.attention); return false }
      setQuestion(response.next ?? null)
      if (response.next == null) setProjectState('SPEC_READY')
      if (!await refreshDetalhes()) return false
      if (intencaoDaResposta.current?.chave === envio.chave) intencaoDaResposta.current = null
    })
  }
  /**
   * Relê o corpo da tarefa e reconstrói a conversa a partir dele.
   *
   * Todas as ações passam por aqui depois de escrever. O motivo é o de sempre:
   * uma tela que atualiza pedaços do próprio estado depois de cada chamada
   * acaba com uma segunda verdade sobre a tarefa — e ela diverge no primeiro
   * conserto de uma das duas. A conversa é desenhada a partir do que o servidor
   * diz, e de nada mais.
   */
  async function refreshDetalhes(id: string | null = projectId) {
    if (id === null) return false
    try {
      const lido = await api<ProjectDetails>(`/projects/${id}`)
      setDetalhes(lido)
      setProjectState(lido.project.state)
      setPlan(lido.plan ?? null)
      setQuestion(lido.next ?? null)
      return true
    } catch (cause) {
      setError(apiFailureText(cause, navigator.onLine, 'read', t.health.attention))
      return false
    }
  }
  /**
   * Pede uma alteração depois de um resultado — na MESMA tarefa.
   *
   * É a rota `revise`, que existe justamente para este caminho. Ela devolve a
   * tarefa a `SPEC_READY`, com o pedido já dentro da especificação, e o
   * histórico inteiro continua no lugar. Nenhuma tarefa nova é criada aqui, e é
   * isso que o aceite VIS-03 confere.
   */
  async function ajustar(texto: string) {
    if (projectId === null) return false
    return safelyWithResult(async () => {
      const scope = await currentSessionScope()
      if (scope === null) throw new Error(enviosTexto.identidade)
      let envio: PendingIntent
      try { envio = await prepareRevisionIntent(scope, projectId, texto) }
      catch (cause) {
        throw new Error(cause instanceof Error && cause.message === 'REVISION_INTENT_MISMATCH'
          ? enviosTexto.revisaoOriginal : enviosTexto.indisponivel)
      }
      try {
        const response = await apiResponse<{ error?: string }>(`/projects/${projectId}/revise`, {
          method: 'POST', body: JSON.stringify({ request: texto, request_key: envio.key }),
        })
        if (response.status !== 200 || response.body === null) {
          if (response.status === 400 || response.status === 409) {
            const latest = await api<ProjectDetails>(`/projects/${projectId}`)
            // Recusa confirmada sem escrita pendente permite corrigir o pedido.
            if (latest.project.pending_revision === undefined) await acknowledgePlanIntent(envio)
          }
          throw new Error(response.body?.error ?? `HTTP ${response.status}`)
        }
      } catch (cause) {
        // A escrita pode ter parado entre especificacao e auditoria. Mostre o marcador do servidor.
        await refreshDetalhes()
        throw cause
      }
      setResult(null); setRunReport(null); setCheckpoints(null)
      if (!await refreshDetalhes()) return false
      await acknowledgePlanIntent(envio)
    })
  }

  /**
   * PERGUNTA sobre a tarefa, sem mexer em nada.
   *
   * O que ela NÃO faz é o ponto: não limpa o resultado, não apaga o relatório
   * nem os pontos seguros, porque nada disso mudou. `ajustar`, logo acima,
   * limpa os três — e limpar aqui faria a pessoa achar que perguntar tinha
   * desfeito o trabalho dela.
   * @param texto - a pergunta, como a pessoa escreveu.
   */
  async function perguntar(texto: string) {
    if (projectId === null) return false
    return safelyWithResult(async () => {
      const scope = await currentSessionScope()
      if (scope === null) throw new Error(enviosTexto.identidade)
      let envio: PendingIntent
      try { envio = await prepareQuestionIntent(scope, projectId, texto) }
      catch { throw new Error(enviosTexto.indisponivel) }
      await api(`/projects/${projectId}/ask`, {
        method: 'POST', body: JSON.stringify({ question: texto, request_key: envio.key }),
      })
      if (!await refreshDetalhes()) return false
      await acknowledgePlanIntent(envio)
    })
  }

  /**
   * CORRIGE uma resposta do questionário (PLAN-01).
   *
   * Com a especificação já pronta, o servidor a refaz a partir das respostas
   * atuais e devolve a versão nova; sem ela, devolve a próxima pergunta. Nos
   * dois casos a conversa é relida do servidor, como depois de qualquer ação.
   * @param perguntaId - a pergunta corrigida.
   * @param texto - a resposta nova.
   */
  async function corrigirResposta(perguntaId: string, texto: string) {
    if (projectId === null) return false
    const material = ['correcao', perguntaId, texto.trim()].join('|')
    const envio = intencaoPorImpressao(intencaoDaResposta.current, impressaoDoEnvioLocal('resposta', projectId, material))
    intencaoDaResposta.current = envio
    return safelyWithResult(async () => {
      await api(`/projects/${projectId}/intake/correct`, {
        method: 'POST', body: JSON.stringify({ question_id: perguntaId, answer: texto.trim(), request_key: envio.chave }),
      })
      if (!await refreshDetalhes()) return false
      if (intencaoDaResposta.current?.chave === envio.chave) intencaoDaResposta.current = null
    })
  }
  /** Pede mudança no plano proposto, com o texto do compositor. */
  async function mudarPlanoPelaConversa(texto: string) {
    if (projectId === null) return false
    const envio = intencaoPorImpressao(intencaoDaMudanca.current, impressaoDoEnvioLocal('mudanca', projectId, texto.trim()))
    intencaoDaMudanca.current = envio
    return safelyWithResult(async () => {
      await api(`/projects/${projectId}/plan/change`, { method: 'POST', body: JSON.stringify({ reason: texto.trim(), request_key: envio.chave }) })
      setPlan(null)
      if (!await refreshDetalhes()) return false
      if (intencaoDaMudanca.current?.chave === envio.chave) intencaoDaMudanca.current = null
    })
  }
  async function preparePlan() {
    if (projectId === null) return
    await safely(async () => {
      const response = await api<{ plan: Plan; consulted?: ConsultedView }>(`/projects/${projectId}/plan`, { method: 'POST', body: '{}' })
      setPlan(response.plan)
      // O que foi consultado vem JUNTO do plano e é guardado com ele: buscá-lo
      // depois leria o estado do planejador já usado por outro pedido.
      setConsulted(response.consulted)
      setProjectState('PLAN_PROPOSED')
      await refreshDetalhes()
    })
  }
  /** E-03: manda UMA alteração e adota o plano que voltou, com a revisão nova. */
  async function editPlan(edit: PlanEditRequest) {
    if (projectId === null) return
    return safelyWithResult(async () => {
      const { base_revision, ...material } = edit
      const envio = await preservePlanIntent('edit', JSON.stringify(material), base_revision)
      const response = await api<{ plan: Plan }>(`/projects/${projectId}/plan/edit`, { method: 'POST', body: JSON.stringify({ ...material, base_revision: envio.baseRevision, request_key: envio.key }) })
      setPlan(response.plan)
      await refreshDetalhes()
      await acknowledgePlanIntent(envio)
    })
  }
  /** E-03: a pessoa descreve o que falta; o planejador escreve a etapa. */
  async function addPlanSlice(request: string) {
    if (projectId === null || plan === null) return
    return safelyWithResult(async () => {
      const envio = await preservePlanIntent('slice', request.trim(), plan.revision ?? 1)
      const response = await api<{ plan: Plan }>(`/projects/${projectId}/plan/slice`, { method: 'POST', body: JSON.stringify({ reason: request.trim(), base_revision: envio.baseRevision, request_key: envio.key }) })
      setPlan(response.plan)
      await refreshDetalhes()
      await acknowledgePlanIntent(envio)
    })
  }
  async function preservePlanIntent(kind: 'edit' | 'slice', material: string, baseRevision: number): Promise<PendingPlanIntent> {
    const scope = await currentSessionScope()
    if (scope === null || projectId === null) throw new Error(enviosTexto.identidade)
    try { return await preparePlanIntent({ scope, projectId, kind, material, baseRevision }) }
    catch { throw new Error(enviosTexto.indisponivel) }
  }
  async function acknowledgePlanIntent(intent: PendingIntent): Promise<void> {
    try { await confirmPlanIntent(intent) }
    catch { setError(enviosTexto.confirmacaoPendente) }
  }
  async function approvePlan() {
    if (projectId === null) return
    await safely(async () => { await api(`/projects/${projectId}/plan/approve`, { method: 'POST', body: '{}' }); setProjectState('PLAN_APPROVED'); await refreshDetalhes() })
  }
  async function requestPlanChange() {
    if (projectId === null || changeReason.trim().length < 3) return
    const envio = intencaoPorImpressao(intencaoDaMudanca.current, impressaoDoEnvioLocal('mudanca', projectId, changeReason.trim()))
    intencaoDaMudanca.current = envio
    await safely(async () => {
      await api(`/projects/${projectId}/plan/change`, { method: 'POST', body: JSON.stringify({ reason: changeReason.trim(), request_key: envio.chave }) })
      intencaoDaMudanca.current = null
      setPlan(null); setChangeReason('')
      await refreshDetalhes()
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
      setDetalhes(details)
      /*
        A etapa e os passos NÃO são mais copiados para estado próprio: eles
        vivem em `current_run`, dentro do corpo que acabou de ser guardado, e a
        conversa os lê de lá. Duas cópias do mesmo fato é como a tela e o
        registro passam a discordar.
      */
      if (generationSettled(details.project.state, current.state)) {
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
      await refreshDetalhes()
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
      // A prévia ABRE o painel contextual, que é o que a decisão de produto
      // pede: "abrir arquivos, preview, testes ou computador cria um
      // painel/modal contextual". Ligar a prévia sem mostrá-la deixaria a
      // pessoa esperando por uma tela que já estava pronta e escondida.
      setPainel({ tipo: 'preview' })
      setLayout(atual => proximoLayout({ ...atual, tarefaId: projectId }, { tipo: 'abrir' }))
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
  function chooseCategory(selected: Category) {
    // O valor vazio do seletor de "não entendi" NÃO é uma escolha: ele é a
    // ausência de uma. Tratá-lo como escolha faria a tela desbloquear o
    // "continuar" no instante em que a pessoa abrisse e fechasse a lista.
    if ((selected as string) === '') return
    setCategory(selected); setCategoryChosenByPerson(true); setCategoryBasis('person')
  }
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
  /*
    A casca é a mesma em TODA tela do produto (`WorkspaceShell`): trilho à
    esquerda, cabeçalho com o contexto, área de trabalho à direita. Antes esta
    tela montava a própria casca e as outras montavam a delas, e as duas
    divergiram — a decisão do Prado chama isso de "não criar uma terceira
    linguagem visual ao entrar numa tarefa".

    A home e a TAREFA são dois conteúdos dentro dessa mesma casca. A jornada de
    cinco etapas (`Progress`) deixou de ser a home obrigatória: ela aparece
    como painel de contexto quando existe uma tarefa, que é onde ela informa
    alguma coisa.
  */
  const emTarefa = projectState !== null && detalhes !== null

  /*
    O BLOCO DA PRÉVIA continua o mesmo — ele só mudou de lugar. Antes ficava
    empilhado no fim da coluna, junto com o relatório e os pontos seguros;
    agora abre no painel contextual, ao lado da conversa, e fechar devolve a
    conversa com a rolagem e o rascunho onde estavam.
  */
  const blocoDaPrevia = <PainelDePrevia
    leitura={{
      previa: preview === null ? null : { state: preview.state, health: preview.health },
      execucao: detalhes?.current_run == null ? null : { state: detalhes.current_run.state, stage: detalhes.current_run.stage },
    }}
    base={preview?.url ?? null}
    entrada={preview === null ? null : `${preview.url}/__dz23/admission`}
    refDoQuadro={previewFrame}
    codigos={previewCodes}
    arquivosDaVersao={runReport?.files ?? []}
    aoSelecionar={contexto => {
      /*
        A SELEÇÃO não altera nada: ela põe o contexto no compositor, e a pessoa
        completa o pedido com as próprias palavras. A alteração continua saindo
        pela conversa, com a mesma autorização e a mesma idempotência — e é por
        isso que ela cabe numa linha aqui.
      */
      setRascunho(atual => `${atual === '' ? '' : `${atual}\n`}${contexto}`)
    }}
    leituraDasAbas={{
      temPrevia: preview?.state === 'READY',
      arquivos: runReport?.files.length ?? 0,
      etapas: runReport?.stages.length ?? 0,
      checkpoints: checkpoints?.checkpoints.length ?? 0,
      // `relatoLido` é o que separa "ainda não perguntei" de "não tem nada": sem
      // ele, a aba de arquivos afirmaria zero antes de a resposta chegar.
      relatoLido: runReport !== null,
    }}
    arquivos={projectId === null || runReport === null ? null : <Arquivos projectId={projectId} arquivos={runReport.files} />}
    testes={runReport === null ? null : <RunReport report={runReport} />}
    historico={checkpoints === null ? null : <Checkpoints list={checkpoints} projectState={projectState} confirmingRunId={confirmingUndo}
      askConfirm={setConfirmingUndo} cancelConfirm={() => setConfirmingUndo(null)}
      undo={runId => void undoToCheckpoint(runId)} />}
    modo={layout.modo}
    viewport={layout.viewport}
    aoExpandir={() => { setLayout(atual => proximoLayout(atual, { tipo: 'expandir' })) }}
    aoRestaurar={() => { setLayout(atual => proximoLayout(atual, { tipo: 'restaurar' })) }}
    aoTrocarViewport={viewport => { setLayout(atual => proximoLayout(atual, { tipo: 'viewport', viewport })) }}
    aoEncerrar={() => { void stopPreview() }} />

  /*
    O DETALHAMENTO ANTIGO, inteiro, no painel.

    Nada foi removido: o resultado com os critérios, o relato da tentativa, os
    pontos seguros e o trilho de cinco etapas continuam existindo, com os
    mesmos componentes e as mesmas frases. O que mudou é que eles deixaram de
    ser o layout padrão — que é exatamente a correção pedida: "o detalhamento
    antigo pode existir numa visualização diagnóstica secundária, nunca como a
    estrutura dominante padrão".
  */
  const blocoDiagnostico = <>
    {result !== null ? <Verification result={result} /> : null}
    {runReport === null ? null : <RunReport report={runReport} />}
    {checkpoints === null ? null : <Checkpoints list={checkpoints} projectState={projectState} confirmingRunId={confirmingUndo}
      askConfirm={setConfirmingUndo} cancelConfirm={() => setConfirmingUndo(null)}
      undo={runId => void undoToCheckpoint(runId)}
      {...(result === null || result.state === 'VERIFIED_PROTOTYPE' ? {} : { restart: () => void generate() })} />}
    <Progress state={projectState} />
  </>

  const conteudoDoPainel = painel === null ? null
    : painel.tipo === 'preview' ? blocoDaPrevia
      : painel.tipo === 'uso' ? <UsoDaTarefa tentativas={detalhes?.runs ?? []} />
        : blocoDiagnostico

  /*
    As AÇÕES DE ESTADO — aprovar plano, criar, cancelar, abrir a prévia.

    Elas ficam abaixo da conversa e acima do compositor, que é onde a
    referência põe as ações de uma resposta. O que elas fazem não mudou: são as
    mesmas chamadas, com as mesmas autorizações. O `PlanEditor` continua aqui
    inteiro porque editar um plano é trabalho de formulário e não cabe numa
    mensagem — mas ele aparece SÓ quando há plano proposto, e não como a
    moldura permanente da tela.
  */
  const acoesDoEstado = <>
    {projectState === 'DRAFT' && question !== null ? <AcoesDaPergunta question={question} submit={submitAnswer} /> : null}
    {sinteseParada(projectState, question, detalhes?.turns) ? <Action title={t.questions.sinteseParadaTitulo} detail={t.questions.sinteseParadaDetalhe} button={t.questions.sinteseParadaBotao} busyButton={t.questions.sinteseParadaBotaoOcupado} action={() => submitAnswer(false, undefined, '')} /> : null}
    {projectState === 'SPEC_READY' ? <Action title={t.plan.title} detail={t.progress.planDetail} button={t.plan.prepare} busyButton={t.plan.prepareBusy} action={preparePlan} /> : null}
    {/*
      Qual das duas ações aparece é decidido pelo STATUS DO PLANO, e não por um
      `null` que esta tela guardava sozinha.

      Guardar `null` funcionava enquanto a tela era a única a saber o que tinha
      acontecido. Agora ela relê o corpo da tarefa depois de cada gravação — e o
      servidor devolve o plano com `CHANGE_REQUESTED`, não a ausência dele. O
      `null` era apagado na releitura seguinte, e a tarefa ficava oferecendo
      editar um plano que já tinha sido devolvido para revisão.
    */}
    {projectState === 'PLAN_PROPOSED' && plan !== null && plan.status !== 'CHANGE_REQUESTED' ? <PlanEditor plan={plan} submit={editPlan} approve={approvePlan} reason={changeReason} setReason={setChangeReason} requestChange={requestPlanChange} addSlice={addPlanSlice} {...(consulted === undefined ? {} : { consulted })} /> : null}
    {projectState === 'PLAN_PROPOSED' && (plan === null || plan.status === 'CHANGE_REQUESTED') ? <Action title={t.plan.title} detail={t.progress.planDetail} button={t.plan.revision} busyButton={t.plan.revisionBusy} action={preparePlan} /> : null}
    {projectState === 'PLAN_APPROVED' ? <Action title={t.creation.title} detail={t.truth.creation} button={t.creation.start} busyButton={t.creation.startBusy} action={generate} /> : null}
    {/* A linha do tempo do construtor NÃO é repetida aqui: ela é um lance da
        conversa, com a etapa e a tentativa. Desenhá-la nos dois lugares punha a
        mesma informação duas vezes na tela e fazia o seletor `.build-steps`
        casar com dois elementos — foi assim que o e2e apanhou a duplicata. */}
    {projectState === 'GENERATING' || projectState === 'BUILD_OK' || projectState === 'TESTS_OK' ? <Action title={t.creation.title} detail={t.creation.working} button={t.creation.cancel} busyButton={t.creation.cancelBusy} action={cancelGeneration} /> : null}
    {/* Os botões soltos ficam numa LINHA, com a largura do texto de cada um.
        Esticados, um "Ver o detalhamento técnico" virava uma barra do tamanho
        da conversa e competia com a própria conversa pela atenção. */}
    <div className="dz-acao-linha">
      {result?.state === 'VERIFIED_PROTOTYPE' && preview?.state !== 'READY' ? <PendingButton className="dz-acao-botao" label={t.preview.open} busyLabel={t.preview.openBusy} action={startPreview} /> : null}
      {/* Tentar de novo é AÇÃO, e por isso está aqui e não no relato: ele
          também oferecia o botão, e a mesma ação em dois lugares faz a pessoa
          procurar qual dos dois é o de verdade. */}
      {/* SABOTAGEM SOBREVIVE, e está declarado: trocar `podeTentarDeNovo` pela
          condição antiga não derruba teste nenhum, porque o servidor de e2e não
          produz uma criação que falha na montagem. A DECISÃO está coberta em
          `tentarDeNovo.spec.ts` e casada com o servidor em
          `plugins/prompt-to-app/tests/tentar-de-novo.spec.ts`; esta linha só a usa. */}
      {podeTentarDeNovo(result?.state) ? <PendingButton className="dz-acao-botao-secundario" label={t.creation.retry} busyLabel={t.creation.retryBusy} action={generate} /> : null}
      {preview === null ? null : <button type="button" className="dz-acao-botao-secundario" onClick={() => { setPainel({ tipo: 'preview' }); setLayout(atual => proximoLayout(atual, { tipo: 'abrir' })) }}>{t.preview.title}</button>}
      <button type="button" className="dz-acao-botao-secundario" onClick={() => setPainel({ tipo: 'uso' })}>{tarefaCopy.verUso}</button>
      <button type="button" className="dz-acao-botao-secundario" onClick={() => setPainel({ tipo: 'diagnostico' })}>{tarefaCopy.verDiagnostico}</button>
    </div>
    {error === '' ? null : <p className="error" role="alert">{error}</p>}
    {/* O botão de emergência fica VISÍVEL o tempo todo, e não escondido em
        configurações: quem precisa dele está com pressa. Na tarefa ele é uma
        linha só enquanto nada está parado: a conversa precisa do espaço. */}
    <EmergencyStop port={emergencyPort} compacto />
  </>

  /*
    A casca é a mesma em TODA tela do produto (`WorkspaceShell`): trilho à
    esquerda, cabeçalho com o contexto, área de trabalho à direita.

    Home e tarefa são os dois conteúdos dessa casca, e desta vez são de fato
    uma jornada só: enviar na home cria ou recupera a tarefa e ABRE a conversa,
    e continuar a tarefa acontece dentro dela, no compositor de baixo. O trilho
    de cinco etapas deixou de ser a estrutura; ele virou lógica interna, lida
    pela conversa e visível por inteiro no painel de diagnóstico.
  */
  /*
    A CONTA foi para o RODAPÉ do trilho, que é onde a referência a põe — e não
    um botão "Sair" competindo com o título no alto da tela. O que sobe para o
    topo é o contexto da tarefa e o estado do Studio, como na referência.
  */
  return <WorkspaceShell {...(emTarefa ? { titulo: detalhes.project.name } : {})}
    conta={authenticatedSession ? sessionName : null}
    acoesDaConta={<>
      <NotificationOptIn compacto />
      <button className="dz-rail-icone" type="button" aria-label={preferenciasTexto.abrir} onClick={() => setPreferenciasAbertas(true)}><Settings aria-hidden="true" /></button>
      {authenticatedSession ? <button className="dz-rail-icone" type="button" disabled={signingOut} aria-busy={signingOut} aria-label={t.account.signOut} onClick={() => void signOut()}><LogOut aria-hidden="true" /></button> : null}
    </>}
    acoes={<Status health={health} />}>
    {preferenciasAbertas
      ? <Preferencias
        contexto={{ autenticado: authenticatedSession, notificacoesSuportadas: typeof window !== 'undefined' && 'Notification' in window }}
        conta={sessionName}
        notificacao={<NotificationOptIn />}
        aoFechar={() => setPreferenciasAbertas(false)} />
      : null}
    {emTarefa
      ? <TaskScreen detalhes={detalhes} rascunho={rascunho} setRascunho={setRascunho}
        responder={async texto => submitAnswer(false, undefined, texto)}
        mudarPlano={mudarPlanoPelaConversa}
        ajustar={ajustar}
        perguntar={perguntar}
        corrigir={corrigirResposta}
        integracoes={integracoes}
        iniciais={iniciaisDaConta(sessionName)}
        painel={painel} abrirPainel={setPainel}
        fecharPainel={() => {
          /*
            FECHAR O PAINEL é só isto: some a visão. A prévia continua servida,
            a construção continua correndo e a conversa continua onde estava —
            e a garantia é estrutural, porque `proximoLayout` não recebe
            nenhuma das duas.
          */
          setPainel(null)
          setLayout(atual => proximoLayout(atual, { tipo: 'fechar' }))
        }}
        modoDoPainel={layout.modo} divisaoDoPainel={layout.divisao}
        aoRedimensionarPainel={divisao => { setLayout(atual => proximoLayout(atual, { tipo: 'redimensionar', divisao })) }}
        conteudoDoPainel={conteudoDoPainel} acoesDoEstado={acoesDoEstado} />
      : <main className="dz-canvas-home">
        <section className="dz-home-conteudo">
          <HomeScreen integracoes={integracoes} brief={brief} setBrief={updateBrief} privacy={privacy} setPrivacy={setPrivacy} route={health.route_name ?? route ?? health.route} localRoute={health.local_route} routeReason={health.route_reason_code ?? null} ready={ready} chooseSuggestion={chooseSuggestion} category={category} categoryBasis={categoryBasis} chooseCategory={chooseCategory} create={create}
            designPreset={designPreset} setDesignPreset={setDesignPreset} brandColor={brandColor} setBrandColor={setBrandColor}
            font={font} setFont={setFont} radius={radius} setRadius={setRadius} density={density} setDensity={setDensity}
            tone={tone} setTone={setTone} logo={logo} setLogo={setLogo} showDesignAdvanced={showDesignAdvanced} setShowDesignAdvanced={setShowDesignAdvanced}
            atalhosAbertos={atalhosAbertos} setAtalhosAbertos={setAtalhosAbertos} />
          {error === '' ? null : <p className="error" role="alert">{error}</p>}
          <EmergencyStop port={emergencyPort} />
        </section>
      </main>}
  </WorkspaceShell>
}

/**
 * As ações que sobram numa pergunta de admissão — e só elas.
 *
 * A pergunta em si NÃO é desenhada aqui: ela já é um lance da conversa, e a
 * resposta vai pelo compositor de baixo, como qualquer outra coisa que a
 * pessoa escreve. Este cartão era a tela inteira de perguntas — herói com
 * estrela, título grande, caixa azul-marinho, campo próprio — e era
 * literalmente um dos itens que o proprietário recusou: "tarefa em um
 * formulário e conversa em outra experiência sem continuidade".
 *
 * O que não cabia no compositor ficou: pedir uma recomendação, e confirmar ou
 * recusar dado sensível. As duas são decisões com botão, não texto digitado.
 *
 * Nenhuma classe da folha antiga é usada aqui. `task-card`, `heading` e
 * `button-row` trazem junto a moldura azul-marinho e o título gigante da tela
 * que saiu — reusá-las repintaria o wizard em vez de trocá-lo.
 */
function AcoesDaPergunta({ question, submit }: { question: Question; submit(recommend: boolean, confirm?: boolean): Promise<unknown> }) {
  if (question.id === 'sensitive-confirmation') {
    return <div className="dz-acao">
      <PendingButton className="dz-acao-botao" label={t.questions.confirm} busyLabel={t.questions.confirmBusy} action={() => submit(false, true)} />
      <PendingButton className="dz-acao-botao-secundario" label={t.questions.reject} busyLabel={t.questions.rejectBusy} action={() => submit(false, false)} />
    </div>
  }
  return <div className="dz-acao">
    <PendingButton className="dz-acao-botao-secundario" label={t.questions.recommend} busyLabel={t.questions.recommendBusy} action={() => submit(true)} />
  </div>
}

/**
 * Uma ação que faz a tarefa avançar: montar plano, criar, cancelar.
 *
 * Ela perdeu o herói com estrela e o título de tela, porque não é mais uma
 * tela: é um botão abaixo da conversa, no mesmo alinhamento dela, como a
 * referência mostra. A frase explicativa ficou, curta, porque é ela que diz o
 * que o botão vai fazer — um botão sozinho num produto para quem não programa
 * é uma adivinhação.
 *
 * A linha do tempo da construção e a frase da etapa saíram daqui e foram para
 * a conversa, onde a tentativa em curso é contada. Desenhá-las nos dois
 * lugares punha a mesma informação duas vezes na tela.
 */
function Action({ title, detail, button, busyButton, action }: { title: string; detail: string; button?: string; busyButton?: string; action?: () => Promise<unknown> }) {
  return <div className="dz-acao">
    <div className="dz-acao-texto"><strong>{title}</strong><span>{detail}</span></div>
    {button === undefined || action === undefined ? null : <PendingButton className="dz-acao-botao" label={button} busyLabel={busyButton ?? button} action={action} />}
  </div>
}

/**
 * O relato do desfecho, no painel de detalhamento.
 *
 * Ele perdeu os BOTÕES — abrir a prévia e tentar de novo —, e não porque
 * deixaram de existir: eles vivem na linha de ações da conversa, que é onde a
 * pessoa age. Tê-los nos dois lugares punha o mesmo botão duas vezes na tela,
 * e o e2e apanhou a duplicata como um seletor que casava com dois elementos.
 * O que fica aqui é o que se LÊ: a frase do desfecho, as tentativas, os
 * códigos de teste, os critérios conferidos e o código técnico.
 */
function Verification({ result }: { result: PipelineResult }) { return <section className="task-card"><h2>{t.verification.title}</h2><p>{resultSentence(result.state, t.verification)}</p>{result.notice === undefined || result.notice === '' ? null : <p className="truth">{result.notice}</p>}<p>{t.verification.attempts}: {result.attempts}</p>{result.resumed === true ? <p className="truth">{t.verification.resumed}</p> : null}{result.verificationCodes === undefined || result.verificationCodes.length === 0 ? null : <section><h2>{t.verification.testCodes}</h2><p>{t.verification.testCodesHelp}</p><ul>{result.verificationCodes.map(item => <li key={`${item.email}-${item.expires_at}-${item.code}`}><strong>{item.email}</strong>: <code>{item.code}</code></li>)}</ul></section>}{result.checks === undefined ? null : <><h2>{t.verification.checks}</h2><ul>{result.checks.map(check => <li key={check.id}>{check.title ?? check.label}: {checkStatus(check.status)}{check.title === undefined || check.title === check.label ? null : <> <span className="check-id"><code>{check.label}</code></span></>}</li>)}</ul></>}<details className="result-technical"><summary>{t.verification.technicalTitle}</summary><p>{t.verification.technicalCode}: <code>{result.state}</code></p>{result.message === '' ? null : <p>{t.verification.technicalFailure}: <code>{result.message}</code></p>}</details></section> }

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
      <Capabilities health={health} />
    </div>
  </div>
}
/**
 * O que esta instalacao consegue fazer (T-22).
 *
 * AUSENTE, e nao vazio, quando o servidor nao manda o bloco: um servidor mais
 * velho nao sabe responder, e uma lista vazia afirmaria que nada funciona.
 */
function Capabilities({ health }: { health: HealthState }) {
  const lines = capabilityLines(health.capabilities)
  const headline = lines.find(line => line.id === HEADLINE_CAPABILITY)
  if (headline === undefined) return null
  // `PROBE_STALE` tem frase propria: "funcionou da ultima vez, mas faz mais de
  // uma hora" e diferente de "ninguem conferiu ainda", e as duas sao diferentes
  // de "nao da".
  const sentence = headline.tone === 'sim' ? t.health.capabilityYes
    : headline.reason === 'PROBE_STALE' ? t.health.capabilityStale
    : headline.tone === 'nao-sei' ? t.health.capabilityUnknown
    : t.health.capabilityNo
  // O nome que a LISTA ACIMA ja usa, e nunca o identificador interno: "O que
  // esta segurando: construtor." aparecia a oito pixels de "Ambiente isolado de
  // criacao", duas palavras para a mesma coisa na mesma tela.
  const seguraNome = headline.blockedBy === undefined ? undefined
    : capabilityName(headline.blockedBy, t.health.capabilityNames)
  return <div className="status-capabilities">
    <strong>{t.health.capabilitiesTitle}</strong>
    <p className={`capability capability-${headline.tone}`}>{sentence}</p>
    {seguraNome === undefined ? null
      : <p className="capability-detail">{t.health.capabilityBlockedBy.replace('{blockedBy}', seguraNome)}</p>}
    {headline.blockedBy === undefined && headline.reason === 'NEVER_PROBED'
      ? <p className="capability-detail">{t.health.capabilityNeverProbed}</p> : null}
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
/*
  O que `resultOfRun` REALMENTE lê.

  Ela recebia o corpo inteiro da tarefa, e o corpo cresceu quando a conversa
  passou a precisar de `turns`, `runs` e `evidence`. Pedir o corpo inteiro para
  ler seis campos obrigaria todo chamador — e todo teste — a montar um projeto
  completo só para perguntar como terminou a tentativa. O tipo abaixo diz o que
  a função usa, e nada além disso.
*/
type DesfechoLido = {
  project: { state: ProjectUiState }
  current_run: null | (Pick<RunDetails, 'state' | 'stage' | 'attempt' | 'failure_code' | 'acceptance_checks'>
    & { verification_codes?: VerificationCode[]; resumed_from_run_id?: string })
}

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
export function resultOfRun(details: DesfechoLido): PipelineResult | null {
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
    ...(current.resumed_from_run_id === undefined ? {} : { resumed: true }),
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

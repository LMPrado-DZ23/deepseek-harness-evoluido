import type { JobId, JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createIdentityHttpHandler, CSRF_COOKIE, IdentityError, SESSION_COOKIE, type SessionRecord, type StudioIdentityService } from '../../../plugins/identity/src/index.js'
import { createStudioWebHandler } from '../../../plugins/studio-web/src/index.js'
import { createMissionHttpHandler } from '../../../plugins/mission/src/http.js'
import { StudioMissionService, type MissionRepository } from '../../../plugins/mission/src/service.js'
import type { MissionRecord } from '../../../plugins/mission/src/model.js'
import type { StudioTenancyService } from '../../../plugins/tenancy/src/index.js'
import { createPromptToAppHttpHandler } from '../../../plugins/prompt-to-app/src/http.js'
import { registerPromptToAppHttpExtension } from '../../../plugins/prompt-to-app/src/http.js'
import { IntakeEngine } from '../../../plugins/prompt-to-app/src/intake.js'
import { PromptToAppJobService, type PromptToAppJobRegistry } from '../../../plugins/prompt-to-app/src/jobs.js'
import type { StudioApproval, StudioAppSpecRecord, StudioDesignSpecRecord, StudioEvidence, StudioIntakeTurn, StudioPlan, StudioProject, StudioRun } from '../../../plugins/prompt-to-app/src/model.js'
import { ModelCodeGenerator, PromptToAppPipeline } from '../../../plugins/prompt-to-app/src/pipeline.js'
import type { BuilderLifecycleResolverPort } from '../../../plugins/prompt-to-app/src/builder-lifecycle.js'
import { PlannerEngine } from '../../../plugins/prompt-to-app/src/planner.js'
import type { PromptModelPort } from '../../../plugins/prompt-to-app/src/ports.js'
import { hashTree, materializePreviewArtifact, PREVIEW_ARTIFACT_RELATIVE_PATH } from '../../../plugins/prompt-to-app/src/runner.js'
import { PromptToAppService, type PromptToAppActor, type PromptToAppRepository } from '../../../plugins/prompt-to-app/src/service.js'
import { createPreviewGatewayHttpHandler, type PreviewForwardPort } from '../../../plugins/preview/src/gateway.js'
import { createPreviewProjectHttpExtension } from '../../../plugins/preview/src/http.js'
import type { PreviewAdmission, PreviewRecord } from '../../../plugins/preview/src/model.js'
import {
  StudioPreviewService,
  type PreviewRepository,
  type PreviewRuntimePort,
  type PreviewSourcePort,
} from '../../../plugins/preview/src/service.js'

class MemoryRepository implements PromptToAppRepository {
  projectRows: StudioProject[] = []; specRows: StudioAppSpecRecord[] = []; designRows: StudioDesignSpecRecord[] = []; turnRows: StudioIntakeTurn[] = []
  planRows: StudioPlan[] = []; runRows: StudioRun[] = []; evidenceRows: StudioEvidence[] = []; approvalRows: StudioApproval[] = []
  projects = () => this.projectRows; specs = () => this.specRows; designs = () => this.designRows; turns = () => this.turnRows; plans = () => this.planRows
  runs = () => this.runRows; evidence = () => this.evidenceRows; approvals = () => this.approvalRows
  putProject = async (value: StudioProject) => { this.projectRows = upsert(this.projectRows, value, 'project_id') }
  putSpec = async (value: StudioAppSpecRecord) => { this.specRows = upsert(this.specRows, value, 'spec_id') }
  putDesign = async (value: StudioDesignSpecRecord) => { this.designRows = upsert(this.designRows, value, 'design_id') }
  putTurn = async (value: StudioIntakeTurn) => { this.turnRows = upsert(this.turnRows, value, 'turn_id') }
  putPlan = async (value: StudioPlan) => { this.planRows = upsert(this.planRows, value, 'plan_id') }
  putRun = async (value: StudioRun) => { this.runRows = upsert(this.runRows, value, 'run_id') }
  putEvidence = async (value: StudioEvidence) => { this.evidenceRows = upsert(this.evidenceRows, value, 'evidence_id') }
  putApproval = async (value: StudioApproval) => { this.approvalRows = upsert(this.approvalRows, value, 'approval_id') }
}

class MemoryPreviewRepository implements PreviewRepository {
  readonly previewsById = new Map<string, PreviewRecord>()
  readonly admissionsById = new Map<string, PreviewAdmission>()
  previews = (): readonly PreviewRecord[] => [...this.previewsById.values()]
  admissions = (): readonly PreviewAdmission[] => [...this.admissionsById.values()]
  async putPreview(value: PreviewRecord): Promise<void> { this.previewsById.set(value.preview_id, value) }
  async putAdmission(value: PreviewAdmission): Promise<void> { this.admissionsById.set(value.admission_id, value) }
}

class DeterministicPreviewRuntime implements PreviewRuntimePort {
  readonly managed = new Map<string, { previewId: string; environment: Readonly<Record<string, string>> }>()

  async start(input: Parameters<PreviewRuntimePort['start']>[0], signal: AbortSignal): Promise<{ readonly runtimeRef: string }> {
    signal.throwIfAborted()
    if (input.environment.APP_EMAIL_MODE !== 'studio-preview' || input.environment.DATA_DIR !== '/preview-storage/data') throw new Error('invalid-preview-environment')
    const runtimeRef = `runtime:${input.previewId}`
    this.managed.set(runtimeRef, { previewId: input.previewId, environment: input.environment })
    return { runtimeRef }
  }
  async stop(runtimeRef: string, signal: AbortSignal): Promise<void> { signal.throwIfAborted(); this.managed.delete(runtimeRef) }
  async health(runtimeRef: string, signal: AbortSignal): Promise<'OK' | 'DOWN'> { signal.throwIfAborted(); return this.managed.has(runtimeRef) ? 'OK' : 'DOWN' }
  async logs(runtimeRef: string, _limit: number, signal: AbortSignal): Promise<readonly unknown[]> {
    signal.throwIfAborted()
    return this.managed.has(runtimeRef)
      ? [{ at: '2026-09-03T12:00:00.000Z', level: 'info', event: 'PREVIEW_STARTED' }]
      : []
  }
  async verificationMessages(runtimeRef: string, signal: AbortSignal): Promise<readonly unknown[]> {
    signal.throwIfAborted()
    const runtime = this.managed.get(runtimeRef)
    if (runtime?.environment.APP_EMAIL_MODE !== 'studio-preview') return []
    return [{ kind: 'code', email: 'cliente@preview.local', code: '482901', expiresAt: '2026-09-03T13:00:00.000Z' }]
  }
  async listManaged(signal: AbortSignal): Promise<readonly { readonly runtimeRef: string; readonly previewId: string }[]> {
    signal.throwIfAborted()
    return [...this.managed].map(([runtimeRef, value]) => ({ runtimeRef, previewId: value.previewId }))
  }
}

function upsert<T, K extends keyof T>(rows: T[], value: T, key: K): T[] { return [...rows.filter(row => row[key] !== value[key]), value] }


/**
 * A interface servida ao navegador é a COMPILADA (`dist/`), e nada a reconstrói.
 *
 * Uma auditoria caiu nisto: mudou o CSS, rodou o e2e, viu verde — e o verde era
 * do `dist` antigo. Um teste de navegador que roda contra um artefato velho não
 * prova o que está no repositório; ele prova o que estava.
 *
 * Aqui a comparação é de data: se qualquer fonte da interface for mais nova do
 * que o `index.html` gerado, o servidor de teste RECUSA subir e diz o comando.
 * @param webRoot - a pasta `apps/studio-web`.
 */
async function assertBuiltInterfaceIsFresh(webRoot: string): Promise<void> {
  const index = resolve(webRoot, 'dist', 'index.html')
  const built = await stat(index).catch(() => undefined)
  if (built === undefined) throw new Error('A interface não foi compilada. Rode `pnpm build` na raiz antes do e2e.')
  const newer: string[] = []
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) { await walk(path); continue }
      if (!/\.(?:tsx?|css|json|html)$/u.test(entry.name)) continue
      const info = await stat(path)
      if (info.mtimeMs > built.mtimeMs + 1_000) newer.push(entry.name)
    }
  }
  await walk(resolve(webRoot, 'src'))
  if (newer.length > 0) {
    throw new Error(`A interface compilada está velha (${newer.slice(0, 5).join(', ')}${newer.length > 5 ? '…' : ''}). Rode \`pnpm build\` na raiz antes do e2e.`)
  }
}

const root = resolve(import.meta.dirname, '..', '..', '..')
const scratch = await mkdtemp(join(tmpdir(), 'dz23-studio-e2e-'))
const session = { session_id: 'e2e-session', user_id: 'owner', org_id: 'org-e2e', tenant_id: 'tenant-e2e' } as SessionRecord
const logoutSession = { ...session, session_id: 'e2e-logout-session' }
const failingLogoutSession = { ...session, session_id: 'e2e-logout-fail-session' }
const crossTabLogoutSession = { ...session, session_id: 'e2e-logout-cross-tab-session' }
const generationRaceSession = { ...session, session_id: 'e2e-logout-generation-race-session' }
const generationAttackSession = { ...session, session_id: 'e2e-logout-generation-attack-session' }
const revokedSessions = new Set<string>()
const identity = {
  requestMagicCode: async () => undefined,
  verifyMagicCode: async () => ({ token: 'session-token', csrfToken: 'csrf-e2e', session }),
  personalPrincipal: () => ({ userId: 'local', orgId: 'local', tenantId: 'local', sessionId: 'local' }),
  authenticate: async (token: string) => {
    const authenticated = token === 'e2e' ? session
      : token === 'e2e-logout' ? logoutSession
        : token === 'e2e-logout-fail' ? failingLogoutSession
          : token === 'e2e-logout-cross-tab' ? crossTabLogoutSession
            : token === 'e2e-logout-generation-race' ? generationRaceSession
              : token === 'e2e-logout-generation-attack' ? generationAttackSession
          : undefined
    if (authenticated === undefined || revokedSessions.has(authenticated.session_id)) throw new IdentityError('invalid', 'invalid-session')
    return authenticated
  },
  validateCsrf: (_session: SessionRecord, cookie: string | undefined, header: string | undefined) => {
    if (cookie !== 'csrf-e2e' || header !== 'csrf-e2e') throw new Error('invalid-csrf')
  },
  validateCsrfToken: (_session: SessionRecord, header: string | undefined) => {
    if (header !== 'csrf-e2e') throw new IdentityError('csrf', 'invalid-csrf')
  },
  revokeSession: async (actor: SessionRecord, sessionId: string) => {
    if (actor.session_id !== sessionId || actor.user_id !== session.user_id) throw new IdentityError('not-found', 'invalid-session')
    if (sessionId === failingLogoutSession.session_id) throw new IdentityError('invalid', 'forced-logout-failure')
    revokedSessions.add(sessionId)
  },
    // O servidor de teste não usa vitest: a conferência de Host e Origin é
    // exercida pelo e2e contra o servidor real, não por este dublê.
    assertRequestTrust: () => {},
  } as unknown as StudioIdentityService
const tenancy = { authorizationFor: (userId: string, orgId: string, tenantId: string) => ({ userId, orgId, tenantId, role: 'owner' as const }) } as unknown as StudioTenancyService
const repository = new MemoryRepository()
let id = 0
const service = new PromptToAppService({ repository, createId: () => `e2e-${++id}` })
const model: PromptModelPort = {
  async complete(_scope, purpose) {
    if (purpose === 'intake') return { route: 'ollama-local', model: 'fixture', value: {
      schema_version: 1, problem: 'Apresentar serviços para clientes locais.', audience: 'Clientes locais', journeys: ['Conhecer os serviços'],
      pages: [{ name: 'Início', sections: ['Serviços', 'Contato'] }], entities: [],
      sensitive_data: { detected: [], confirmed_by_user: false }, accessibility: { wcag_level: 'AA', keyboard_required: true, reduced_motion: true },
      language: 'pt-BR', acceptance_criteria: ['Mostrar o texto “Fale conosco”.', 'A navegação deve ser simples.'],
    } }
    if (purpose === 'plan') return { route: 'ollama-local', model: 'fixture', value: { slices: [
      { slice_id: 'layout', title: 'Estrutura da página', description: 'Criar a apresentação principal.', acceptance_criteria: ['A página mostra o serviço.'], planned_files: ['content/app.json'] },
      { slice_id: 'contact', title: 'Contato e conferência', description: 'Criar o contato e verificar o conteúdo.', acceptance_criteria: ['O contato fica visível.'], planned_files: ['src/GeneratedApp.tsx'] },
    ] } }
    return { route: 'ollama-local', model: 'fixture', value: { files: [
      { path: 'content/app.json', content: JSON.stringify({ title: 'Início', description: 'Serviços e Contato' }) },
      { path: 'src/GeneratedApp.tsx', content: "export default function GeneratedApp(){return <main><h1>Início</h1><section><h2>Serviços</h2></section><section><h2>Contato</h2><p>Fale conosco</p></section></main>}" },
    ] } }
  },
}
/**
 * Construtor determinístico do teste de navegador.
 *
 * Ele NÃO substitui o construtor real por mock: o Docker é a costura, e esta é
 * uma implementação dela em processo, para que o teste possa provar o que ele
 * existe para provar - a INTERFACE das cinco etapas. Sem isto, o construtor da
 * casa de teste respondia BLOCKED_EXTERNAL para sempre e a jornada principal
 * nunca chegava ao fim; ela estava vermelha desde 575ccc0 e ninguém via, porque
 * o Playwright não roda na CI.
 */
const prepared = new Map<string, string>()
const builder: BuilderLifecycleResolverPort<PromptToAppActor> = {
  forActor: async () => ({
    preflight: async () => ({ state: 'OK' }),
    prepare: async (sourceDirectory: string, buildId: string) => {
      const buildRef = `fixture-build-${buildId}`
      prepared.set(buildRef, sourceDirectory)
      return { buildRef }
    },
    execute: async (buildRef: string, step: 'install' | 'build' | 'test' | 'e2e') => {
      const directory = prepared.get(buildRef)
      if (directory === undefined) throw new Error('UNKNOWN_BUILD_REF')
      if (step === 'build') {
        await mkdir(resolve(directory, '.next', 'standalone'), { recursive: true })
        await mkdir(resolve(directory, '.next', 'static'), { recursive: true })
        await writeFile(resolve(directory, '.next', 'standalone', 'server.js'), "import http from 'node:http';http.createServer((_,res)=>res.end('fixture')).listen(3000)")
        await writeFile(resolve(directory, '.next', 'static', 'fixture.js'), 'export {}')
      }
      if (step === 'e2e') {
        // Só os critérios que o gerador marcou como PENDING viram PASSED: os que
        // ele declarou como não automatizáveis continuam assim, e a tela mostra
        // "Não verificado automaticamente" - que é a verdade.
        const path = resolve(directory, 'evidence', 'appspec-report.json')
        const report = JSON.parse(await readFile(path, 'utf8')) as { checks: Array<{ status: string }> }
        report.checks = report.checks.map(check => check.status === 'PENDING' ? { ...check, status: 'PASSED' } : check)
        await writeFile(path, JSON.stringify(report))
      }
      const state = step === 'build' ? 'BUILD_OK' : step === 'e2e' ? 'E2E_OK' : 'RUNNING'
      return {
        state: state as never, step,
        result: { exit_code: 0, stdout: step, stderr: '', timed_out: false, termination_reason: null, output_limit_exceeded: false },
      }
    },
    cancel: async (buildRef: string) => { prepared.delete(buildRef) },
    finish: async (buildRef: string) => {
      const directory = prepared.get(buildRef)
      if (directory === undefined) return { finalState: 'CANCELLED' as const, exported: null, cleanupPending: false, cleaned: true }
      prepared.delete(buildRef)
      const artifact = await materializePreviewArtifact(directory)
      return {
        finalState: 'E2E_OK' as const,
        exported: { relative_path: PREVIEW_ARTIFACT_RELATIVE_PATH, sha256: artifact.sha256, files: 2, bytes: 0 },
        cleanupPending: false, cleaned: true,
        // Os FATOS do construtor, como o resolvedor de verdade os devolve
        // (`builder-resolver.ts:181`): imagem, política e escopo sob os quais o
        // artefato foi construído. Sem eles o `pipeline` fecha em
        // `ACCEPTANCE_ATTESTATION_UNAVAILABLE` — e era isso, e não o produto,
        // que deixava metade da jornada sem teste nenhum. O que continua sendo
        // do PRODUTO é tudo o que vem depois: a atestação, os resumos e o
        // veredito são calculados de verdade a partir destes fatos.
        attestation: { image_digest: `sha256:${'b'.repeat(64)}`, policy_sha256: 'a'.repeat(64), scope_id: 'escopo-de-teste' },
      }
    },
    listManaged: async () => [],
  }),
}
const pipeline = new PromptToAppPipeline({ service, builder, templateDirectory: resolve(root, 'templates', 'nextjs-app@1'), runsRoot: resolve(scratch, 'runs'), createId: () => `pipeline-${++id}` })
const active = new Map<JobId, { cancel(reason?: string): void; done: Promise<JobOutcome> }>()
let jobSequence = 0
const registry: PromptToAppJobRegistry = {
  start(spec) { const jobId = `studio-prompt-to-app-${++jobSequence}` as JobId; active.set(jobId, spec.run()); return jobId },
  kill(jobId, _owner, reason) { const hooks = active.get(jobId); if (hooks === undefined) return 'already-finished'; hooks.cancel(reason); return 'requested' },
}
const jobs = new PromptToAppJobService({
  service, pipeline, registry, owners: { create: async () => ({ owner: {} as Agent, dispose: async () => undefined }) },
  createId: () => `operation-${++id}`,
})
const host = 'studio.dz23.localhost:4179'
const pwaProxyHost = '127.0.0.1:4179'
const allowedHosts = [host, pwaProxyHost]
const allowedOrigins = [`http://${host}`, 'http://127.0.0.1:4180']
const identityHandler = createIdentityHttpHandler({
  service: identity,
  bindHost: '127.0.0.1',
  allowedHosts,
  allowedOrigins,
  secureCookies: false,
})
const previewRepository = new MemoryPreviewRepository()
const previewRuntime = new DeterministicPreviewRuntime()
let previewSequence = 0
const previewSource: PreviewSourcePort = {
  async verifiedArtifact(actor, projectId, runId) {
    const project = service.project(actor, projectId)
    if (project.state !== 'VERIFIED_PROTOTYPE') throw new Error('project-not-verified')
    const selected = service.runs(actor, projectId)
      .filter(run => run.stage === 'verify' && run.state === 'PASSED' && run.artifact_sha256 != null && (runId === undefined || run.run_id === runId))
      .sort((left, right) => right.started_at.localeCompare(left.started_at) || right.attempt - left.attempt)[0]
    if (selected === undefined || selected.run_directory === 'not-created' || selected.artifact_sha256 == null) throw new Error('verified-artifact-not-found')
    const artifactPath = resolve(selected.run_directory, PREVIEW_ARTIFACT_RELATIVE_PATH)
    if (await hashTree(artifactPath) !== selected.artifact_sha256) throw new Error('verified-artifact-changed')
    return {
      projectId,
      runId: selected.run_id,
      artifactPath,
      artifactSha256: selected.artifact_sha256,
      ownerEmail: 'cliente@preview.local',
    }
  },
}
const previewService = new StudioPreviewService({
  repository: previewRepository,
  source: previewSource,
  runtime: previewRuntime,
  sessions: { isActive: () => true, canRead: () => true },
  createId: () => `preview-e2e-${++previewSequence}`,
  createSecret: () => `preview-e2e-secret-${++previewSequence}-fixed-value`,
  now: () => new Date('2026-09-03T12:00:00.000Z'),
  publicPort: 4179,
})
registerPromptToAppHttpExtension(createPreviewProjectHttpExtension(previewService))
const apiHandler = createPromptToAppHttpHandler({
  service, identity, tenancy, intake: new IntakeEngine(model), planner: new PlannerEngine(model), jobs,
  logos: { process: async () => ({
    sha256: 'a'.repeat(64), relative_path: `logos/${'b'.repeat(64)}/${'a'.repeat(64)}.png`, mime: 'image/png' as const,
    size_bytes: 100, width: 10, height: 10, extracted_primary: { h: 217, s: 91, l: 50 },
  }) },
  generatorFor: (actor, projectId) => new ModelCodeGenerator(model, actor, service.project(actor, projectId).privacy),
  health: async () => ({
    state: 'OK', route: 'ollama-local', builder: 'OK', disk: 'OK',
    route_reason: 'A rota local foi escolhida por preferência, e ela está saudável.',
    route_reason_code: 'LOCAL_PREFERIDA',
  }), allowedHosts, allowedOrigins,
})
/**
 * Um objetivo determinístico para a tela de objetivos.
 *
 * O que é fixture são os DADOS, e não o caminho: quem responde é o módulo de
 * rota do produto, com a mesma autenticação, o mesmo escopo e a mesma
 * conferência de papel. O objetivo nasce com um item comprovado e outro parado
 * por alguém de fora, que é o par que faz a tela mostrar as duas frases
 * diferentes — e é justamente a distinção que se perde quando alguém junta os
 * dois num "pendente".
 */
function e2eMissionSeed(): MissionRecord[] { return [{
  mission_id: 'lancar-o-site', org_id: 'org-e2e', tenant_id: 'tenant-e2e',
  objective: 'Colocar o site no ar para os clientes',
  status: 'RUNNING', max_total_tokens: 1_000, run_ids: [],
  criteria: [
    { criterion_id: 'formulario', statement: 'O formulário de contato envia mensagem de verdade', state: 'PROVEN', evidence: 'Teste de envio gravado em 08/09', blocked_reason: null },
    { criterion_id: 'dominio', statement: 'O endereço do site aponta para a hospedagem', state: 'BLOCKED_EXTERNAL', evidence: null, blocked_reason: 'a empresa que registra o endereço' },
  ],
  created_at: '2026-09-08T12:00:00.000Z', updated_at: '2026-09-08T12:00:00.000Z',
  candidate_at: null, completed_at: null, revision: 0,
}] }
let e2eMissions = e2eMissionSeed()
/**
 * O armazenamento da prova de ponta a ponta, com a MESMA condicao da producao.
 *
 * Gravar sempre, devolvendo `undefined`, faria o serviço ler uma recusa em toda
 * gravação — e foi assim que o encerramento parou de responder aqui sem que
 * nenhum teste de unidade reclamasse.
 */
const missionRepository: MissionRepository = {
  missions: async scope => e2eMissions
    .filter(row => row.org_id === scope.orgId && row.tenant_id === scope.tenantId),
  putMission: async (record, expected) => {
    const index = e2eMissions.findIndex(row => row.mission_id === record.mission_id
      && row.org_id === record.org_id && row.tenant_id === record.tenant_id)
    if (expected === 'new') {
      if (index >= 0) return false
      e2eMissions.push(record)
      return true
    }
    if (index < 0 || e2eMissions[index]!.revision !== expected) return false
    e2eMissions[index] = record
    return true
  },
}
const missionHandler = createMissionHttpHandler({
  service: new StudioMissionService({ repository: missionRepository }),
  identity, tenancy, allowedHosts, allowedOrigins, runs: () => [],
})

/**
 * Uma equipe determinística para a tela de progresso.
 *
 * O que é fixture aqui são os DADOS, e não o caminho: quem responde é o mesmo
 * módulo de rota do produto, com a mesma autenticação e o mesmo escopo. Sem
 * isto a tela de progresso só seria conferida em teste de componente, e a
 * acessibilidade dela em tamanho de celular nunca rodaria num navegador de
 * verdade - que foi exatamente como um contraste de 1,24:1 passou despercebido
 * no aviso da PWA.
 */
const E2E_TEAM_ID = '11111111-2222-4333-8444-555555555555'
const e2eTeam = {
  team_id: E2E_TEAM_ID, org_id: 'org-e2e', tenant_id: 'tenant-e2e', workspace_id: 'meu-projeto',
  name: 'Arrumar o formulário de cadastro', status: 'NEEDS_ATTENTION', required_tier: 'T2',
  sensitive_operation: null, approved_by: 'voce@exemplo.com', approved_at: '2026-09-08T12:00:00.000Z',
  diagnostic: null, created_at: '2026-09-08T12:00:00.000Z', updated_at: '2026-09-08T12:20:00.000Z',
}
const e2eTasks = [
  {
    task_id: 'implementar', team_id: E2E_TEAM_ID, title: 'Escrever o formulário', role: 'implementer',
    status: 'APPLIED', run_id: 'run-e2e-1', depends_on: [], intended_paths: ['src/cadastro.tsx'],
    diagnostic: null, created_at: '2026-09-08T12:00:00.000Z', updated_at: '2026-09-08T12:10:00.000Z',
  },
  {
    task_id: 'revisar', team_id: E2E_TEAM_ID, title: 'Revisar o formulário', role: 'reviewer',
    status: 'FAILED', run_id: 'run-e2e-2', depends_on: ['implementar'], intended_paths: ['src/cadastro.tsx'],
    diagnostic: 'A revisão parou porque o projeto mudou embaixo dela.',
    created_at: '2026-09-08T12:00:00.000Z', updated_at: '2026-09-08T12:20:00.000Z',
  },
  {
    task_id: 'testar', team_id: E2E_TEAM_ID, title: 'Testar o formulário', role: 'tester',
    status: 'QUEUED', run_id: null, depends_on: ['revisar'], intended_paths: ['tests/cadastro.spec.ts'],
    diagnostic: null, created_at: '2026-09-08T12:00:00.000Z', updated_at: '2026-09-08T12:00:00.000Z',
  },
]
const e2eRuns = [
  {
    run_id: 'run-e2e-1', org_id: 'org-e2e', tenant_id: 'tenant-e2e', workspace_id: 'meu-projeto',
    status: 'APPLIED', provider: 'spawn-in-process', diagnostic: null,
    created_at: '2026-09-08T12:00:00.000Z', updated_at: '2026-09-08T12:10:00.000Z',
    changed_files: ['src/cadastro.tsx'], diff_bytes: 2048, diff_sha256: 'a'.repeat(64),
    base_commit: 'abcdef1', main_changed_during_run: false, tokens_used: 4200,
  },
  {
    run_id: 'run-e2e-2', org_id: 'org-e2e', tenant_id: 'tenant-e2e', workspace_id: 'meu-projeto',
    status: 'FAILED', provider: 'codex', diagnostic: null,
    created_at: '2026-09-08T12:00:00.000Z', updated_at: '2026-09-08T12:20:00.000Z',
    changed_files: [], diff_bytes: 0, diff_sha256: 'b'.repeat(64),
    base_commit: 'abcdef1', main_changed_during_run: true, tokens_used: null,
  },
]
let e2eTeamCancelled = false
const webHandler = createStudioWebHandler({
  distDirectory: resolve(root, 'apps', 'studio-web', 'dist'), identity, allowedHosts, allowedOrigins,
  previewFrameSources: ['http://*.dz23.localhost:4179'],
  agentRuns: () => ({ runs: () => e2eRuns }),
  agentTeams: () => ({
    teams: () => [{ ...e2eTeam, status: e2eTeamCancelled ? 'CANCELLED' : e2eTeam.status }],
    service: {
      status: async () => ({ team: { ...e2eTeam, status: e2eTeamCancelled ? 'CANCELLED' : e2eTeam.status }, tasks: e2eTasks, blocked: [] }),
      cancel: async () => {
        e2eTeamCancelled = true
        return { team: { ...e2eTeam, status: 'CANCELLED' }, tasks: e2eTasks.map(task => ({ ...task, status: task.status === 'QUEUED' ? 'CANCELLED' : task.status })), blocked: [] }
      },
    },
  }),
})
const previewForward: PreviewForwardPort = {
  async forward(runtimeRef, forwarded) {
    if (!previewRuntime.managed.has(runtimeRef)) return { status: 404, body: Buffer.from('runtime missing') }
    if (forwarded.path !== '/') return { status: 404, body: Buffer.from('not found') }
    return {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: Buffer.from('<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Protótipo E2E</title></head><body><main><h1>Protótipo E2E carregado</h1><p>Ambiente local de conferência.</p></main><script>document.cookie="dz23_studio_session=shadow; Domain=dz23.localhost; Path=/; SameSite=Lax";document.cookie="dz23_studio_csrf=shadow; Domain=dz23.localhost; Path=/; SameSite=Lax";</script></body></html>'),
    }
  },
}
const previewGateway = createPreviewGatewayHttpHandler({ service: previewService, forward: previewForward, studioOrigin: `http://${host}` })
const server = createServer((request, response) => {
  if (request.headers.host === 'preview-attacker.dz23.localhost:4179') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><script>document.cookie="dz23_studio_session_generation=11111111111111111111111111111111; Domain=dz23.localhost; Path=/; SameSite=Strict"</script>')
    return
  }
  if (/^p-[a-f0-9]{24}\.dz23\.localhost:4179$/u.test(request.headers.host ?? '')) return void previewGateway(request, response)
  if (request.url === '/healthz') return plain(response, 200, 'ok')
  // Reinício do estado da equipe de exemplo. Existe SÓ neste servidor de
  // prova: sem ele, o teste que para o trabalho deixaria a equipe interrompida
  // para os tamanhos de tela seguintes, e eles reprovariam por causa da ordem
  // em que rodaram - não por um defeito.
  if (request.url === '/e2e/reset-team') { e2eTeamCancelled = false; return plain(response, 200, 'ok') }
  // Mesmo motivo do reinicio da equipe: o teste que marca o objetivo como
  // terminado deixaria os tamanhos de tela seguintes sem o botao, e eles
  // reprovariam pela ORDEM em que rodaram, e nao por um defeito.
  // Devolve o cabeçalho `Cookie` como o NAVEGADOR o montou. Existe só aqui, e
  // existe porque `context.cookies(url)` do Playwright filtra por URL: um
  // cookie `Secure` não aparece numa consulta `http://`, mesmo estando gravado
  // e sendo enviado. Foi assim que a prova do nome forte quase virou uma
  // conclusão errada — "o navegador recusou" — sobre um cookie que ele aceitou.
  if (request.url === '/e2e/echo-cookie') return plain(response, 200, request.headers.cookie ?? '')
  if (request.url === '/e2e/reset-mission') { e2eMissions = e2eMissionSeed(); return plain(response, 200, 'ok') }
  if (request.url?.startsWith('/api/studio/identity') === true) return void identityHandler(request, response)
  if (request.url?.startsWith('/api/studio/missions') === true) return void missionHandler(request, response)
  if (request.url?.startsWith('/api/studio/apps') === true) return void apiHandler(request, response)
  return void webHandler(request, response)
})
await assertBuiltInterfaceIsFresh(resolve(root, 'apps', 'studio-web'))
server.listen(4179, '127.0.0.1')
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { server.close(() => { void rm(scratch, { recursive: true, force: true }).finally(() => process.exit(0)) }) })

function plain(response: ServerResponse<IncomingMessage>, status: number, body: string) { response.writeHead(status, { 'content-type': 'text/plain' }); response.end(body) }

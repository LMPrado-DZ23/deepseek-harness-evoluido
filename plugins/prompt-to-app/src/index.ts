import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { JobId, JobStart } from '@deepseek-ai/dsh-jobs'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@dz23-studio/identity'
import type {} from '@dz23-studio/route-health'
import type {} from '@dz23-studio/tenancy'
import { PRODUCTION_BUILDER_ROOT_POLICY, builderRuntimeRegistryPath, type BuilderSupervisorRootPolicy } from '@dz23-studio/builder-supervisor'
import { mkdir, readFile, statfs } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { chaveArmazenada } from './creation-key.js'
import { healthCapabilities, storageProbe } from './capability-registry.js'
import { createPromptToAppHttpHandler, type StudioAppsHealth } from './http.js'
import { PromptToAppJobService, type EmergencyStopGuard, type PromptToAppJobRegistry } from './jobs.js'
import {
  studioAppSpecsDomainSpec,
  studioApprovalsDomainSpec,
  studioDesignSpecsDomainSpec,
  studioEvidenceDomainSpec,
  studioIntakeTurnsDomainSpec,
  studioPlansDomainSpec,
  studioCreationKeysDomainSpec,
  type StudioCreationKey,
  studioProjectsDomainSpec,
  studioRunsDomainSpec,
  type PromptToAppKey,
  type StudioApproval,
  studioProjectCategorySchema,
  type StudioAppSpecRecord,
  type StudioDesignSpecRecord,
  type StudioEvidence,
  type StudioIntakeTurn,
  type StudioPlan,
  type StudioProject,
  type StudioRun,
} from './model.js'
import { IntakeEngine } from './intake.js'
import { appCodeContext } from './code-intelligence.js'
import { listTreeFiles } from './runner.js'
import { skillCardsFrom } from './skill-registry.js'
import type { IntakeTurnRecordStore } from './intake-turn-store.js'
import type { DesignSpecRecordStore } from './design-spec-store.js'
import type { AppSpecRecordStore } from './app-spec-store.js'
import type { PlanRecordStore } from './plan-store.js'
import type { EvidenceRecordStore } from './evidence-store.js'
import { ModelCodeGenerator, PromptToAppPipeline } from './pipeline.js'
import { PlannerEngine } from './planner.js'
import { HarnessPromptModel } from './ports.js'
import { ManagedBuilderLifecycleResolver } from './builder-resolver.js'
import { PromptToAppService, type PromptToAppActor, type PromptToAppRepository } from './service.js'
import { SharpLogoProcessor } from './logo.js'
import { productionTemplateDirectory } from './template-policy.js'

export * from './appspec.js'
export * from './auth-generator.js'
export * from './builder-lifecycle.js'
export * from './builder-resolver.js'
export * from './checkpoint.js'
export * from './crud-generator.js'
export * from './generator.js'
export * from './design.js'
export * from './data-generator.js'
export * from './form-generator.js'
export * from './logo.js'
export * from './import-policy.js'
export * from './acceptance.js'
export * from './http.js'
export * from './intake.js'
export * from './intake-turn-store.js'
export * from './design-spec-store.js'
export * from './app-spec-store.js'
export * from './plan-store.js'
export * from './evidence-store.js'
export * from './jobs.js'
export * from './model.js'
export * from './planner.js'
export * from './pipeline.js'
export * from './ports.js'
export * from './runner.js'
export * from './service.js'
export * from './state.js'
export * from './research-egress.js'
export * from './template-policy.js'

export const name = 'dz23-studio-prompt-to-app'
export const inject = ['agents', 'jobs', 'llm', 'storageDomain', 'studioIdentity', 'studioRouteHealth', 'studioTenancy', 'webServer']

export interface PromptToAppPluginConfig {
  readonly allowedHosts?: readonly string[]
  readonly allowedOrigins?: readonly string[]
  readonly modelByRoute?: Readonly<Record<string, string>>
  readonly runsRoot?: string
  /**
   * Teto de tokens de UMA criação, somando as três tentativas.
   *
   * Ausente, não há teto — e isso é deliberado: um limite inventado cortaria a
   * criação de quem não pediu limite nenhum. Quem instala com chave própria e
   * quer previsibilidade de gasto configura aqui.
   */
  readonly generationTokenBudget?: number
  /**
   * Onde as RESPOSTAS do intake ficam guardadas.
   *
   * `kv` é o padrão e é a chave-valor de sempre. `rls` põe este domínio em
   * tabela por inquilino, com a política do banco recusando o que não é do
   * escopo — defesa em profundidade sobre o filtro que o produto já faz.
   *
   * O padrão NÃO muda sozinho, e isso é deliberado: uma instalação que já roda
   * não pode trocar de autoridade de armazenamento porque atualizou. Quem opera
   * decide, e decide aqui.
   *
   * Pedir `rls` sem o armazenamento por inquilino disponível FALHA ALTO, em vez
   * de cair calado para a chave-valor: uma instalação que pediu isolamento no
   * banco e recebeu isolamento só por código acreditaria ter uma garantia que
   * não tem.
   */
  readonly intakeTurnStorage?: 'kv' | 'rls'
  /** O mesmo, para as ESCOLHAS DE VISUAL do projeto. Padrão `kv`. */
  readonly designSpecStorage?: 'kv' | 'rls'
  /** O mesmo, para a ESPECIFICAÇÃO do aplicativo. Padrão `kv`. */
  readonly appSpecStorage?: 'kv' | 'rls'
  /** O mesmo, para o PLANO aprovado. Padrão `kv`. */
  readonly planStorage?: 'kv' | 'rls'
  /** O mesmo, para as EVIDÊNCIAS da execução. Padrão `kv`. */
  readonly evidenceStorage?: 'kv' | 'rls'
  readonly logoStoreRoot?: string
  readonly builderLifecycle?: {
    readonly registryReference?: `file:${string}`
    readonly roots?: BuilderSupervisorRootPolicy
  }
}

export interface StudioPromptToAppRuntime {
  readonly service: PromptToAppService
  readonly pipeline: PromptToAppPipeline
  /**
   * As criações em voo, expostas para que uma parada de emergência alcance
   * TODAS as deste escopo. Sem isto, o botão só conseguiria barrar a próxima -
   * e um botão que só impede o próximo não é botão de emergência.
   */
  readonly jobs: PromptToAppJobService
  health(): Promise<StudioAppsHealth>
}

declare module '@deepseek-ai/cordis' {
  interface Context { studioPromptToApp: StudioPromptToAppRuntime }
}

class DomainPromptToAppRepository implements PromptToAppRepository {
  constructor(
    private readonly projectTable: KvTable<PromptToAppKey, StudioProject>,
    private readonly specTable: KvTable<PromptToAppKey, StudioAppSpecRecord>,
    private readonly designTable: KvTable<PromptToAppKey, StudioDesignSpecRecord>,
    private readonly turnTable: KvTable<PromptToAppKey, StudioIntakeTurn>,
    private readonly planTable: KvTable<PromptToAppKey, StudioPlan>,
    private readonly runTable: KvTable<PromptToAppKey, StudioRun>,
    private readonly evidenceTable: KvTable<PromptToAppKey, StudioEvidence>,
    private readonly approvalTable: KvTable<PromptToAppKey, StudioApproval>,
    private readonly creationKeyTable: KvTable<PromptToAppKey, StudioCreationKey>,
  ) {}
  projects() { return tableValues(this.projectTable) }
  putProject(value: StudioProject) { return this.projectTable.put(value.project_id as PromptToAppKey, value) }
  specs() { return tableValues(this.specTable) }
  putSpec(value: StudioAppSpecRecord) { return this.specTable.put(value.spec_id as PromptToAppKey, value) }
  designs() { return tableValues(this.designTable) }
  putDesign(value: StudioDesignSpecRecord) { return this.designTable.put(value.design_id as PromptToAppKey, value) }
  turns() { return tableValues(this.turnTable) }
  putTurn(value: StudioIntakeTurn) { return this.turnTable.put(value.turn_id as PromptToAppKey, value) }
  plans() { return tableValues(this.planTable) }
  putPlan(value: StudioPlan) { return this.planTable.put(value.plan_id as PromptToAppKey, value) }
  runs() { return tableValues(this.runTable) }
  putRun(value: StudioRun) { return this.runTable.put(value.run_id as PromptToAppKey, value) }
  evidence() { return tableValues(this.evidenceTable) }
  putEvidence(value: StudioEvidence) { return this.evidenceTable.put(value.evidence_id as PromptToAppKey, value) }
  approvals() { return tableValues(this.approvalTable) }
  putApproval(value: StudioApproval) { return this.approvalTable.put(value.approval_id as PromptToAppKey, value) }
  creationKeys() { return tableValues(this.creationKeyTable) }
  putCreationKey(value: StudioCreationKey) {
    // A chave de armazenamento leva o escopo junto, e nao so a chave do
    // cliente: duas pessoas podem escolher a mesma, e a segunda nao pode
    // sobrescrever a reserva da primeira.
    return this.creationKeyTable.put(chaveArmazenada({ orgId: value.org_id, tenantId: value.tenant_id, userId: value.user_id }, value.request_key) as PromptToAppKey, value)
  }
}

function tableValues<T>(table: KvTable<PromptToAppKey, T>): T[] { return [...table.entries()].map(([, value]) => value) }

/**
 * O armazenamento por inquilino das respostas, quando ele foi PEDIDO e existe.
 *
 * Falha alto quando foi pedido e não existe: cair calado para a chave-valor
 * daria a uma instalação a impressão de ter isolamento no banco sem tê-lo, e
 * essa é a espécie de silêncio que só aparece num incidente.
 * @param ctx - o contexto, de onde sai o armazenamento por inquilino.
 * @param config - a configuração do plugin.
 * @returns a opção pronta para o serviço, ou nada.
 */
function intakeTurnStoreOption(ctx: Context, config: PromptToAppPluginConfig): { readonly intakeTurnStore?: IntakeTurnRecordStore } {
  if ((config.intakeTurnStorage ?? 'kv') === 'kv') return {}
  const records = ctx.get('studioTenantStorage')?.records as IntakeTurnRecordStore | undefined
  if (records === undefined) throw new Error('INTAKE_TURN_TENANT_STORAGE_UNAVAILABLE')
  return { intakeTurnStore: records }
}

/** O mesmo, para as evidências. Falha alto pelo mesmo motivo. */
function evidenceStoreOption(ctx: Context, config: PromptToAppPluginConfig): { readonly evidenceStore?: EvidenceRecordStore } {
  if ((config.evidenceStorage ?? 'kv') === 'kv') return {}
  const records = ctx.get('studioTenantStorage')?.records as EvidenceRecordStore | undefined
  if (records === undefined) throw new Error('EVIDENCE_TENANT_STORAGE_UNAVAILABLE')
  return { evidenceStore: records }
}

/** O mesmo, para o plano aprovado. Falha alto pelo mesmo motivo. */
function planStoreOption(ctx: Context, config: PromptToAppPluginConfig): { readonly planStore?: PlanRecordStore } {
  if ((config.planStorage ?? 'kv') === 'kv') return {}
  const records = ctx.get('studioTenantStorage')?.records as PlanRecordStore | undefined
  if (records === undefined) throw new Error('PLAN_TENANT_STORAGE_UNAVAILABLE')
  return { planStore: records }
}

/** O mesmo, para a especificação. Falha alto pelo mesmo motivo. */
function appSpecStoreOption(ctx: Context, config: PromptToAppPluginConfig): { readonly appSpecStore?: AppSpecRecordStore } {
  if ((config.appSpecStorage ?? 'kv') === 'kv') return {}
  const records = ctx.get('studioTenantStorage')?.records as AppSpecRecordStore | undefined
  if (records === undefined) throw new Error('APP_SPEC_TENANT_STORAGE_UNAVAILABLE')
  return { appSpecStore: records }
}

/** O mesmo, para as escolhas de visual. Falha alto pelo mesmo motivo. */
function designSpecStoreOption(ctx: Context, config: PromptToAppPluginConfig): { readonly designSpecStore?: DesignSpecRecordStore } {
  if ((config.designSpecStorage ?? 'kv') === 'kv') return {}
  const records = ctx.get('studioTenantStorage')?.records as DesignSpecRecordStore | undefined
  if (records === undefined) throw new Error('DESIGN_SPEC_TENANT_STORAGE_UNAVAILABLE')
  return { designSpecStore: records }
}

/**
 * O recorte do registro de integrações que o planejamento usa.
 *
 * Estrutural, e não o tipo do outro pacote: `integration-hub` JÁ depende de
 * `prompt-to-app`, e importar de volta fecharia um ciclo. Sem esta interface,
 * `ctx.get('studioIntegrationHub')` chega aqui sem tipo — e um `skillBody`
 * renomeado do outro lado compilaria em silêncio deste, que foi exatamente o
 * que uma sondagem com um nome errado mostrou acontecer.
 */
export interface SkillHubShape {
  readonly service: {
    list(actor: HubActorShape): Promise<readonly {
      readonly integration_id: string
      readonly kind: string
      readonly enabled: boolean
      readonly manifest: {
        readonly name: string
        readonly skill?: { readonly trigger: string; readonly body_chars: number } | undefined
        readonly provenance?: { readonly artifact_sha256: string } | undefined
      } | null
    }[]>
    skillBody(actor: HubActorShape, integrationId: string): Promise<string>
  }
}

export interface HubActorShape {
  readonly userId: string
  readonly orgId: string
  readonly tenantId: string
  readonly role: string
}

/**
 * O ator do planejamento, na forma que o registro de integrações exige.
 *
 * `userId` e `role` já foram conferidos pelo planejador antes de chamar: sem
 * eles ele nem consulta o registro. O `!` aqui é sobre essa garantia, e não
 * sobre confiança no chamador.
 * @param actor - quem planeja.
 * @returns o ator do Hub.
 */
function hubActor(actor: { readonly orgId: string; readonly tenantId: string; readonly userId?: string | undefined; readonly role?: string | undefined }): HubActorShape {
  return { userId: actor.userId!, orgId: actor.orgId, tenantId: actor.tenantId, role: actor.role! }
}

export async function apply(ctx: Context, config: PromptToAppPluginConfig = {}): Promise<void> {
  const [projects, specs, designs, turns, plans, runs, evidence, approvals, creationKeys]: [
    Domain<typeof studioProjectsDomainSpec>, Domain<typeof studioAppSpecsDomainSpec>,
    Domain<typeof studioDesignSpecsDomainSpec>,
    Domain<typeof studioIntakeTurnsDomainSpec>, Domain<typeof studioPlansDomainSpec>,
    Domain<typeof studioRunsDomainSpec>, Domain<typeof studioEvidenceDomainSpec>,
    Domain<typeof studioApprovalsDomainSpec>, Domain<typeof studioCreationKeysDomainSpec>,
  ] = await Promise.all([
    ctx.storageDomain.open(studioProjectsDomainSpec), ctx.storageDomain.open(studioAppSpecsDomainSpec),
    ctx.storageDomain.open(studioDesignSpecsDomainSpec),
    ctx.storageDomain.open(studioIntakeTurnsDomainSpec), ctx.storageDomain.open(studioPlansDomainSpec),
    ctx.storageDomain.open(studioRunsDomainSpec), ctx.storageDomain.open(studioEvidenceDomainSpec),
    ctx.storageDomain.open(studioApprovalsDomainSpec), ctx.storageDomain.open(studioCreationKeysDomainSpec),
  ])
  ctx.effect(() => async () => { await Promise.all([projects.close(), specs.close(), designs.close(), turns.close(), plans.close(), runs.close(), evidence.close(), approvals.close(), creationKeys.close()]) }, 'studio-prompt-to-app.domainClose')
  // Os dominios que ABRIRAM. A lista e montada DEPOIS do `await` de cima, entao
  // ela so existe se todos abriram — e e por isso que ela serve de sinal: uma
  // abertura que falhasse teria derrubado o `apply()` antes desta linha.
  const OPEN_DOMAIN_NAMES = [
    studioProjectsDomainSpec.name, studioAppSpecsDomainSpec.name, studioDesignSpecsDomainSpec.name,
    studioIntakeTurnsDomainSpec.name, studioPlansDomainSpec.name, studioRunsDomainSpec.name,
    studioEvidenceDomainSpec.name, studioApprovalsDomainSpec.name, studioCreationKeysDomainSpec.name,
  ]

  const repository = new DomainPromptToAppRepository(
    projects.table('projects'), specs.table('specs'), designs.table('designs'), turns.table('turns'), plans.table('plans'),
    runs.table('runs'), evidence.table('evidence'), approvals.table('approvals'), creationKeys.table('keys'),
  )
  const service = new PromptToAppService({ repository, ...intakeTurnStoreOption(ctx, config), ...designSpecStoreOption(ctx, config), ...appSpecStoreOption(ctx, config), ...planStoreOption(ctx, config), ...evidenceStoreOption(ctx, config) })
  await service.reconcileInterruptedExecutions()
  const model = new HarnessPromptModel({
    llm: ctx.llm,
    routes: ctx.studioRouteHealth.service,
    markScope: (options, scope) => ctx.studioRouteHealth.markScope(options, scope),
    markPrivacy: (options, privacy) => ctx.studioRouteHealth.markPrivacy(options, privacy),
    modelByRoute: config.modelByRoute ?? {
      ollama: 'qwen2.5-coder:7b', omniroute: 'deepseek-v3.2', 'deepseek-official': 'deepseek-chat',
    },
  })
  const runsRoot = resolve(config.runsRoot ?? resolve(homedir(), '.dz23-studio', 'generated-runs'))
  const logoStoreRoot = resolve(config.logoStoreRoot ?? resolve(homedir(), '.dz23-studio', 'assets'))
  const templateDirectory = productionTemplateDirectory()
  await Promise.all([mkdir(runsRoot, { recursive: true }), mkdir(logoStoreRoot, { recursive: true })])
  const builderRoots = config.builderLifecycle?.roots ?? PRODUCTION_BUILDER_ROOT_POLICY
  const builder = new ManagedBuilderLifecycleResolver({
    roots: builderRoots,
    registryReference: config.builderLifecycle?.registryReference ?? `file:${builderRuntimeRegistryPath(builderRoots)}`,
  })
  // Resolvido a CADA pergunta, nunca capturado aqui. O botão de emergência é
  // opcional no perfil: se ele não subiu, não há nada a perguntar; se ele subir
  // DEPOIS deste plugin, a próxima pergunta já o encontra. Capturar o serviço
  // agora deixaria o botão morto exatamente na ordem de montagem que ninguém
  // testa.
  const emergencyStop: EmergencyStopGuard = {
    assertRunning(scope) {
      const runtime = ctx.get('studioEmergencyStop')
      if (runtime !== undefined) runtime.service.assertRunning(scope)
    },
  }
  const pipeline = new PromptToAppPipeline({
    service, builder, templateDirectory, runsRoot, logoStoreRoot, emergencyStop,
    ...(config.generationTokenBudget === undefined ? {} : { generationTokenBudget: config.generationTokenBudget }),
  })
  const registry: PromptToAppJobRegistry = {
    start: spec => ctx.jobs.start(spec as JobStart) as JobId,
    kill: (id, owner, reason) => ctx.jobs.kill(id, owner, reason),
  }
  const jobs = new PromptToAppJobService({
    service, pipeline, registry, emergencyStop,
    owners: {
      async create(_actor, runId) {
        const handle = await ctx.agents.create({
          sessionId: SessionId(`studio-prompt-job-${runId}`),
          meta: { cwd: runsRoot, origin: 'subagent', delegationDepth: 0, agentPreset: 'dz23-prompt-job-owner' },
          setup: () => undefined,
        })
        return { owner: handle.agent, dispose: () => handle.dispose() }
      },
    },
  })
  ctx.jobs.attachController('dz23-studio-prompt-to-app')
  const intake = new IntakeEngine(model)
  // As habilidades vêm do REGISTRO DE INTEGRAÇÕES, resolvido a cada
  // planejamento e nunca capturado na montagem: a ordem entre plugins não é
  // garantida, e capturar aqui deixaria o planejamento sem habilidades em
  // qualquer perfil que monte o Hub depois deste.
  //
  // Hub ausente devolve lista VAZIA, e não erro: o planejamento é o caminho
  // central do produto, e uma instalação sem Hub tem de continuar planejando.
  // O que ela não tem é habilidade, o que é verdade e não falha.
  const planner = new PlannerEngine(model, undefined, {
    cards: async actor => {
      const hub = (ctx.get('studioIntegrationHub') as SkillHubShape | undefined)?.service
      if (hub === undefined) return []
      const rows = await hub.list(hubActor(actor))
      return skillCardsFrom(rows).cards
    },
    // A carga passa pelo `skillBody` do Hub, e NÃO lê o campo direto: é lá que
    // moram a reconferência da assinatura, a do tamanho, a da impressão e a
    // recusa de habilidade desligada. Ler o campo aqui seria uma segunda porta
    // para o mesmo texto, sem nenhuma dessas conferências.
    load: async (actor, skillId) => {
      const hub = (ctx.get('studioIntegrationHub') as SkillHubShape | undefined)?.service
      if (hub === undefined) throw new Error('SKILL_REGISTRY_UNAVAILABLE')
      return hub.skillBody(hubActor(actor), skillId)
    },
  })
  const healthFor = async (scope: { readonly orgId: string; readonly tenantId: string }): Promise<StudioAppsHealth> => {
    // `chooseRoute` é a MESMA decisão que a geração toma, e ela devolve o
    // motivo. Reimplementar aqui um "primeira saudável" ao lado dela era como o
    // motivo se perdia: a tela mostrava um nome de rota que podia nem ser a
    // escolhida, e nunca o porquê.
    const selected = await ctx.studioRouteHealth.service.chooseRoute(scope, 'plan', { privacy: 'melhor-qualidade' })
    const route = selected.route ?? null
    // A MESMA decisão, feita com o perfil privado: é a única resposta honesta
    // para "a criação privada funciona agora?", e ela é a pergunta que a tela
    // precisa responder ANTES de a pessoa escolher o perfil.
    const localSelected = await ctx.studioRouteHealth.service.chooseRoute(scope, 'plan', { privacy: 'privado-local' })
    const [builderHealth, disk] = await Promise.all([
      builder.forActor({ userId: 'studio-health', orgId: scope.orgId, tenantId: scope.tenantId, role: 'owner' }).then(session => session.preflight()).catch(() => ({ state: 'BLOCKED_EXTERNAL' as const })),
      diskState(runsRoot),
    ])
    const state = route !== null && builderHealth.state === 'OK' && disk === 'OK' ? 'OK' : 'ATTENTION'
    // O QUE ESTA INSTALACAO CONSEGUE FAZER (T-22). Os campos acima respondem
    // "a rota esta boa?" e "o construtor respondeu?"; nenhum deles responde a
    // pergunta que a pessoa faz, que e se ela consegue CRIAR UM APLICATIVO.
    //
    // Os sinais sao os mesmos que ja foram medidos logo acima e os dominios que
    // este plugin abriu. Medi-los de novo criaria uma segunda verdade sobre o
    // mesmo fato, e duas medidas do mesmo fato divergem no primeiro conserto.
    const observedAt = new Date()
    // A LEITURA DE VERDADE do armazenamento. A lista de domínios abertos é uma
    // constante montada uma vez no arranque, e lê-la não exercita nada — a
    // revisão adversarial cobrou exatamente isso. Perguntar pelos projetos
    // agora, e ele responder, é o que vale como sondagem.
    // DOIS domínios, e não um. Ler só `projects` declarava o armazenamento
    // inteiro saudável com o domínio de execuções quebrado — e a pessoa
    // descobriria isso tentando criar um aplicativo, que é exatamente o momento
    // em que este registro existe para avisar ANTES.
    const storage = storageProbe({
      projects: () => service.listProjects(healthActor(scope)),
      runs: () => service.runsInScope(healthActor(scope)),
    }, observedAt)
    // A criação mais recente que TERMINOU, em qualquer projeto deste espaço.
    // Sem ela `criar-aplicativo` fica em "ninguém conferiu" para sempre, mesmo
    // depois de cem criações — e essa era a resposta permanente da tela.
    const lastRun = latestFinishedRun(service, healthActor(scope))
    const capabilities = healthCapabilities({
      // `exercised`: uma rota apenas CONFIGURADA não é sondagem nenhuma —
      // `initialize` grava `OK` para toda rota que aparece na configuração, sem
      // ninguém ter chamado nada. E `at` é o instante DO REGISTRO, não o da
      // leitura: carimbar a leitura fazia a idade ser sempre zero, e a janela
      // de validade nunca expirava nada.
      routes: ctx.studioRouteHealth.service.list(scope).map(record => ({
        route: record.route, state: record.state,
        exercised: record.requests > 0,
        ...(readInstant(record.updated_at) === undefined ? {} : { at: readInstant(record.updated_at)! }),
      })),
      builderState: builderHealth.state,
      storage,
      categories: studioProjectCategorySchema.options,
      ...(lastRun === undefined ? {} : { lastRun }),
      now: observedAt,
    })
    return {
      state, route, route_reason: route === null ? null : selected.reason, capabilities,
      // O CÓDIGO do motivo, ao lado da frase de operação: a tela de quem não
      // opera o Studio traduz o código em efeito e próximo passo, em vez de
      // mostrar "meia-abertura" e "teto de escopo" para quem não programa.
      route_reason_code: selected.reasonCode,
      local_route: localSelected.route ?? null, builder: builderHealth.state, disk,
    }
  }
  const health = () => healthFor({ orgId: 'studio-system', tenantId: 'studio-system' })
  ctx.provide('studioPromptToApp', { service, pipeline, jobs, health })

  const port = ctx.webServer.port
  const defaultHost = `127.0.0.1:${port}`; const defaultOrigin = `http://localhost:${port}`
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix', path: '/api/studio/apps',
    handler: createPromptToAppHttpHandler({
      service, identity: ctx.studioIdentity.service, tenancy: ctx.studioTenancy.service,
      intake, planner, jobs, emergencyStop,
      logos: new SharpLogoProcessor(logoStoreRoot),
      generatorFor: (actor, projectId) => new ModelCodeGenerator(model, actor, service.project(actor, projectId).privacy),
      health: actor => healthFor({ orgId: actor.orgId, tenantId: actor.tenantId }),
      /*
        O USO do espaço de trabalho, lido de `route-health`.

        Nenhum contador novo: `list` e `budget` são o que o plugin já grava e já
        usa para decidir rota. A rota HTTP só apresenta. O adendo de uso e
        custos proíbe uma segunda contabilidade, e esta linha é a prova de que
        não há uma — ela não soma nada, ela repassa.
      */
      usage: actor => {
        const escopo = { orgId: actor.orgId, tenantId: actor.tenantId }
        return {
          routes: ctx.studioRouteHealth.service.list(escopo).map(registro => ({
            route: registro.route,
            requests: registro.requests,
            input_tokens: registro.input_tokens,
            output_tokens: registro.output_tokens,
            estimated_cost_usd: registro.estimated_cost_usd,
            unpriced_requests: registro.unpriced_requests ?? 0,
          })),
          budget: ctx.studioRouteHealth.service.budget(escopo),
        }
      },
      // O inventário do código que JÁ existe, lido do diretório da execução
      // mais recente que produziu alguma coisa.
      //
      // A execução mais recente, e não a mais recente APROVADA: um pedido de
      // mudança quase sempre vem depois de uma tentativa que a pessoa não
      // gostou, e é o código DELA que está no disco. Escolher a última
      // aprovada mostraria ao planejador um aplicativo que não é o que existe.
      //
      // `undefined` quando não há execução: projeto que nunca gerou nada não
      // tem código, e isso não é uma leitura falhada.
      codeContext: async (actor, projectId) => appCodeContext(
        service.runs(actor, projectId),
        async path => readFile(path, 'utf8'),
        listTreeFiles,
      ),
      allowedHosts: config.allowedHosts ?? [defaultHost, `localhost:${port}`],
      allowedOrigins: config.allowedOrigins ?? [defaultOrigin, `http://${defaultHost}`],
    }),
  }), 'studio-prompt-to-app.http')
}

async function diskState(path: string): Promise<'OK' | 'ATTENTION'> {
  try {
    const info = await statfs(path)
    return Number(info.bavail) * Number(info.bsize) >= 512 * 1024 * 1024 ? 'OK' : 'ATTENTION'
  } catch { return 'ATTENTION' }
}

/**
 * O ator de leitura do endereço de saúde, no escopo de quem perguntou.
 *
 * `owner` porque a conferência é uma LEITURA e precisa alcançar o espaço
 * inteiro; o escopo continua sendo o de quem chamou, então ela nunca enxerga
 * outra organização.
 */
function healthActor(scope: { readonly orgId: string; readonly tenantId: string }): PromptToAppActor {
  return { userId: 'studio-health', orgId: scope.orgId, tenantId: scope.tenantId, role: 'owner' }
}

/**
 * Uma data que o registro guardou, ou `undefined` quando ela não é legível.
 *
 * Data ilegível é DESCARTADA, e nunca tratada como agora: uma linha corrompida
 * sustentaria `OPERACIONAL` para sempre.
 */
function readInstant(value: string): Date | undefined {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

/**
 * A criação mais recente que TERMINOU neste espaço de trabalho.
 *
 * Só estados terminais contam: uma execução `RUNNING` não provou nada ainda, e
 * tratá-la como prova diria que a cadeia inteira funciona no instante em que
 * ela mal começou.
 */
function latestFinishedRun(
  service: PromptToAppService, actor: PromptToAppActor,
): { readonly passed: boolean; readonly at: Date } | undefined {
  let best: { readonly passed: boolean; readonly at: Date } | undefined
  // UMA leitura. O laço sobre os projetos chamando `runs` para cada um era
  // quadrático — `runs` lê o repositório inteiro — e media 188 ms com quinhentos
  // projetos, num endereço que a tela consulta de tempos em tempos.
  for (const run of service.runsInScope(actor)) {
    if (run.state !== 'PASSED' && run.state !== 'FAILED') continue
    const at = readInstant(run.finished_at ?? run.started_at)
    if (at === undefined) continue
    if (best === undefined || at.getTime() > best.at.getTime()) best = { passed: run.state === 'PASSED', at }
  }
  return best
}

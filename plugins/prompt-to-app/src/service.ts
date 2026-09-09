import { createHash, randomUUID } from 'node:crypto'
import { roleAllows, type StudioRole } from '@dz23-studio/policy'
import { routePrivacyProfile, type RoutePrivacy } from '@dz23-studio/route-health'
import { appSpecHash, type AppSpecV1 } from './appspec.js'
import { createDesignSpec, designSpecHash, designSpecV1Schema, type DesignLogo, type DesignSelection, type DesignSpecV1 } from './design.js'
import type {
  PromptToAppKey, ProjectState, StudioApproval, StudioAppSpecRecord, StudioEvidence,
  StudioDesignSpecRecord, StudioIntakeTurn, StudioPlan, StudioPlanSlice, StudioProject, StudioProjectCategory, StudioRun,
} from './model.js'
import { assertProjectTransition, assertUndoTransition } from './state.js'
import { appendPlanSlice, applyPlanEdit, planRevision, PlanEditError, type PlanEdit } from './plan-edit.js'
import { listIntakeTurns, putIntakeTurn, type IntakeTurnRecordStore } from './intake-turn-store.js'
import { listDesignSpecs, putDesignSpec, type DesignSpecRecordStore } from './design-spec-store.js'
import { latestGreenCheckpoint, noGreenReason, runCheckpoints, type CheckpointBlocker, type RunCheckpoint, NO_ATTEMPT } from './checkpoint.js'
import { t } from './i18n.js'

export interface PromptToAppActor {
  readonly userId: string
  readonly orgId: string
  readonly tenantId: string
  readonly role: StudioRole
  readonly sessionId?: string
}

export interface PromptToAppRepository {
  projects(): readonly StudioProject[]
  putProject(value: StudioProject): Promise<void>
  specs(): readonly StudioAppSpecRecord[]
  putSpec(value: StudioAppSpecRecord): Promise<void>
  designs(): readonly StudioDesignSpecRecord[]
  putDesign(value: StudioDesignSpecRecord): Promise<void>
  turns(): readonly StudioIntakeTurn[]
  putTurn(value: StudioIntakeTurn): Promise<void>
  plans(): readonly StudioPlan[]
  putPlan(value: StudioPlan): Promise<void>
  runs(): readonly StudioRun[]
  putRun(value: StudioRun): Promise<void>
  evidence(): readonly StudioEvidence[]
  putEvidence(value: StudioEvidence): Promise<void>
  approvals(): readonly StudioApproval[]
  putApproval(value: StudioApproval): Promise<void>
}

export class PromptToAppError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'FORBIDDEN' | 'INVALID' | 'REPLAY' | 'CAPACITY', message: string) { super(message) }
}

export interface PromptToAppServiceOptions {
  readonly repository: PromptToAppRepository
  readonly now?: () => Date
  readonly createId?: () => string
  /**
   * O armazenamento por inquilino das RESPOSTAS do intake, quando existir.
   *
   * Ausente é o padrão, e ausente quer dizer chave-valor — o mesmo caminho de
   * sempre. Uma instalação que já roda NÃO pode mudar de autoridade de
   * armazenamento porque atualizou: isso é decisão de quem opera, e ela é
   * tomada na configuração do plugin.
   *
   * Só este domínio por enquanto, e de propósito: é o primeiro passo do plano
   * do `S-08`, escolhido por ser o de menor superfície (dois pontos no serviço
   * inteiro) e por não participar da geração.
   */
  readonly intakeTurnStore?: IntakeTurnRecordStore
  /**
   * O armazenamento por inquilino das ESCOLHAS DE VISUAL, quando existir.
   *
   * Segundo domínio do plano do `S-08`. Mesmas regras do primeiro: ausente é o
   * padrão e significa chave-valor, e quem opera é quem decide.
   */
  readonly designSpecStore?: DesignSpecRecordStore
}

export class PromptToAppService {
  readonly #repository: PromptToAppRepository
  readonly #now: () => Date
  readonly #createId: () => string
  readonly #intakeTurnStore: IntakeTurnRecordStore | undefined
  readonly #designSpecStore: DesignSpecRecordStore | undefined
  constructor(options: PromptToAppServiceOptions) {
    this.#repository = options.repository
    this.#now = options.now ?? (() => new Date())
    this.#createId = options.createId ?? randomUUID
    this.#intakeTurnStore = options.intakeTurnStore
    this.#designSpecStore = options.designSpecStore
  }

  assertAuthorized(actor: PromptToAppActor, permission: 'project.read' | 'project.write'): void {
    this.#authorize(actor, permission)
  }

  listProjects(actor: PromptToAppActor): readonly StudioProject[] {
    this.#authorize(actor, 'project.read')
    return this.#repository.projects().filter(value => this.#sameScope(actor, value) && value.archived_at === null)
  }

  project(actor: PromptToAppActor, projectId: string): StudioProject {
    this.#authorize(actor, 'project.read')
    const value = this.#repository.projects().find(candidate => candidate.project_id === projectId && this.#sameScope(actor, candidate))
    if (value === undefined) throw new PromptToAppError('NOT_FOUND', t('errors.notFound'))
    return value
  }

  async createProject(actor: PromptToAppActor, input: Pick<StudioProject, 'name' | 'original_brief' | 'category' | 'privacy'>): Promise<StudioProject> {
    this.#authorize(actor, 'project.write')
    const now = this.#now().toISOString()
    const value: StudioProject = {
      project_id: this.#createId(), org_id: actor.orgId, tenant_id: actor.tenantId,
      ...input,
      // Gravação nova sai SEMPRE com o nome do perfil, nunca com o valor
      // binário antigo: o antigo continua sendo lido porque já está em disco,
      // não porque ainda vale a pena escrever mais um.
      privacy: routePrivacyProfile(input.privacy),
      state: 'DRAFT', created_by: actor.userId, created_at: now, updated_at: now, archived_at: null,
    }
    await this.#repository.putProject(value)
    return value
  }

  /**
   * As respostas do intake deste projeto.
   *
   * ASSÍNCRONA desde setembro/2026, e ela ainda lê a mesma chave-valor de
   * sempre. A troca de forma veio PRIMEIRO, de propósito: é o passo do plano do
   * `S-08` que não muda armazenamento nenhum e por isso não pode quebrar nada
   * que os testes não apanhem na hora — o `tsc` aponta cada ponto que precisa
   * esperar, um por um.
   *
   * Uma leitura com RLS é assíncrona e recebe o ator; esta já é as duas coisas.
   * Quando o repositório por inquilino entrar, o que muda é de onde os dados
   * vêm — e não a assinatura de quem os pede, que é o tipo de mudança que
   * costuma arrastar meia base de código de uma vez só.
   * @param actor - quem lê; o escopo sai daqui.
   * @param projectId - o projeto.
   * @returns as respostas, na ordem em que foram gravadas.
   */
  async intakeTurns(actor: PromptToAppActor, projectId: string): Promise<readonly StudioIntakeTurn[]> {
    this.project(actor, projectId)
    // O filtro de escopo do produto continua AQUI, com ou sem RLS. Trocar uma
    // guarda pela outra seria andar de lado: a RLS protege do dia em que
    // alguém escrever uma consulta nova e esquecer o `where`, e o filtro
    // protege do dia em que a política do banco não estiver onde se pensava.
    const rows = this.#intakeTurnStore === undefined
      ? this.#repository.turns()
      : await listIntakeTurns(this.#intakeTurnStore, { orgId: actor.orgId, tenantId: actor.tenantId })
    return rows.filter(value => value.project_id === projectId && this.#sameScope(actor, value))
  }

  async recordTurn(actor: PromptToAppActor, projectId: string, input: Pick<StudioIntakeTurn, 'question_id' | 'question' | 'answer' | 'recommended' | 'route' | 'model'>): Promise<StudioIntakeTurn> {
    this.#authorize(actor, 'project.write'); this.project(actor, projectId)
    const value: StudioIntakeTurn = {
      turn_id: this.#createId(), project_id: projectId, org_id: actor.orgId, tenant_id: actor.tenantId,
      ...input, created_at: this.#now().toISOString(),
    }
    if (this.#intakeTurnStore === undefined) await this.#repository.putTurn(value)
    else await putIntakeTurn(this.#intakeTurnStore, value)
    return value
  }

  async saveSpec(actor: PromptToAppActor, projectId: string, spec: AppSpecV1, origin: 'intake' | 'edit'): Promise<StudioAppSpecRecord> {
    this.#authorize(actor, 'project.write'); this.project(actor, projectId)
    const previous = this.#repository.specs().filter(value => value.project_id === projectId && this.#sameScope(actor, value))
    const value: StudioAppSpecRecord = {
      spec_id: this.#createId(), project_id: projectId, org_id: actor.orgId, tenant_id: actor.tenantId,
      version: previous.length + 1, app_spec: spec, sha256: appSpecHash(spec), origin, created_at: this.#now().toISOString(),
    }
    await this.#repository.putSpec(value)
    const project = this.project(actor, projectId)
    if (project.state === 'DRAFT') await this.transition(actor, projectId, 'SPEC_READY')
    return value
  }

  latestSpec(actor: PromptToAppActor, projectId: string): StudioAppSpecRecord {
    this.project(actor, projectId)
    const value = this.#repository.specs().filter(candidate => candidate.project_id === projectId && this.#sameScope(actor, candidate))
      .sort((left, right) => right.version - left.version)[0]
    if (value === undefined) throw new PromptToAppError('NOT_FOUND', t('errors.specNotFound'))
    return value
  }

  async saveDesign(actor: PromptToAppActor, projectId: string, input: DesignSelection): Promise<StudioDesignSpecRecord> {
    return this.#saveDesign(actor, projectId, createDesignSpec(input))
  }

  async attachLogo(actor: PromptToAppActor, projectId: string, logo: DesignLogo): Promise<StudioDesignSpecRecord> {
    const current = await this.designOrDefault(actor, projectId)
    return this.#saveDesign(actor, projectId, designSpecV1Schema.parse({ ...current, logo }))
  }

  async latestDesign(actor: PromptToAppActor, projectId: string): Promise<StudioDesignSpecRecord> {
    this.project(actor, projectId)
    // O filtro de escopo do produto continua aqui, com ou sem RLS: as duas
    // guardas juntas é que valem alguma coisa.
    const rows = this.#designSpecStore === undefined
      ? [...this.#repository.designs()].sort((left, right) => right.version - left.version)
      : await listDesignSpecs(this.#designSpecStore, { orgId: actor.orgId, tenantId: actor.tenantId })
    const value = rows.find(candidate => candidate.project_id === projectId && this.#sameScope(actor, candidate))
    if (value === undefined) throw new PromptToAppError('NOT_FOUND', t('errors.designNotFound'))
    return value
  }

  async designOrDefault(actor: PromptToAppActor, projectId: string): Promise<DesignSpecV1> {
    this.project(actor, projectId)
    try { return (await this.latestDesign(actor, projectId)).design_spec } catch (error) {
      if (!(error instanceof PromptToAppError) || error.code !== 'NOT_FOUND') throw error
      return createDesignSpec({ preset: 'modern' })
    }
  }

  async proposePlan(actor: PromptToAppActor, projectId: string, slices: StudioPlan['slices']): Promise<StudioPlan> {
    this.#authorize(actor, 'project.write')
    const spec = this.latestSpec(actor, projectId); const now = this.#now().toISOString()
    const project = this.project(actor, projectId)
    const existing = this.#repository.plans().filter(candidate => candidate.project_id === projectId && this.#sameScope(actor, candidate))
    const previous = [...existing].sort((left, right) => (right.revision ?? 0) - (left.revision ?? 0) || right.created_at.localeCompare(left.created_at))[0]
    const revising = project.state === 'PLAN_PROPOSED' && previous?.status === 'CHANGE_REQUESTED'
    if (project.state !== 'SPEC_READY' && !revising) throw new PromptToAppError('INVALID', t('errors.planOrder'))
    const value: StudioPlan = {
      plan_id: this.#createId(), spec_id: spec.spec_id, project_id: projectId, org_id: actor.orgId, tenant_id: actor.tenantId,
      revision: existing.length + 1, slices, status: 'PROPOSED', created_at: now, updated_at: now,
    }
    await this.#repository.putPlan(value)
    if (!revising) await this.transition(actor, projectId, 'PLAN_PROPOSED')
    return value
  }

  plan(actor: PromptToAppActor, projectId: string): StudioPlan {
    this.project(actor, projectId)
    const value = this.#repository.plans().filter(candidate => candidate.project_id === projectId && this.#sameScope(actor, candidate))
      .sort((left, right) => (right.revision ?? 0) - (left.revision ?? 0) || right.created_at.localeCompare(left.created_at))[0]
    if (value === undefined) throw new PromptToAppError('NOT_FOUND', t('errors.planNotFound'))
    return value
  }

  async approvePlan(actor: PromptToAppActor, projectId: string): Promise<StudioPlan> {
    this.#authorize(actor, 'project.write'); const value = this.plan(actor, projectId)
    if (value.status !== 'PROPOSED') throw new PromptToAppError('REPLAY', t('errors.planUnavailable'))
    const updated = { ...value, status: 'APPROVED' as const, updated_at: this.#now().toISOString() }
    await this.#repository.putPlan(updated)
    await this.#approval(actor, projectId, 'plan', value.plan_id, 'T1', false)
    await this.transition(actor, projectId, 'PLAN_APPROVED')
    return updated
  }

  async requestPlanChange(actor: PromptToAppActor, projectId: string, reason: string): Promise<StudioPlan> {
    this.#authorize(actor, 'project.write')
    if (reason.trim().length < 3 || reason.trim().length > 2_000) throw new PromptToAppError('INVALID', t('errors.planChangeLength'))
    const value = this.plan(actor, projectId)
    if (value.status !== 'PROPOSED') throw new PromptToAppError('REPLAY', t('errors.planChangeUnavailable'))
    const updated = { ...value, status: 'CHANGE_REQUESTED' as const, change_request: reason.trim(), updated_at: this.#now().toISOString() }
    await this.#repository.putPlan(updated)
    return updated
  }

  /**
   * O plano depois da edição feita pela PESSOA (E-03).
   *
   * A regra inteira mora em `applyPlanEdit`, que é função pura; aqui só entram
   * as três coisas que dependem do serviço: quem pode escrever, qual plano é o
   * corrente, e a tradução do erro do módulo para o erro do serviço.
   *
   * A edição NÃO gera aprovação do plano: aprovar continua sendo um ato
   * separado, feito depois de ver o resultado da própria edição. O que ela
   * gera é o REGISTRO da edição, na mesma trilha auditável que as transições
   * já usam — sem ele o repositório sabia que o plano tinha mudado
   * (`revision`) e nunca por quem.
   * @param actor - quem edita.
   * @param projectId - o projeto.
   * @param edit - as mudanças, já validadas pelo schema.
   * @returns o plano gravado, uma revisão à frente.
   */
  async editPlan(actor: PromptToAppActor, projectId: string, edit: PlanEdit): Promise<StudioPlan> {
    this.#authorize(actor, 'project.write')
    const value = this.plan(actor, projectId)
    let updated: StudioPlan
    try {
      updated = applyPlanEdit(value, edit, this.#now().toISOString())
    } catch (error) {
      if (!(error instanceof PlanEditError)) throw error
      // `STALE` e `UNAVAILABLE` viram REPLAY, que a camada HTTP responde como 409:
      // as duas são "o mundo mudou embaixo de você", e não "seu pedido está errado".
      const code = error.code === 'STALE' || error.code === 'UNAVAILABLE' ? 'REPLAY' as const
        : error.code === 'NOT_FOUND' ? 'NOT_FOUND' as const : 'INVALID' as const
      throw new PromptToAppError(code, error.message)
    }
    await this.#repository.putPlan(updated)
    // O REGISTRO da edição. Não é uma aprovação — aprovar continua sendo um ato
    // separado, feito depois de ver o resultado da própria edição —, e sim a
    // mesma trilha auditável que `transition` já usa: um ato de uma pessoa,
    // num nível, com data e autor.
    //
    // Sem ele o plano podia ser reescrito e o repositório só sabia QUE tinha
    // mudado (`revision`), nunca por QUEM. Num produto multiempresa, com papéis
    // e organizações, "alguém com permissão de escrita mudou o que vai ser
    // construído" não é um registro: é a ausência de um.
    //
    // T1 porque editar um plano ainda PROPOSTO não constrói nada nem toca
    // dado sensível. O que constrói é aprovar, e essa aprovação já é gravada.
    await this.#approval(actor, projectId, 'plan', `${updated.plan_id}:r${String(planRevision(updated))}`, 'T1', false)
    return updated
  }

  /**
   * Acrescenta ao plano uma etapa que a pessoa descreveu em português.
   *
   * A edição do plano não conseguia acrescentar NADA: quem quisesse algo fora
   * do plano pedia mudança em texto livre e recebia uma revisão inteira,
   * perdendo junto todos os títulos e critérios que já tinha ajustado à mão.
   *
   * Quem escreve a etapa é o PLANEJADOR, não a pessoa — `planned_files` é a
   * autorização de escrita do gerador, e digitar caminhos à mão seria decidir
   * onde o modelo pode mexer sem ter como saber o que isso significa.
   *
   * @param actor - quem pediu.
   * @param projectId - o projeto.
   * @param request - o que falta, nas palavras da pessoa.
   * @param planner - quem transforma o pedido em etapa.
   * @param privacy - o perfil de rota do projeto.
   * @returns o plano com a etapa nova no fim.
   */
  async addPlanSlice(
    actor: PromptToAppActor,
    projectId: string,
    request: string,
    planner: { slice(scope: { orgId: string; tenantId: string }, privacy: RoutePrivacy, spec: AppSpecV1, existing: readonly { readonly title: string; readonly planned_files: readonly string[] }[], request: string, category: StudioProjectCategory): Promise<StudioPlanSlice> },
    privacy: RoutePrivacy,
  ): Promise<StudioPlan> {
    this.#authorize(actor, 'project.write')
    const text = request.trim()
    // O mesmo teto do pedido de mudança: uma frase curta demais não descreve
    // etapa nenhuma, e uma parede de texto vira um plano que ninguém revisa.
    if (text.length < 3 || text.length > 2_000) throw new PromptToAppError('INVALID', t('errors.sliceUnusable'))
    const project = this.project(actor, projectId)
    const plan = this.plan(actor, projectId)
    const spec = this.latestSpec(actor, projectId).app_spec
    const slice = await planner.slice(
      { orgId: actor.orgId, tenantId: actor.tenantId }, privacy, spec,
      plan.slices.map(existing => ({ title: existing.title, planned_files: existing.planned_files })),
      text, project.category,
    )
    let updated: StudioPlan
    try { updated = appendPlanSlice(plan, slice, this.#now().toISOString()) }
    catch (error) {
      if (!(error instanceof PlanEditError)) throw error
      throw new PromptToAppError(error.code === 'UNAVAILABLE' ? 'REPLAY' : 'INVALID', error.message)
    }
    await this.#repository.putPlan(updated)
    await this.#approval(actor, projectId, 'plan', `${updated.plan_id}:r${String(planRevision(updated))}`, 'T1', false)
    return updated
  }

  async transition(actor: PromptToAppActor, projectId: string, to: ProjectState): Promise<StudioProject> {
    this.#authorize(actor, 'project.write'); const value = this.project(actor, projectId)
    assertProjectTransition(value.state, to)
    const updated = { ...value, state: to, updated_at: this.#now().toISOString() }
    await this.#repository.putProject(updated)
    await this.#approval(actor, projectId, 'transition', `${value.state}:${to}`, 'T1', false, value.state, to)
    return updated
  }

  async putRun(actor: PromptToAppActor, value: StudioRun): Promise<void> {
    this.#authorize(actor, 'project.write'); this.#assertOwned(actor, value); await this.#repository.putRun(value)
  }
  async putEvidence(actor: PromptToAppActor, value: StudioEvidence): Promise<void> {
    this.#authorize(actor, 'project.write'); this.#assertOwned(actor, value); await this.#repository.putEvidence(value)
  }
  /**
   * Os pontos aos quais a pessoa pode voltar, e por que não há nenhum quando não há.
   *
   * Lê o MESMO registro de execução que a tela do relatório lê - não existe uma
   * segunda fonte de verdade sobre o que foi conservado, que é como duas telas
   * passariam a discordar sobre o que aconteceu.
   * @param actor - quem pergunta.
   * @param projectId - o projeto.
   * @returns os pontos, qual deles é seguro, e para onde a pessoa está olhando.
   */
  checkpoints(actor: PromptToAppActor, projectId: string): {
    readonly checkpoints: readonly RunCheckpoint[]
    readonly green_run_id: string | null
    readonly reason: CheckpointBlocker | typeof NO_ATTEMPT | null
    readonly current_run_id: string | null
  } {
    const project = this.project(actor, projectId)
    const checkpoints = runCheckpoints(this.runs(actor, projectId))
    const green = latestGreenCheckpoint(checkpoints)
    return {
      checkpoints,
      green_run_id: green?.run_id ?? null,
      reason: noGreenReason(checkpoints),
      current_run_id: project.current_run_id ?? null,
    }
  }

  /**
   * Volta o projeto para um ponto seguro, sem apagar NADA.
   *
   * Desfazer aqui é navegação, não destruição: nenhum diretório de execução,
   * nenhuma evidência e nenhum registro de tentativa é removido ou reescrito. O
   * que muda é o estado do projeto e qual tentativa é a corrente - isto é, para
   * onde a pessoa está olhando. Um reset destrutivo é proibição explícita do
   * produto, e por isso este método não tem sequer acesso a disco.
   *
   * A recusa é dupla e as duas metades importam: a tentativa precisa ser um
   * ponto PROVADO (`checkpoint.ts`), e o estado atual precisa permitir a volta
   * (`UNDO_TRANSITIONS`). Sem a primeira, qualquer falha viraria um verde; sem a
   * segunda, daria para desfazer no meio de uma criação em andamento.
   * @param actor - quem desfaz.
   * @param projectId - o projeto.
   * @param runId - a tentativa para a qual voltar.
   * @returns o projeto atualizado e o ponto para onde ele voltou.
   */
  async undoToCheckpoint(actor: PromptToAppActor, projectId: string, runId: string): Promise<{ readonly project: StudioProject; readonly checkpoint: RunCheckpoint }> {
    this.#authorize(actor, 'project.write')
    const project = this.project(actor, projectId)
    // `runs` já filtra por org e tenant: uma tentativa de OUTRO escopo não é
    // "recusada depois", ela simplesmente não existe para quem pergunta.
    const checkpoint = runCheckpoints(this.runs(actor, projectId)).find(candidate => candidate.run_id === runId)
    if (checkpoint === undefined) throw new PromptToAppError('NOT_FOUND', t('errors.checkpointNotFound'))
    if (!checkpoint.green) throw new PromptToAppError('INVALID', t('errors.checkpointNotGreen'))
    assertUndoTransition(project.state, 'VERIFIED_PROTOTYPE')
    const updated: StudioProject = {
      ...project, state: 'VERIFIED_PROTOTYPE', current_run_id: checkpoint.run_id,
      updated_at: this.#now().toISOString(),
    }
    await this.#repository.putProject(updated)
    await this.#approval(actor, projectId, 'transition', `undo:${checkpoint.run_id}`, 'T1', false, project.state, 'VERIFIED_PROTOTYPE')
    return { project: updated, checkpoint }
  }

  runs(actor: PromptToAppActor, projectId: string) { this.project(actor, projectId); return this.#repository.runs().filter(value => value.project_id === projectId && this.#sameScope(actor, value)) }
  evidence(actor: PromptToAppActor, projectId: string) { this.project(actor, projectId); return this.#repository.evidence().filter(value => value.project_id === projectId && this.#sameScope(actor, value)) }

  async reconcileInterruptedExecutions(): Promise<{ readonly runs: number; readonly projects: number }> {
    const now = this.#now().toISOString()
    let recoveredRuns = 0
    let recoveredProjects = 0
    for (const run of this.#repository.runs().filter(value => value.state === 'PENDING' || value.state === 'RUNNING')) {
      await this.#repository.putRun({
        ...run, state: 'FAILED', finished_at: now, artifact_sha256: null,
        failure_code: 'STUDIO_RESTARTED_DURING_RUN',
      })
      recoveredRuns++
    }
    for (const project of this.#repository.projects()) {
      if (project.state !== 'GENERATING' && project.state !== 'BUILD_OK' && project.state !== 'TESTS_OK') continue
      const projectRuns = this.#repository.runs().filter(run => run.project_id === project.project_id && run.org_id === project.org_id && run.tenant_id === project.tenant_id)
      const latest = [...projectRuns].sort((left, right) => right.started_at.localeCompare(left.started_at))[0]
      const operationId = latest?.operation_id ?? `recovery-${project.project_id}`
      const markerId = recoveryId('run', project, operationId)
      if (!projectRuns.some(run => run.failure_code === 'STUDIO_RESTARTED_DURING_RUN' && run.operation_id === operationId)) {
        await this.#repository.putRun({
          run_id: markerId, operation_id: operationId, owner_session_id: 'studio-system-recovery',
          plan_id: latest?.plan_id ?? 'recovery-unavailable', project_id: project.project_id,
          org_id: project.org_id, tenant_id: project.tenant_id, stage: latest?.stage ?? 'verify',
          attempt: latest?.attempt ?? 1, state: 'FAILED', started_at: latest?.started_at ?? now, finished_at: now,
          sandbox: latest?.sandbox ?? 'unavailable', route: latest?.route ?? null, model: latest?.model ?? null,
          input_tokens: latest?.input_tokens ?? null, output_tokens: latest?.output_tokens ?? null,
          estimated_cost_usd: latest?.estimated_cost_usd ?? null, run_directory: latest?.run_directory ?? 'not-created',
          artifact_sha256: null, failure_code: 'STUDIO_RESTARTED_DURING_RUN', acceptance_checks: latest?.acceptance_checks ?? [],
        })
        recoveredRuns++
      }
      await this.#repository.putApproval({
        approval_id: recoveryId('transition', project, operationId),
        project_id: project.project_id, org_id: project.org_id, tenant_id: project.tenant_id,
        subject: 'transition', subject_id: `${project.state}:INTERRUPTED:${operationId}`,
        approved_by: 'studio-system-recovery', approved_at: now, tier: 'T1', strong_identity: false,
        from_state: project.state, to_state: 'INTERRUPTED',
      })
      await this.#repository.putProject({ ...project, state: 'INTERRUPTED', updated_at: now })
      recoveredProjects++
    }
    return { runs: recoveredRuns, projects: recoveredProjects }
  }

  async archive(actor: PromptToAppActor, projectId: string): Promise<StudioProject> {
    if (actor.role !== 'owner' && actor.role !== 'admin') throw new PromptToAppError('FORBIDDEN', t('errors.archiveForbidden'))
    const value = this.project(actor, projectId); const updated = { ...value, archived_at: this.#now().toISOString(), updated_at: this.#now().toISOString() }
    await this.#repository.putProject(updated); return updated
  }

  async #saveDesign(actor: PromptToAppActor, projectId: string, designSpec: DesignSpecV1): Promise<StudioDesignSpecRecord> {
    this.#authorize(actor, 'project.write'); this.project(actor, projectId)
    const rows = this.#designSpecStore === undefined
      ? this.#repository.designs()
      : await listDesignSpecs(this.#designSpecStore, { orgId: actor.orgId, tenantId: actor.tenantId })
    const previous = rows.filter(value => value.project_id === projectId && this.#sameScope(actor, value))
    const value: StudioDesignSpecRecord = {
      design_id: this.#createId(), project_id: projectId, org_id: actor.orgId, tenant_id: actor.tenantId,
      version: previous.length + 1, design_spec: designSpecV1Schema.parse(designSpec), sha256: designSpecHash(designSpec),
      created_by: actor.userId, created_at: this.#now().toISOString(),
    }
    if (this.#designSpecStore === undefined) await this.#repository.putDesign(value)
    else await putDesignSpec(this.#designSpecStore, value)
    return value
  }

  #authorize(actor: PromptToAppActor, permission: 'project.read' | 'project.write'): void {
    if (!roleAllows(actor.role, permission)) throw new PromptToAppError('FORBIDDEN', t('errors.forbidden'))
  }
  #sameScope(actor: PromptToAppActor, value: { org_id: string; tenant_id: string }): boolean { return value.org_id === actor.orgId && value.tenant_id === actor.tenantId }
  #assertOwned(actor: PromptToAppActor, value: { org_id: string; tenant_id: string }): void { if (!this.#sameScope(actor, value)) throw new PromptToAppError('FORBIDDEN', t('errors.crossTenant')) }
  async #approval(actor: PromptToAppActor, projectId: string, subject: StudioApproval['subject'], subjectId: string, tier: StudioApproval['tier'], strong: boolean, from: ProjectState | null = null, to: ProjectState | null = null) {
    const approval: StudioApproval = {
      approval_id: this.#createId(), project_id: projectId, org_id: actor.orgId, tenant_id: actor.tenantId,
      subject, subject_id: subjectId, approved_by: actor.userId, approved_at: this.#now().toISOString(), tier,
      strong_identity: strong, from_state: from, to_state: to,
    }
    await this.#repository.putApproval(approval)
  }
}

export function values<T>(table: { entries(): IterableIterator<[PromptToAppKey, T]> }): T[] { return [...table.entries()].map(([, value]) => value) }

function recoveryId(kind: 'run' | 'transition', project: Pick<StudioProject, 'org_id' | 'tenant_id' | 'project_id'>, operationId: string): string {
  const digest = createHash('sha256').update(JSON.stringify([kind, project.org_id, project.tenant_id, project.project_id, operationId])).digest('hex')
  return `recovery-${kind}-${digest}`
}

import { createHash, randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import type { RoutePrivacy } from '@dz23-studio/route-health'
import { appSpecHash, type AppSpecV1 } from './appspec.js'
import { generateAuthLayer, writeAuthLayer } from './auth-generator.js'
import { generateCrudLayer, writeCrudLayer } from './crud-generator.js'
import { generateDataLayer, writeDataLayer } from './data-generator.js'
import { generateDashboardLayer, writeDashboardLayer } from './dashboard-generator.js'
import { renderDesignTokens } from './design.js'
import { acceptanceChecks, parseAcceptanceReport, writeAcceptanceArtifacts, type AcceptanceCheck } from './acceptance.js'
import {
  acceptanceAttestation,
  canonicalDocument,
  manifestAttestation,
  provenanceAttestation,
  sbomAttestation,
  type AttestationDigests,
  type BuilderAttestationFacts,
  type ManifestEntry,
} from './attestation.js'
import { generatedFileSchema, writeGeneratedFiles, type GeneratedFile } from './generator.js'
import { generateFormLayer, writeFormLayer } from './form-generator.js'
import { generateSchedulingLayer, writeSchedulingLayer } from './scheduling-generator.js'
import { assertGeneratedSource } from './import-policy.js'
import { generateSaasLayer, writeSaasLayer } from './saas-generator.js'
import { t } from './i18n.js'
import { diffRunFiles, runReport, RUN_REPORT_FILE, type RunFileAuthor } from './run-report.js'
import { readResumeMarker, readResumedFiles, writeResumeMarker, type ResumeMarker } from './resume.js'
import type { StudioPlan, StudioRun, StudioRunStep } from './model.js'
import { assertCategoryCanGenerate } from './planner.js'
import type { PromptModelPort } from './ports.js'
import { BUILD_STEPS, BuilderLifecycleError, type BuilderLifecycleResolverPort, type BuilderLifecycleSession } from './builder-lifecycle.js'
import { listTreeFiles } from './runner.js'
import { scanGeneratedContent } from './security.js'
import { PromptToAppError, type PromptToAppActor, type PromptToAppService } from './service.js'
import type { EmergencyStopGuard } from './jobs.js'
import { canStartGeneration } from './state.js'

const generatedOutputSchema = z.object({ files: z.array(generatedFileSchema).min(1).max(80) }).strict()
const FRAMEWORK_GENERATED_MUTABLE_PATHS = new Set(['next-env.d.ts'])
export interface CodeGenerationResult { readonly files: readonly GeneratedFile[]; readonly route: string; readonly model: string; readonly inputTokens?: number; readonly outputTokens?: number }
export interface CodeGeneratorPort { generate(spec: AppSpecV1, plan: StudioPlan, diagnostic?: string): Promise<CodeGenerationResult> }

export class ModelCodeGenerator implements CodeGeneratorPort {
  constructor(private readonly model: PromptModelPort, private readonly actor: PromptToAppActor, private readonly privacy: RoutePrivacy) {}
  async generate(spec: AppSpecV1, plan: StudioPlan, diagnostic?: string): Promise<CodeGenerationResult> {
    const result = await this.model.complete({ orgId: this.actor.orgId, tenantId: this.actor.tenantId }, 'generate', this.privacy, [
      t('prompts.generateOnly'),
      t('prompts.generateDeclarative'),
      t('prompts.generatePaths'),
      t('prompts.generatePlanned'),
      t('prompts.generateSpec', { spec: JSON.stringify(spec) }), t('prompts.generatePlan', { plan: JSON.stringify(plan.slices) }),
      ...(diagnostic === undefined ? [] : [t('prompts.generateRepair', { diagnostic })]),
    ].join('\n'))
    const decoded = typeof result.value === 'string' ? JSON.parse(result.value) : result.value
    const output = generatedOutputSchema.parse(decoded)
    return { files: output.files, route: result.route, model: result.model, ...(result.usage === undefined ? {} : { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens }) }
  }
}

export interface PipelineOptions {
  readonly service: PromptToAppService
  readonly builder: BuilderLifecycleResolverPort<PromptToAppActor>
  readonly templateDirectory: string
  /**
   * A versão do template, para a proveniência dizer DE ONDE o artefato veio.
   *
   * Ausente vira `unversioned` no documento, e não uma versão inventada: um
   * número falso ali faria duas construções de templates diferentes parecerem
   * a mesma.
   */
  readonly templateVersion?: string
  readonly runsRoot: string
  /**
   * O teto de tokens de UMA criação, somando as três tentativas.
   *
   * O requisito E-05 pede geração "limitada por orçamento", e até aqui o único
   * teto era de TEMPO, por passo do construtor. Tempo não é o que a pessoa
   * paga: numa instalação com chave própria, três tentativas sobre uma
   * especificação grande gastam o que gastarem, e ninguém sabia quanto antes de
   * a conta chegar.
   *
   * O teto é conferido DEPOIS de cada geração e ANTES de começar a próxima
   * tentativa. Não dá para conferir antes da primeira: o custo de uma geração
   * só é conhecido quando ela responde. Então a primeira tentativa sempre corre
   * inteira, e o que o teto impede é a REPETIÇÃO cara — que é onde o gasto
   * multiplica.
   *
   * Ausente, não há teto, e isso é deliberado: um limite inventado por mim
   * cortaria a criação de quem não pediu limite nenhum.
   */
  readonly generationTokenBudget?: number
  readonly logoStoreRoot?: string
  readonly now?: () => Date
  readonly createId?: () => string
  /**
   * O botão de emergência, quando este perfil tem um.
   *
   * Fica aqui além de ficar no serviço de trabalhos porque o pipeline também é
   * chamado direto - por prova de runtime e por caminho interno - e uma parada
   * que só valesse na porta HTTP não seria uma parada.
   */
  readonly emergencyStop?: EmergencyStopGuard
}

export interface PipelineResult { readonly state: 'VERIFIED_PROTOTYPE' | 'BUILD_FAILED' | 'TESTS_FAILED' | 'BLOCKED_EXTERNAL' | 'BUDGET_EXCEEDED' | 'CANCELLED' | 'INTERRUPTED'; readonly runDirectory?: string; readonly attempts: number; readonly message: string }
export interface PipelineRunOptions { readonly operationId?: string; readonly ownerSessionId?: string; readonly signal?: AbortSignal }

export class PromptToAppPipeline {
  readonly #now: () => Date; readonly #createId: () => string
  constructor(private readonly options: PipelineOptions) { this.#now = options.now ?? (() => new Date()); this.#createId = options.createId ?? randomUUID }

  async run(actor: PromptToAppActor, projectId: string, generator: CodeGeneratorPort, runOptions: PipelineRunOptions = {}): Promise<PipelineResult> {
    // A primeira linha da execução, antes de ler projeto ou plano: começar a
    // trabalhar em um escopo parado e só descobrir isso depois seria trabalho
    // que a parada de emergência deveria ter impedido.
    this.options.emergencyStop?.assertRunning({ orgId: actor.orgId, tenantId: actor.tenantId })
    const project = this.options.service.project(actor, projectId)
    const plan = this.options.service.plan(actor, projectId)
    if (plan.status !== 'APPROVED' || !canStartGeneration(project.state)) {
      throw new PromptToAppError('INVALID', t('errors.planRequired'))
    }
    const operationId = opaqueOperationId(runOptions.operationId ?? this.#createId())
    const ownerSessionId = runOptions.ownerSessionId ?? actor.sessionId ?? 'direct-execution'
    const spec = this.options.service.latestSpec(actor, projectId).app_spec
    assertCategoryCanGenerate(project.category, spec)
    const specFindings = scanGeneratedContent({ 'appspec.json': JSON.stringify(spec) })
    if (specFindings.length > 0) throw new PromptToAppError('INVALID', t('errors.generatedSensitiveLiteral'))
    const design = this.options.service.designOrDefault(actor, projectId)
    const expectedAcceptanceChecks = acceptanceChecks(spec, project.category)
    await listTreeFiles(this.options.templateDirectory)
    await this.options.service.putRun(actor, this.runRecord(actor, projectId, plan.plan_id, 'generate', 1, 'PENDING', 'full', 'not-created', null, null, operationId, operationId, ownerSessionId))
    let activeAttempt = 1; let activeRunId = operationId; let activeRunDirectory = 'not-created'; let activeStage: StudioRun['stage'] = 'generate'
    try {
      if (isAborted(runOptions.signal)) return this.cancelled(actor, projectId, plan.plan_id, operationId, ownerSessionId, 0)
      let lifecycle: BuilderLifecycleSession
      try { lifecycle = await this.options.builder.forActor(actor) }
      catch (error) {
        const code = error instanceof BuilderLifecycleError ? error.code : 'BUILDER_SCOPE_UNAVAILABLE'
        await this.options.service.putRun(actor, this.runRecord(actor, projectId, plan.plan_id, 'build', 1, 'BLOCKED_EXTERNAL', 'unavailable', 'not-created', null, code, operationId, operationId, ownerSessionId))
        return { state: 'BLOCKED_EXTERNAL', attempts: 0, message: t('errors.builderUnavailable') }
      }
      const preflight = await lifecycle.preflight(runOptions.signal)
      activeStage = 'build'
      if (preflight.state !== 'OK') {
        await this.options.service.putRun(actor, this.runRecord(actor, projectId, plan.plan_id, 'build', 1, 'BLOCKED_EXTERNAL', 'unavailable', 'not-created', null, 'BUILDER_UNAVAILABLE', operationId, operationId, ownerSessionId))
        return { state: 'BLOCKED_EXTERNAL', attempts: 0, message: t('errors.builderUnavailable') }
      }
      await this.options.service.transition(actor, projectId, 'GENERATING')
      let diagnostic: string | undefined
      let finalFailureState: 'BUILD_FAILED' | 'TESTS_FAILED' = 'BUILD_FAILED'
      let stopRetries = false
      let completedAttempts = 0
      // Os tokens SOMADOS da operação, e não os da última tentativa. O gasto de
      // uma criação é o das três somadas, e é isso que o teto olha.
      let spentTokens = 0
    // O relato é montado com o que o pipeline JÁ sabe e hoje descarta: quem
    // escreveu cada arquivo, o que os controles recusaram, e o que a tentativa
    // anterior pediu para corrigir. Sem guardar isto, `kind: 'diff'` continuaria
    // sendo um valor de esquema que nenhum código produz.
    let attemptFiles: readonly { readonly path: string; readonly content: string; readonly author: RunFileAuthor }[] = []
    let previousAttemptFiles: readonly { readonly path: string; readonly content: string }[] = []
    let attemptFindings: readonly string[] = []
      // De onde retomar, quando houver de onde.
      //
      // SÓ para execução CANCELADA ou INTERROMPIDA. Uma execução que REPROVOU
      // ("Tentar novamente") tem de gerar de novo: o ponto da repetição é
      // corrigir o que não passou, e reaproveitar a geração reprovada
      // entregaria o mesmo defeito com outro nome.
      const resumable = project.state === 'CANCELLED' || project.state === 'INTERRUPTED'
        ? await this.findResumable(actor, projectId, plan.plan_id, appSpecHash(spec))
        : null
      let resumedFromRunId: string | null = null
      for (let attempt = 1; attempt <= 3; attempt++) {
      activeAttempt = attempt
      completedAttempts = attempt
      activeStage = 'generate'
      // O diagnóstico com que a tentativa COMEÇA é o que a anterior pediu para
      // corrigir. Capturado aqui porque `diagnostic` é zerado assim que a
      // geração dá certo.
      const previousDiagnosticForReport = diagnostic ?? null
      if (isAborted(runOptions.signal)) return this.cancelled(actor, projectId, plan.plan_id, operationId, ownerSessionId, attempt - 1)
      // O teto vale ANTES de começar a repetição, e não no meio dela: parar uma
      // tentativa pela metade gastaria os tokens dela e não entregaria nada.
      if (this.budgetExhausted(spentTokens)) {
        return await this.budgetExceeded(actor, projectId, plan.plan_id, operationId, ownerSessionId, attempt - 1, activeRunDirectory, spentTokens)
      }
      // Na retomada a tentativa continua NO MESMO diretório: é lá que estão os
      // arquivos que o modelo escreveu, e é isso que estamos aproveitando.
      const resuming = attempt === 1 && resumable !== null
      const runId = attempt === 1 ? operationId : opaqueOperationId(`${operationId}-attempt-${attempt}`)
      const runDirectory = resuming ? resumable.directory : resolve(this.options.runsRoot, runId)
      activeRunId = runId; activeRunDirectory = runDirectory
      if (!resuming) {
        await mkdir(this.options.runsRoot, { recursive: true }); await cp(this.options.templateDirectory, runDirectory, { recursive: true, errorOnExist: true })
      }
      const dataLayer = project.category === 'scheduling' || project.category === 'saas-authenticated' ? { files: [], protectedPaths: [] } : generateDataLayer(spec)
      const authLayer = generateAuthLayer(spec, project.category)
      const formLayer = generateFormLayer(spec, project.category)
      const crudLayer = generateCrudLayer(spec, project.category)
      const schedulingLayer = project.category === 'scheduling' ? generateSchedulingLayer(spec) : undefined
      const dashboardLayer = generateDashboardLayer(spec, project.category)
      const saasLayer = generateSaasLayer(spec, project.category)
      const frameworkFiles = [dataLayer, authLayer, formLayer, crudLayer, ...(schedulingLayer === undefined ? [] : [schedulingLayer]), dashboardLayer, saasLayer].flatMap(layer => layer.files)
      previousAttemptFiles = attemptFiles.map(file => ({ path: file.path, content: file.content }))
      attemptFiles = frameworkFiles.map(file => ({ path: file.path, content: file.content, author: 'studio' as const }))
      const frameworkFindings = scanGeneratedContent(Object.fromEntries(frameworkFiles.map(file => [file.path, file.content])))
      attemptFindings = frameworkFindings
      if (frameworkFindings.length > 0) {
        diagnostic = frameworkFindings.join('; '); finalFailureState = 'BUILD_FAILED'
        await this.recordFailure(actor, projectId, plan.plan_id, runId, runDirectory, attempt, null, diagnostic, 'verify', operationId, ownerSessionId)
        await this.writeRunReport({ actor, projectId, runId, directory: runDirectory, stage: 'verify', runState: 'FAILED', attempt, files: attemptFiles, previousFiles: previousAttemptFiles, findings: attemptFindings, correction: previousDiagnosticForReport })
        continue
      }
      // Na retomada NADA disto e reescrito: os arquivos ja estao la, e
      // `writeDesignAssets` grava com `flag: 'wx'` - reescrever explodiria.
      if (!resuming) {
        await writeDesignAssets(runDirectory, design, this.options.logoStoreRoot)
        await writeDataLayer(runDirectory, dataLayer)
        await writeAuthLayer(runDirectory, authLayer)
        await writeFormLayer(runDirectory, formLayer)
        await writeCrudLayer(runDirectory, crudLayer)
        if (schedulingLayer !== undefined) await writeSchedulingLayer(runDirectory, schedulingLayer)
        await writeDashboardLayer(runDirectory, dashboardLayer)
        await writeSaasLayer(runDirectory, saasLayer)
      }
      await this.options.service.putRun(actor, this.runRecord(actor, projectId, plan.plan_id, 'generate', attempt, 'RUNNING', 'full', runDirectory, null, null, runId, operationId, ownerSessionId))
      // Os caminhos protegidos e o hash vem do MARCO na retomada, e nao de um
      // novo `listTreeFiles`: agora o diretorio tambem tem o codigo gerado, e
      // recalcular aqui declararia esse codigo como parte do template
      // protegido - a conferencia de integridade passaria a proteger
      // justamente o que ela existe para vigiar.
      const protectedTemplatePaths = resuming ? resumable.marker.protected_paths : await listTreeFiles(runDirectory)
      const immutableBefore = resuming ? resumable.marker.immutable_before : await immutableHash(runDirectory, protectedTemplatePaths)
      const previousDiagnostic = diagnostic
      let generated: CodeGenerationResult
      try {
        if (resuming) {
          // O modelo NAO e chamado. Os tokens do marco entram no gasto porque
          // foram gastos de verdade - na execucao que a pessoa cancelou -, e o
          // teto por token existe para medir o custo da CRIACAO, nao o de uma
          // tentativa isolada.
          const marker = resumable.marker
          generated = { files: [], route: marker.route ?? 'retomada', model: marker.model ?? 'retomada', ...(marker.input_tokens === null ? {} : { inputTokens: marker.input_tokens }), ...(marker.output_tokens === null ? {} : { outputTokens: marker.output_tokens }) }
          spentTokens += (marker.input_tokens ?? 0) + (marker.output_tokens ?? 0)
          diagnostic = undefined
          resumedFromRunId = resumable.runId
        } else {
        generated = await generator.generate(spec, plan, previousDiagnostic)
        spentTokens += (generated.inputTokens ?? 0) + (generated.outputTokens ?? 0)
        diagnostic = undefined
        assertGeneratedSource(generated.files)
        await writeGeneratedFiles(runDirectory, generated.files, {
          plannedPaths: plan.slices.flatMap(slice => slice.planned_files),
          protectedTemplatePaths,
        })
        await writeAcceptanceArtifacts(runDirectory, spec, project.category)
        // O marco de "a geração desta tentativa está em disco". A partir daqui
        // um cancelamento não joga mais fora o trabalho do modelo.
        await writeResumeMarker(runDirectory, {
          plan_id: plan.plan_id, app_spec_sha256: appSpecHash(spec), attempt,
          route: generated.route ?? null, model: generated.model ?? null,
          input_tokens: generated.inputTokens ?? null, output_tokens: generated.outputTokens ?? null,
          protected_paths: [...protectedTemplatePaths], immutable_before: immutableBefore,
          files: [
            ...frameworkFiles.map(file => ({ path: file.path, author: 'studio' as const })),
            ...generated.files.map(file => ({ path: file.path, author: 'model' as const })),
          ],
          created_at: this.#now().toISOString(),
        })
        }
      } catch (error) {
        diagnostic = error instanceof Error ? error.message : 'GENERATED_OUTPUT_REJECTED'
        finalFailureState = 'BUILD_FAILED'
        await this.recordFailure(actor, projectId, plan.plan_id, runId, runDirectory, attempt, null, diagnostic, 'generate', operationId, ownerSessionId)
        await this.writeRunReport({ actor, projectId, runId, directory: runDirectory, stage: 'generate', runState: 'FAILED', attempt, files: attemptFiles, previousFiles: previousAttemptFiles, findings: attemptFindings, correction: previousDiagnosticForReport })
        continue
      }
      attemptFiles = resuming
        // Relidos do disco: o marco guarda caminho e autor, e o conteudo fica
        // onde o construtor vai compila-lo. Duplicar o aplicativo dentro do
        // marco deixaria duas copias que podem divergir.
        ? await readResumedFiles(runDirectory, resumable.marker)
        : [
          ...frameworkFiles.map(file => ({ path: file.path, content: file.content, author: 'studio' as const })),
          ...generated.files.map(file => ({ path: file.path, content: file.content, author: 'model' as const })),
        ]
      // Os controles rodam de novo NA RETOMADA tambem, sobre o conteudo relido
      // do disco. Confiar que "ja passou uma vez" abriria a porta para um
      // arquivo trocado entre o cancelamento e a retomada atravessar sem
      // conferencia - e o disco nao e um lugar mais confiavel que o modelo.
      const findings = scanGeneratedContent(Object.fromEntries(
        resuming ? attemptFiles.map(file => [file.path, file.content]) : [...frameworkFiles, ...generated.files].map(file => [file.path, file.content]),
      ))
      attemptFindings = findings
      if (findings.length > 0) {
        diagnostic = findings.join('; '); finalFailureState = 'BUILD_FAILED'
        await this.recordFailure(actor, projectId, plan.plan_id, runId, runDirectory, attempt, generated, diagnostic, 'verify', operationId, ownerSessionId)
        await this.writeRunReport({ actor, projectId, runId, directory: runDirectory, stage: 'verify', runState: 'FAILED', attempt, files: attemptFiles, previousFiles: previousAttemptFiles, findings: attemptFindings, correction: previousDiagnosticForReport })
        continue
      }
      let buildPassed = false; let testPassed = false; let log = ''; let failedStage: StudioRun['stage'] = 'build'
      // Os passos do construtor DESTA tentativa, gravados enquanto acontecem.
      // Sem isto a tela via `build` por vários minutos e não tinha como
      // distinguir "instalando" de "compilando" de "travado".
      let buildSteps: readonly StudioRunStep[] = []
      const closeStep = (state: 'PASSED' | 'FAILED'): void => {
        const last = buildSteps.at(-1)
        if (last === undefined || last.state !== 'RUNNING') return
        buildSteps = [...buildSteps.slice(0, -1), { ...last, state, finished_at: this.#now().toISOString() }]
      }
      let buildRef: string | undefined
      let finished: Awaited<ReturnType<BuilderLifecycleSession['finish']>> | undefined
      try {
        const prepared = await lifecycle.prepare(runDirectory, runId, runOptions.signal)
        buildRef = prepared.buildRef
        for (const step of BUILD_STEPS) {
          if (isAborted(runOptions.signal)) {
            await this.cancelLifecycle(lifecycle, buildRef)
            return this.cancelled(actor, projectId, plan.plan_id, operationId, ownerSessionId, attempt, runDirectory)
          }
          const stage: StudioRun['stage'] = step === 'test' || step === 'e2e' ? 'test' : 'build'
          activeStage = stage
          // O passo entra como RUNNING ANTES de começar, e o registro é gravado
          // já: quem está olhando a tela precisa ver o passo acender no momento
          // em que ele começa, não quando ele termina.
          buildSteps = [...buildSteps, { step, state: 'RUNNING', started_at: this.#now().toISOString(), finished_at: null }]
          await this.options.service.putRun(actor, this.runRecord(actor, projectId, plan.plan_id, stage, attempt, 'RUNNING', 'full', runDirectory, generated, null, runId, operationId, ownerSessionId, await readAcceptanceChecks(runDirectory, expectedAcceptanceChecks), null, undefined, undefined, buildSteps))
          let execution: Awaited<ReturnType<BuilderLifecycleSession['execute']>>
          try {
            execution = await lifecycle.execute(buildRef, step, runOptions.signal)
          } catch (error) {
            // Um passo que EXPLODE também terminou. Deixá-lo eternamente
            // RUNNING faria a tela mostrar uma bolinha girando para sempre num
            // passo que já acabou - a aparência exata de um travamento.
            closeStep('FAILED')
            throw error
          }
          const result = execution.result
          log += `[${step}]\n${result.stdout}\n${result.stderr}\n`
          const stepFailed = result.output_limit_exceeded || result.termination_reason === 'output_limit'
            || result.timed_out || result.exit_code !== 0 || execution.state === 'FAILED'
          closeStep(stepFailed ? 'FAILED' : 'PASSED')
          await this.options.service.putRun(actor, this.runRecord(actor, projectId, plan.plan_id, stage, attempt, 'RUNNING', 'full', runDirectory, generated, null, runId, operationId, ownerSessionId, await readAcceptanceChecks(runDirectory, expectedAcceptanceChecks), null, undefined, undefined, buildSteps))
          if (result.output_limit_exceeded || result.termination_reason === 'output_limit') {
            diagnostic = 'PROCESS_OUTPUT_LIMIT_EXCEEDED'; failedStage = buildPassed ? 'test' : 'build'; stopRetries = true; break
          }
          if (result.timed_out) { diagnostic = 'BUDGET_EXCEEDED'; failedStage = buildPassed ? 'test' : 'build'; break }
          if (result.exit_code !== 0 || execution.state === 'FAILED') { diagnostic = `${step}: exit ${result.exit_code}`; failedStage = buildPassed ? 'test' : 'build'; break }
          if (step === 'build' && execution.state === 'BUILD_OK') buildPassed = true
          if (step === 'e2e' && execution.state === 'E2E_OK') testPassed = true
        }
        if (isAborted(runOptions.signal)) {
          await this.cancelLifecycle(lifecycle, buildRef)
          return this.cancelled(actor, projectId, plan.plan_id, operationId, ownerSessionId, attempt, runDirectory)
        }
        activeStage = 'verify'
        finished = await lifecycle.finish(buildRef, AbortSignal.timeout(210_000))
      } catch (error) {
        if (buildRef !== undefined && isAborted(runOptions.signal)) {
          await this.cancelLifecycle(lifecycle, buildRef)
          return this.cancelled(actor, projectId, plan.plan_id, operationId, ownerSessionId, attempt, runDirectory)
        }
        if (buildRef !== undefined && finished === undefined) {
          try { finished = await lifecycle.finish(buildRef, AbortSignal.timeout(210_000)) }
          catch (finishError) { throw new BuilderLifecycleError('BLOCKED_EXTERNAL', 'FINISH_INCONCLUSIVE', { cause: finishError }) }
        }
        throw error
      }
      if (finished === undefined) throw new BuilderLifecycleError('BLOCKED_EXTERNAL', 'FINISH_INCONCLUSIVE')
      if (!finished.cleaned || finished.cleanupPending || (finished.finalState === 'E2E_OK') !== (finished.exported !== null)) {
        throw new BuilderLifecycleError('BLOCKED_EXTERNAL', 'FINISH_INCONCLUSIVE')
      }
      const verifiedAcceptanceChecks = await readAcceptanceChecks(runDirectory, expectedAcceptanceChecks)
      // O resultado desta conferência era CALCULADO e jogado fora quando batia:
      // o registro guardava só a reprovação. Sem gravar a aprovação também, não
      // dava para afirmar depois que a tentativa era um ponto seguro (E-08) -
      // apenas que ela não tinha reprovado, que é coisa diferente.
      let templateIntegrity: StudioRun['template_integrity']
      try {
        const immutableAfter = await immutableHash(runDirectory, protectedTemplatePaths)
        if (immutableAfter !== immutableBefore) { diagnostic = 'TEMPLATE_INTEGRITY_FAILED'; failedStage = 'verify'; templateIntegrity = 'FAILED' }
        else templateIntegrity = 'VERIFIED'
      } catch { diagnostic = 'TEMPLATE_INTEGRITY_FAILED'; failedStage = 'verify'; templateIntegrity = 'FAILED' }
      const lifecyclePassed = finished.finalState === 'E2E_OK' && finished.exported !== null && finished.cleaned && !finished.cleanupPending
      if (!lifecyclePassed && diagnostic === undefined) diagnostic = finished.finalState === 'CANCELLED' ? 'BUILDER_CANCELLED' : 'BUILDER_FAILED'
      // As atestações do artefato. Este é o ponto em que o caminho de SUCESSO
      // deixou de ser um beco sem saída: antes, um ciclo que passava lançava
      // `ACCEPTANCE_ATTESTATION_UNAVAILABLE` e levava embora
      // `VERIFIED_PROTOTYPE`, a prévia e o aviso à pessoa.
      //
      // A saída NÃO foi inventar uma atestação para acender o verde: os
      // documentos são derivados do que realmente aconteceu, e a sessão do
      // construtor tem de declarar com que imagem e sob que política construiu.
      // Sem essa declaração a execução continua BLOQUEADA, exatamente como
      // antes - o que mudou é que agora existe um caminho honesto para sair
      // dela.
      let attestations: AttestationDigests | undefined
      if (diagnostic === undefined && lifecyclePassed) {
        const facts = finished.attestation
        if (facts === undefined) {
          // Os passos ROBARAM mesmo assim, e a pessoa tem direito de ver o que
          // aconteceu: sair daqui sem gravar o relato era o que a deixava com
          // um código em inglês e nada mais.
          await writeFile(resolve(runDirectory, 'pipeline.log'), log, 'utf8')
          await this.writeRunReport({
            actor, projectId, runId, directory: runDirectory, stage: 'verify', runState: 'BLOCKED_EXTERNAL',
            attempt, files: attemptFiles, previousFiles: previousAttemptFiles, findings: attemptFindings,
            correction: previousDiagnosticForReport,
          })
          throw new BuilderLifecycleError('BLOCKED_EXTERNAL', 'ACCEPTANCE_ATTESTATION_UNAVAILABLE')
        }
        const attested = await this.attest({
          runId, projectId, planId: plan.plan_id, directory: runDirectory, attempt,
          artifactSha256: finished.exported!.sha256, templateIntegrity, builder: facts,
          checks: verifiedAcceptanceChecks, appSpecSha256: appSpecHash(spec),
          templateId: project.category, templateVersion: this.options.templateVersion ?? 'unversioned',
        })
        if (attested.verdict !== 'PASSED') {
          // A atestação reprovou o que o ciclo tinha aprovado. Isso NÃO vira
          // sucesso: o veredito da atestação é o que a pessoa vai mostrar a
          // alguém, e ele manda.
          diagnostic = 'ACCEPTANCE_ATTESTATION_FAILED'
          // `test`, e não `verify`: o que reprovou foram os CRITÉRIOS que a
          // pessoa escreveu, conferidos pela suíte do app. Marcar `verify`
          // levaria o projeto a BUILD_FAILED, e ela leria "não deu para
          // construir" de um app que construiu e não fez o que ela pediu.
          failedStage = 'test'
        } else {
          attestations = attested.digests
        }
        for (const file of attested.evidenceFiles) {
          await this.recordEvidence(actor, projectId, runId, runDirectory, file, 'test-report')
        }
      }
      const state = diagnostic === undefined && buildPassed && testPassed && lifecyclePassed ? 'PASSED' : diagnostic === 'BUDGET_EXCEEDED' ? 'BUDGET_EXCEEDED' : 'FAILED'
      if (state !== 'PASSED') finalFailureState = failedStage === 'test' ? 'TESTS_FAILED' : 'BUILD_FAILED'
      await writeFile(resolve(runDirectory, 'pipeline.log'), log, 'utf8')
      activeStage = 'verify'
      const artifactSha256 = state === 'PASSED' ? finished.exported!.sha256 : null
      await this.options.service.putRun(actor, this.runRecord(actor, projectId, plan.plan_id, state === 'PASSED' ? 'verify' : failedStage, attempt, state, 'full', runDirectory, generated, diagnostic ?? null, runId, operationId, ownerSessionId, verifiedAcceptanceChecks, artifactSha256, templateIntegrity, attestations, buildSteps, attempt === 1 ? resumedFromRunId : null))
      await this.recordEvidence(actor, projectId, runId, runDirectory, 'pipeline.log', 'build-log')
      await this.writeRunReport({ actor, projectId, runId, directory: runDirectory, stage: state === 'PASSED' ? 'verify' : failedStage, runState: state, attempt, files: attemptFiles, previousFiles: previousAttemptFiles, findings: attemptFindings, correction: previousDiagnosticForReport })
      if (state === 'PASSED') {
        await this.options.service.transition(actor, projectId, 'BUILD_OK'); await this.options.service.transition(actor, projectId, 'TESTS_OK'); await this.options.service.transition(actor, projectId, 'VERIFIED_PROTOTYPE')
        return { state: 'VERIFIED_PROTOTYPE', runDirectory, attempts: attempt, message: t('pipeline.verified') }
      }
      if (stopRetries) break
    }
      const current = this.options.service.project(actor, projectId)
      if (current.state === 'GENERATING') {
        if (finalFailureState === 'TESTS_FAILED') {
          await this.options.service.transition(actor, projectId, 'BUILD_OK')
          await this.options.service.transition(actor, projectId, 'TESTS_FAILED')
        } else await this.options.service.transition(actor, projectId, 'BUILD_FAILED')
      }
      return { state: finalFailureState, attempts: completedAttempts, message: diagnostic ?? t('pipeline.failed') }
    } catch (error) {
      return this.unexpectedFailure(actor, projectId, plan.plan_id, operationId, ownerSessionId, activeAttempt, activeRunId, activeRunDirectory, activeStage, error)
    }
  }

  /**
   * Escreve as quatro atestações do artefato ao lado da execução.
   *
   * Elas ficam em `evidence/` porque é ali que mora o que a pessoa (ou um
   * auditor) pode abrir depois. O registro da execução guarda só os RESUMOS: um
   * manifesto inteiro dentro do armazenamento por chave-valor cresceria sem
   * teto.
   * @param input - os fatos da execução verificada.
   * @returns o veredito, os resumos e os arquivos gravados.
   */
  private async attest(input: {
    readonly runId: string
    readonly projectId: string
    readonly planId: string
    readonly directory: string
    readonly attempt: number
    readonly artifactSha256: string
    readonly templateIntegrity: 'VERIFIED' | 'FAILED'
    readonly builder: BuilderAttestationFacts
    readonly checks: readonly AcceptanceCheck[]
    readonly appSpecSha256: string
    readonly templateId: string
    readonly templateVersion: string
  }): Promise<{
    readonly verdict: 'PASSED' | 'FAILED'
    readonly digests: AttestationDigests
    readonly evidenceFiles: readonly string[]
  }> {
    const attestedAt = this.#now().toISOString()
    const files = await manifestEntries(input.directory)
    const manifest = manifestAttestation({
      runId: input.runId, artifactSha256: input.artifactSha256, files, attestedAt,
    })
    const acceptance = acceptanceAttestation({
      runId: input.runId, projectId: input.projectId, artifactSha256: input.artifactSha256,
      templateIntegrity: input.templateIntegrity, builder: input.builder,
      checks: input.checks.map(check => ({ id: check.id, kind: check.kind, status: check.status })),
      lifecyclePassed: true, attestedAt,
    })
    const sbom = sbomAttestation({
      runId: input.runId, artifactSha256: input.artifactSha256, attestedAt,
      packageJson: await readJsonFile(resolve(input.directory, 'package.json')),
    })
    const provenance = provenanceAttestation({
      runId: input.runId, projectId: input.projectId, planId: input.planId,
      artifactSha256: input.artifactSha256, manifestSha256: manifest.sha256, builder: input.builder,
      appSpecSha256: input.appSpecSha256, templateId: input.templateId,
      templateVersion: input.templateVersion, templateIntegrity: input.templateIntegrity,
      attempt: input.attempt, attestedAt,
    })
    const written: string[] = []
    for (const [name, value] of [
      ['acceptance.json', acceptance.document],
      ['manifest.json', manifest.document],
      ['sbom.json', sbom.document],
      ['provenance.json', provenance.document],
    ] as const) {
      const relative = `evidence/attestation-${name}`
      await writeFile(resolve(input.directory, relative), `${canonicalDocument(value)}\n`, 'utf8')
      written.push(relative)
    }
    return {
      verdict: acceptance.document.verdict,
      digests: {
        acceptance_sha256: acceptance.sha256,
        manifest_sha256: manifest.sha256,
        sbom_sha256: sbom.sha256,
        provenance_sha256: provenance.sha256,
        builder_image_digest: input.builder.image_digest,
        policy_sha256: input.builder.policy_sha256,
      },
      evidenceFiles: written,
    }
  }

  private runRecord(actor: PromptToAppActor, projectId: string, planId: string, stage: StudioRun['stage'], attempt: number, state: StudioRun['state'], sandbox: StudioRun['sandbox'], runDirectory: string, generation: CodeGenerationResult | null, failure: string | null, runId = this.#createId(), operationId = runId, ownerSessionId = actor.sessionId ?? 'direct-execution', acceptanceChecks: readonly AcceptanceCheck[] = [], artifactSha256: string | null = null, templateIntegrity?: StudioRun['template_integrity'], attestations?: AttestationDigests, steps: readonly StudioRunStep[] = [], resumedFrom: string | null = null): StudioRun {
    const now = this.#now().toISOString()
    return { run_id: runId, operation_id: operationId, owner_session_id: ownerSessionId, plan_id: planId, project_id: projectId, org_id: actor.orgId, tenant_id: actor.tenantId, stage, attempt, state, started_at: now, finished_at: state === 'RUNNING' || state === 'PENDING' ? null : now, sandbox, route: generation?.route ?? null, model: generation?.model ?? null, input_tokens: generation?.inputTokens ?? null, output_tokens: generation?.outputTokens ?? null, estimated_cost_usd: null, run_directory: runDirectory || 'not-created', artifact_sha256: artifactSha256, ...(templateIntegrity === undefined ? {} : { template_integrity: templateIntegrity }), ...(attestations === undefined ? {} : { attestations }), ...(steps.length === 0 ? {} : { steps: steps.map(entry => ({ ...entry })) }), ...(resumedFrom === null ? {} : { resumed_from_run_id: resumedFrom }), failure_code: failure, acceptance_checks: [...acceptanceChecks] }
  }

  private async recordFailure(actor: PromptToAppActor, projectId: string, planId: string, runId: string, directory: string, attempt: number, generation: CodeGenerationResult | null, diagnostic: string, stage: StudioRun['stage'], operationId: string, ownerSessionId: string) {
    await writeFile(resolve(directory, 'pipeline.log'), diagnostic, 'utf8')
    await this.options.service.putRun(actor, this.runRecord(actor, projectId, planId, stage, attempt, 'FAILED', 'full', directory, generation, diagnostic, runId, operationId, ownerSessionId))
    await this.recordEvidence(actor, projectId, runId, directory, 'pipeline.log', 'security-scan')
  }


  /**
   * Grava o relato do que aconteceu, em português, ao lado da execução.
   *
   * Ele vira evidência do tipo `diff` - que até agora era um valor de esquema
   * que NENHUM código produzia. O arquivo é lido pela rota do relatório; a
   * tela nunca lê o `pipeline.log` cru.
   * @param input - o que o pipeline sabe sobre a tentativa.
   */
  private async writeRunReport(input: {
    readonly actor: PromptToAppActor
    readonly projectId: string
    readonly runId: string
    readonly directory: string
    readonly stage: StudioRun['stage']
    readonly runState: StudioRun['state']
    readonly attempt: number
    readonly files: readonly { readonly path: string; readonly content: string; readonly author: RunFileAuthor }[]
    readonly previousFiles: readonly { readonly path: string; readonly content: string }[]
    readonly findings: readonly string[]
    readonly correction: string | null
  }): Promise<void> {
    try {
      const log = await readFile(resolve(input.directory, 'pipeline.log'), 'utf8').catch(() => '')
      const report = runReport({
        stage: input.stage === 'generate' ? 'generate' : input.stage === 'build' ? 'build' : input.stage === 'test' ? 'test' : 'verify',
        runState: input.runState,
        attempt: input.attempt,
        log,
        files: diffRunFiles(input.files, input.previousFiles),
        findings: input.findings,
        correction: input.correction,
      })
      await writeFile(resolve(input.directory, RUN_REPORT_FILE), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
      await this.recordEvidence(input.actor, input.projectId, input.runId, input.directory, RUN_REPORT_FILE, 'diff')
    } catch {
      // O relato é para EXPLICAR o que aconteceu; falhar em explicar não pode
      // derrubar a execução que a pessoa está esperando. A ausência do arquivo
      // faz a rota responder que não há relato, que é a verdade.
    }
  }

  private async recordEvidence(actor: PromptToAppActor, projectId: string, runId: string, directory: string, filename: string, kind: 'build-log' | 'security-scan' | 'test-report' | 'diff') {
    const bytes = await readFile(resolve(directory, filename)); const id = this.#createId()
    await this.options.service.putEvidence(actor, { evidence_id: id, run_id: runId, project_id: projectId, org_id: actor.orgId, tenant_id: actor.tenantId, kind, sha256: createHash('sha256').update(bytes).digest('hex'), size_bytes: bytes.byteLength, relative_path: `${runId}/${filename}`, created_at: this.#now().toISOString() })
  }

  private async cancelLifecycle(lifecycle: BuilderLifecycleSession, buildRef: string): Promise<void> {
    const cancelSignal = AbortSignal.timeout(30_000)
    let cancelError: unknown
    try { await lifecycle.cancel(buildRef, cancelSignal) } catch (error) { cancelError = error }
    let finishError: unknown
    try {
      const finished = await lifecycle.finish(buildRef, AbortSignal.timeout(210_000))
      if (finished.finalState !== 'CANCELLED' || !finished.cleaned || finished.cleanupPending || finished.exported !== null) finishError = new Error('CANCEL_FINISH_INVALID')
    } catch (error) { finishError = error }
    if (cancelError !== undefined || finishError !== undefined) throw new BuilderLifecycleError('BLOCKED_EXTERNAL', 'CANCEL_FINISH_INCONCLUSIVE', { cause: finishError ?? cancelError })
  }

  private async unexpectedFailure(actor: PromptToAppActor, projectId: string, planId: string, operationId: string, ownerSessionId: string, attempt: number, runId: string, runDirectory: string, stage: StudioRun['stage'], error: unknown): Promise<PipelineResult> {
    const failure = pipelineFailureCode(error)
    const external = error instanceof BuilderLifecycleError && error.state === 'BLOCKED_EXTERNAL'
    const lifecycleInterrupted = error instanceof BuilderLifecycleError && (error.state === 'INTERRUPTED' || error.state === 'CANCELLED')
    const finalState: 'BUILD_FAILED' | 'TESTS_FAILED' | 'BLOCKED_EXTERNAL' | 'INTERRUPTED' = external ? 'BLOCKED_EXTERNAL' : lifecycleInterrupted ? 'INTERRUPTED' : failure.startsWith('APPSPEC_') || stage === 'test'
      ? 'TESTS_FAILED'
      : failure === 'ARTIFACT_MATERIALIZATION_FAILED' || stage === 'build' || stage === 'generate' ? 'BUILD_FAILED' : 'INTERRUPTED'
    if (runDirectory !== 'not-created') await writeFile(resolve(runDirectory, 'pipeline.log'), `${failure}\n`, 'utf8').catch(() => undefined)
    await this.options.service.putRun(actor, this.runRecord(actor, projectId, planId, finalState === 'TESTS_FAILED' ? 'test' : stage, attempt, finalState === 'BLOCKED_EXTERNAL' ? 'BLOCKED_EXTERNAL' : 'FAILED', finalState === 'BLOCKED_EXTERNAL' ? 'unavailable' : 'full', runDirectory, null, failure, runId, operationId, ownerSessionId))
    const current = this.options.service.project(actor, projectId)
    if (current.state === 'GENERATING') {
      if (finalState === 'TESTS_FAILED') {
        await this.options.service.transition(actor, projectId, 'BUILD_OK')
        await this.options.service.transition(actor, projectId, 'TESTS_FAILED')
      } else if (finalState === 'BUILD_FAILED') await this.options.service.transition(actor, projectId, 'BUILD_FAILED')
      else await this.options.service.transition(actor, projectId, 'INTERRUPTED')
    } else if (current.state === 'BUILD_OK' || current.state === 'TESTS_OK') {
      await this.options.service.transition(actor, projectId, 'INTERRUPTED')
    }
    return { state: finalState, attempts: attempt, message: finalState === 'INTERRUPTED' || finalState === 'BLOCKED_EXTERNAL' ? t('pipeline.interrupted') : t('pipeline.failed') }
  }

  /** O teto foi estourado? Sem teto configurado, nunca. */
  private budgetExhausted(spentTokens: number): boolean {
    const budget = this.options.generationTokenBudget
    return budget !== undefined && spentTokens >= budget
  }

  /**
   * A criação para porque o orçamento acabou — e a tela diz isso, não "falhou".
   *
   * `BUDGET_EXCEEDED` já existia como estado e já tinha frase própria na
   * interface, mas só era produzido pelo ESTOURO DE TEMPO de um passo do
   * construtor. Um teto de tokens que terminasse em `FAILED` mandaria a pessoa
   * procurar defeito no aplicativo dela por causa de uma decisão de orçamento.
   * @param spentTokens - o total somado, que vai no diagnóstico.
   */
  private async budgetExceeded(
    actor: PromptToAppActor, projectId: string, planId: string, operationId: string,
    ownerSessionId: string, attempts: number, runDirectory: string, spentTokens: number,
  ): Promise<PipelineResult> {
    const project = this.options.service.project(actor, projectId)
    if (project.state === 'GENERATING') await this.options.service.transition(actor, projectId, 'BUILD_FAILED')
    await this.options.service.putRun(actor, this.runRecord(
      actor, projectId, planId, 'generate', Math.max(1, attempts), 'BUDGET_EXCEEDED', 'full', runDirectory, null,
      `GENERATION_TOKEN_BUDGET_EXCEEDED tokens=${String(spentTokens)}`, operationId, operationId, ownerSessionId,
    ))
    return { state: 'BUDGET_EXCEEDED', attempts, message: t('pipeline.budgetExceeded') }
  }

  /**
   * A tentativa de onde dá para retomar, se houver uma.
   *
   * Percorre as execuções deste projeto da mais recente para a mais antiga e
   * devolve a primeira cujo diretório tem um marco de geração VÁLIDO para este
   * plano e esta especificação. Sem marco, sem retomada — e sem retomada a
   * execução gera de novo, exatamente como sempre fez.
   *
   * A ordem importa: retomar de uma tentativa velha entregaria um aplicativo
   * mais antigo do que o que a pessoa viu ser cancelado.
   * @param actor - quem está executando.
   * @param projectId - o projeto.
   * @param planId - o plano aprovado agora.
   * @param appSpecSha256 - o resumo da especificação de agora.
   * @returns o diretório, a execução de origem e o marco, ou `null`.
   */
  private async findResumable(actor: PromptToAppActor, projectId: string, planId: string, appSpecSha256: string): Promise<{ readonly directory: string; readonly runId: string; readonly marker: ResumeMarker } | null> {
    let runs: readonly StudioRun[]
    try { runs = this.options.service.runs(actor, projectId) } catch { return null }
    const ordered = [...runs].sort((left, right) => right.started_at.localeCompare(left.started_at) || right.attempt - left.attempt)
    for (const run of ordered) {
      if (run.run_directory === 'not-created' || run.run_directory === '') continue
      const marker = await readResumeMarker(run.run_directory, { planId, appSpecSha256 })
      if (marker !== null) return { directory: run.run_directory, runId: run.run_id, marker }
    }
    return null
  }

  private async cancelled(actor: PromptToAppActor, projectId: string, planId: string, operationId: string, ownerSessionId: string, attempts: number, runDirectory = 'not-created'): Promise<PipelineResult> {
    const project = this.options.service.project(actor, projectId)
    if (project.state === 'GENERATING') await this.options.service.transition(actor, projectId, 'CANCELLED')
    await this.options.service.putRun(actor, this.runRecord(actor, projectId, planId, 'verify', Math.max(1, attempts), 'CANCELLED', 'full', runDirectory, null, 'CANCELLED_BY_USER', operationId, operationId, ownerSessionId))
    return { state: 'CANCELLED', attempts, message: t('pipeline.cancelled') }
  }
}

export async function writeDesignAssets(runDirectory: string, design: ReturnType<PromptToAppService['designOrDefault']>, logoStoreRoot?: string): Promise<void> {
  await mkdir(resolve(runDirectory, 'src', 'styles'), { recursive: true })
  await writeFile(resolve(runDirectory, 'src', 'styles', 'tokens.css'), renderDesignTokens(design), { encoding: 'utf8', flag: 'wx' })
  if (design.logo === null) return
  if (logoStoreRoot === undefined) throw new Error('LOGO_STORE_NOT_CONFIGURED')
  const bytes = await readFile(resolve(logoStoreRoot, design.logo.relative_path))
  if (createHash('sha256').update(bytes).digest('hex') !== design.logo.sha256) throw new Error('LOGO_INTEGRITY_FAILED')
  await mkdir(resolve(runDirectory, 'public', 'brand'), { recursive: true })
  await writeFile(resolve(runDirectory, 'public', 'brand', 'logo.png'), bytes, { flag: 'wx' })
}

async function immutableHash(root: string, files: readonly string[]): Promise<string> {
  const hash = createHash('sha256')
  for (const file of [...files].sort()) {
    if (FRAMEWORK_GENERATED_MUTABLE_PATHS.has(file)) continue
    hash.update(file).update('\0').update(await readFile(resolve(root, file))).update('\0')
  }
  return hash.digest('hex')
}

async function readAcceptanceChecks(runDirectory: string, expected: readonly AcceptanceCheck[]): Promise<readonly AcceptanceCheck[]> {
  const path = resolve(runDirectory, 'evidence', 'appspec-report.json')
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('APPSPEC_REPORT_INVALID')
    if (info.size > 1024 * 1024) throw new Error('APPSPEC_REPORT_TOO_LARGE')
    return parseAcceptanceReport(JSON.parse(await readFile(path, 'utf8')), expected)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('APPSPEC_')) throw error
    throw new Error('APPSPEC_REPORT_INVALID')
  }
}

function isAborted(signal: AbortSignal | undefined): boolean { return signal?.aborted === true }

function opaqueOperationId(value: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 96 || !/^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?$/u.test(value)) {
    throw new PromptToAppError('INVALID', 'INVALID_OPERATION_ID')
  }
  return value
}

function pipelineFailureCode(error: unknown): string {
  if (error instanceof BuilderLifecycleError) return error.code
  const message = error instanceof Error ? error.message : ''
  if (message.startsWith('APPSPEC_')) return message
  if (message.startsWith('PREVIEW_ARTIFACT_')) return 'ARTIFACT_MATERIALIZATION_FAILED'
  return 'PIPELINE_UNEXPECTED_FAILURE'
}


/**
 * Os arquivos do artefato, com o conteúdo resumido.
 *
 * `node_modules` e `.git` ficam de fora: o manifesto descreve o que o Studio
 * GEROU, e uma árvore de dependências instalada tornaria o documento gigante
 * sem dizer nada que o SBOM já não diga melhor.
 * @param root - o diretório da execução.
 * @returns uma entrada por arquivo, em caminho relativo com barras normais.
 */
async function manifestEntries(root: string): Promise<readonly ManifestEntry[]> {
  const entries: ManifestEntry[] = []
  for (const relative of await listTreeFiles(root)) {
    const content = await readFile(resolve(root, relative))
    entries.push({
      path: relative.replaceAll('\\\\', '/'),
      sha256: createHash('sha256').update(content).digest('hex'),
      bytes: content.byteLength,
    })
  }
  return entries
}

/**
 * Lê um JSON do disco, devolvendo `undefined` quando ele não existe ou não é
 * legível. Quem chama decide o que a ausência significa - aqui ela nunca vira
 * um objeto vazio que se pareça com uma resposta.
 * @param path - o caminho do arquivo.
 * @returns o valor lido, ou `undefined`.
 */
async function readJsonFile(path: string): Promise<unknown> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) return undefined
    return JSON.parse(await readFile(path, 'utf8'))
  } catch { return undefined }
}

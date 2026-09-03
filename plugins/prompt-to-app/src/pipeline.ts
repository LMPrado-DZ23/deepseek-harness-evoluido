import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import type { AppSpecV1 } from './appspec.js'
import { writeAcceptanceArtifacts, type AcceptanceCheck } from './acceptance.js'
import { generatedFileSchema, writeGeneratedFiles, type GeneratedFile } from './generator.js'
import { t } from './i18n.js'
import type { StudioPlan, StudioRun } from './model.js'
import type { PromptModelPort } from './ports.js'
import { ContainerBuilder, listTreeFiles, OFFLINE_PIPELINE_COMMANDS } from './runner.js'
import { scanGeneratedContent } from './security.js'
import { PromptToAppError, type PromptToAppActor, type PromptToAppService } from './service.js'

const generatedOutputSchema = z.object({ files: z.array(generatedFileSchema).min(1).max(80) }).strict()
export interface CodeGenerationResult { readonly files: readonly GeneratedFile[]; readonly route: string; readonly model: string; readonly inputTokens?: number; readonly outputTokens?: number }
export interface CodeGeneratorPort { generate(spec: AppSpecV1, plan: StudioPlan, diagnostic?: string): Promise<CodeGenerationResult> }

export class ModelCodeGenerator implements CodeGeneratorPort {
  constructor(private readonly model: PromptModelPort, private readonly actor: PromptToAppActor, private readonly privacy: 'local-only' | 'any') {}
  async generate(spec: AppSpecV1, plan: StudioPlan, diagnostic?: string): Promise<CodeGenerationResult> {
    const result = await this.model.complete({ orgId: this.actor.orgId, tenantId: this.actor.tenantId }, 'generate', this.privacy, [
      t('prompts.generateOnly'),
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
  readonly builder: ContainerBuilder
  readonly templateDirectory: string
  readonly runsRoot: string
  readonly now?: () => Date
  readonly createId?: () => string
}

export interface PipelineResult { readonly state: 'VERIFIED_PROTOTYPE' | 'BUILD_FAILED' | 'TESTS_FAILED' | 'BLOCKED_EXTERNAL' | 'CANCELLED'; readonly runDirectory?: string; readonly attempts: number; readonly message: string }
export interface PipelineRunOptions { readonly operationId?: string; readonly ownerSessionId?: string; readonly signal?: AbortSignal }

export class PromptToAppPipeline {
  readonly #now: () => Date; readonly #createId: () => string
  constructor(private readonly options: PipelineOptions) { this.#now = options.now ?? (() => new Date()); this.#createId = options.createId ?? randomUUID }

  async run(actor: PromptToAppActor, projectId: string, generator: CodeGeneratorPort, runOptions: PipelineRunOptions = {}): Promise<PipelineResult> {
    const project = this.options.service.project(actor, projectId)
    const plan = this.options.service.plan(actor, projectId)
    if (plan.status !== 'APPROVED' || project.state !== 'PLAN_APPROVED') {
      throw new PromptToAppError('INVALID', t('errors.planRequired'))
    }
    const operationId = runOptions.operationId ?? this.#createId()
    const ownerSessionId = runOptions.ownerSessionId ?? actor.sessionId ?? 'direct-execution'
    const spec = this.options.service.latestSpec(actor, projectId).app_spec
    await this.options.service.putRun(actor, this.runRecord(actor, projectId, plan.plan_id, 'generate', 1, 'PENDING', 'full', 'not-created', null, null, operationId, operationId, ownerSessionId))
    if (isAborted(runOptions.signal)) return this.cancelled(actor, projectId, plan.plan_id, operationId, ownerSessionId, 0)
    const preflight = await this.options.builder.preflight()
    if (preflight.state !== 'OK') {
      await this.options.service.putRun(actor, this.runRecord(actor, projectId, plan.plan_id, 'build', 1, 'BLOCKED_EXTERNAL', 'unavailable', 'not-created', null, 'BUILDER_UNAVAILABLE', operationId, operationId, ownerSessionId))
      return { state: 'BLOCKED_EXTERNAL', attempts: 0, message: preflight.message }
    }
    await this.options.service.transition(actor, projectId, 'GENERATING')
    let diagnostic: string | undefined
    let finalFailureState: 'BUILD_FAILED' | 'TESTS_FAILED' = 'BUILD_FAILED'
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (isAborted(runOptions.signal)) return this.cancelled(actor, projectId, plan.plan_id, operationId, ownerSessionId, attempt - 1)
      const runId = attempt === 1 ? operationId : `${operationId}-attempt-${attempt}`; const runDirectory = resolve(this.options.runsRoot, runId)
      await mkdir(this.options.runsRoot, { recursive: true }); await cp(this.options.templateDirectory, runDirectory, { recursive: true, errorOnExist: true })
      await mkdir(resolve(runDirectory, 'src', 'generated'), { recursive: true })
      await writeFile(resolve(runDirectory, 'src', 'generated', 'design-tokens.css'), defaultDesignTokens(), { encoding: 'utf8', flag: 'wx' })
      await this.options.service.putRun(actor, this.runRecord(actor, projectId, plan.plan_id, 'generate', attempt, 'RUNNING', 'full', runDirectory, null, null, runId, operationId, ownerSessionId))
      const protectedTemplatePaths = await listTreeFiles(runDirectory)
      const immutableBefore = await immutableHash(runDirectory, protectedTemplatePaths)
      const previousDiagnostic = diagnostic
      let generated: CodeGenerationResult
      try {
        generated = await generator.generate(spec, plan, previousDiagnostic)
        diagnostic = undefined
        await writeGeneratedFiles(runDirectory, generated.files, {
          plannedPaths: plan.slices.flatMap(slice => slice.planned_files),
          protectedTemplatePaths,
        })
        await writeAcceptanceArtifacts(runDirectory, spec)
      } catch (error) {
        diagnostic = error instanceof Error ? error.message : 'GENERATED_OUTPUT_REJECTED'
        finalFailureState = 'BUILD_FAILED'
        await this.recordFailure(actor, projectId, plan.plan_id, runId, runDirectory, attempt, null, diagnostic, 'generate', operationId, ownerSessionId)
        continue
      }
      const findings = scanGeneratedContent(Object.fromEntries(generated.files.map(file => [file.path, file.content])))
      if (findings.length > 0) {
        diagnostic = findings.join('; '); finalFailureState = 'BUILD_FAILED'
        await this.recordFailure(actor, projectId, plan.plan_id, runId, runDirectory, attempt, generated, diagnostic, 'verify', operationId, ownerSessionId)
        continue
      }
      let buildPassed = false; let testPassed = false; let log = ''; let failedStage: StudioRun['stage'] = 'build'
      for (const command of OFFLINE_PIPELINE_COMMANDS) {
        if (isAborted(runOptions.signal)) return this.cancelled(actor, projectId, plan.plan_id, operationId, ownerSessionId, attempt, runDirectory)
        const stage: StudioRun['stage'] = command === 'pnpm run test' || command === 'pnpm run test:e2e' ? 'test' : 'build'
        await this.options.service.putRun(actor, this.runRecord(actor, projectId, plan.plan_id, stage, attempt, 'RUNNING', 'full', runDirectory, generated, null, runId, operationId, ownerSessionId, await readAcceptanceChecks(runDirectory)))
        const result = await this.options.builder.execute(runDirectory, command)
        log += `$ ${command}\n${result.stdout}\n${result.stderr}\n`
        if (result.timedOut) { diagnostic = 'BUDGET_EXCEEDED'; failedStage = buildPassed ? 'test' : 'build'; break }
        if (result.exitCode !== 0) { diagnostic = `${command}: exit ${result.exitCode}`; failedStage = buildPassed ? 'test' : 'build'; break }
        if (command === 'pnpm run build') buildPassed = true
        if (command === 'pnpm run test:e2e') testPassed = true
      }
      if (isAborted(runOptions.signal)) return this.cancelled(actor, projectId, plan.plan_id, operationId, ownerSessionId, attempt, runDirectory)
      const acceptanceChecks = await readAcceptanceChecks(runDirectory)
      if (diagnostic === undefined && acceptanceChecks.some(check => check.status !== 'PASSED' && check.status !== 'NOT_AUTOMATED')) {
        diagnostic = 'APPSPEC_ACCEPTANCE_INCOMPLETE'; failedStage = 'test'; testPassed = false
      }
      try {
        const immutableAfter = await immutableHash(runDirectory, protectedTemplatePaths)
        if (immutableAfter !== immutableBefore) { diagnostic = 'TEMPLATE_INTEGRITY_FAILED'; failedStage = 'verify' }
      } catch { diagnostic = 'TEMPLATE_INTEGRITY_FAILED'; failedStage = 'verify' }
      const state = diagnostic === undefined && buildPassed && testPassed ? 'PASSED' : diagnostic === 'BUDGET_EXCEEDED' ? 'BUDGET_EXCEEDED' : 'FAILED'
      if (state !== 'PASSED') finalFailureState = failedStage === 'test' ? 'TESTS_FAILED' : 'BUILD_FAILED'
      await writeFile(resolve(runDirectory, 'pipeline.log'), log, 'utf8')
      await this.options.service.putRun(actor, this.runRecord(actor, projectId, plan.plan_id, state === 'PASSED' ? 'verify' : failedStage, attempt, state, 'full', runDirectory, generated, diagnostic ?? null, runId, operationId, ownerSessionId, acceptanceChecks))
      await this.recordEvidence(actor, projectId, runId, runDirectory, 'pipeline.log', 'build-log')
      await this.recordEvidence(actor, projectId, runId, runDirectory, 'evidence/appspec-report.json', 'test-report')
      if (state === 'PASSED') {
        await this.options.service.transition(actor, projectId, 'BUILD_OK'); await this.options.service.transition(actor, projectId, 'TESTS_OK'); await this.options.service.transition(actor, projectId, 'VERIFIED_PROTOTYPE')
        return { state: 'VERIFIED_PROTOTYPE', runDirectory, attempts: attempt, message: t('pipeline.verified') }
      }
    }
    const current = this.options.service.project(actor, projectId)
    if (current.state === 'GENERATING') {
      if (finalFailureState === 'TESTS_FAILED') {
        await this.options.service.transition(actor, projectId, 'BUILD_OK')
        await this.options.service.transition(actor, projectId, 'TESTS_FAILED')
      } else await this.options.service.transition(actor, projectId, 'BUILD_FAILED')
    }
    return { state: finalFailureState, attempts: 3, message: diagnostic ?? t('pipeline.failed') }
  }

  private runRecord(actor: PromptToAppActor, projectId: string, planId: string, stage: StudioRun['stage'], attempt: number, state: StudioRun['state'], sandbox: StudioRun['sandbox'], runDirectory: string, generation: CodeGenerationResult | null, failure: string | null, runId = this.#createId(), operationId = runId, ownerSessionId = actor.sessionId ?? 'direct-execution', acceptanceChecks: readonly AcceptanceCheck[] = []): StudioRun {
    const now = this.#now().toISOString()
    return { run_id: runId, operation_id: operationId, owner_session_id: ownerSessionId, plan_id: planId, project_id: projectId, org_id: actor.orgId, tenant_id: actor.tenantId, stage, attempt, state, started_at: now, finished_at: state === 'RUNNING' || state === 'PENDING' ? null : now, sandbox, route: generation?.route ?? null, model: generation?.model ?? null, input_tokens: generation?.inputTokens ?? null, output_tokens: generation?.outputTokens ?? null, estimated_cost_usd: null, run_directory: runDirectory || 'not-created', failure_code: failure, acceptance_checks: [...acceptanceChecks] }
  }

  private async recordFailure(actor: PromptToAppActor, projectId: string, planId: string, runId: string, directory: string, attempt: number, generation: CodeGenerationResult | null, diagnostic: string, stage: StudioRun['stage'], operationId: string, ownerSessionId: string) {
    await writeFile(resolve(directory, 'pipeline.log'), diagnostic, 'utf8')
    await this.options.service.putRun(actor, this.runRecord(actor, projectId, planId, stage, attempt, 'FAILED', 'full', directory, generation, diagnostic, runId, operationId, ownerSessionId))
    await this.recordEvidence(actor, projectId, runId, directory, 'pipeline.log', 'security-scan')
  }

  private async recordEvidence(actor: PromptToAppActor, projectId: string, runId: string, directory: string, filename: string, kind: 'build-log' | 'security-scan' | 'test-report') {
    const bytes = await readFile(resolve(directory, filename)); const id = this.#createId()
    await this.options.service.putEvidence(actor, { evidence_id: id, run_id: runId, project_id: projectId, org_id: actor.orgId, tenant_id: actor.tenantId, kind, sha256: createHash('sha256').update(bytes).digest('hex'), size_bytes: bytes.byteLength, relative_path: `${runId}/${filename}`, created_at: this.#now().toISOString() })
  }

  private async cancelled(actor: PromptToAppActor, projectId: string, planId: string, operationId: string, ownerSessionId: string, attempts: number, runDirectory = 'not-created'): Promise<PipelineResult> {
    const project = this.options.service.project(actor, projectId)
    if (project.state === 'GENERATING') await this.options.service.transition(actor, projectId, 'CANCELLED')
    await this.options.service.putRun(actor, this.runRecord(actor, projectId, planId, 'verify', Math.max(1, attempts), 'CANCELLED', 'full', runDirectory, null, 'CANCELLED_BY_USER', operationId, operationId, ownerSessionId))
    return { state: 'CANCELLED', attempts, message: t('pipeline.cancelled') }
  }
}

async function immutableHash(root: string, files: readonly string[]): Promise<string> {
  const hash = createHash('sha256')
  for (const file of [...files].sort()) hash.update(file).update('\0').update(await readFile(resolve(root, file))).update('\0')
  return hash.digest('hex')
}

async function readAcceptanceChecks(runDirectory: string): Promise<readonly AcceptanceCheck[]> {
  try {
    const report = JSON.parse(await readFile(resolve(runDirectory, 'evidence', 'appspec-report.json'), 'utf8')) as { checks?: AcceptanceCheck[] }
    return report.checks ?? []
  } catch { return [] }
}

function isAborted(signal: AbortSignal | undefined): boolean { return signal?.aborted === true }

function defaultDesignTokens(): string {
  return `:root {
  --background: 0 0% 100%;
  --foreground: 222 47% 11%;
  --card: 0 0% 100%;
  --card-foreground: 222 47% 11%;
  --primary: 222 72% 32%;
  --primary-foreground: 0 0% 100%;
  --secondary: 214 32% 91%;
  --secondary-foreground: 222 47% 11%;
  --muted: 210 40% 96%;
  --muted-foreground: 215 16% 40%;
  --accent: 214 100% 93%;
  --accent-foreground: 222 72% 26%;
  --destructive: 0 72% 45%;
  --border: 214 32% 88%;
  --input: 214 32% 88%;
  --ring: 217 91% 50%;
  --radius: 0.75rem;
}
`
}

import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import type { AppSpecV1 } from './appspec.js'
import { generatedFileSchema, writeGeneratedFiles, type GeneratedFile } from './generator.js'
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
      'Produza somente JSON com files[].path e files[].content.',
      'Caminhos permitidos: src/ e content/. Não gere configuração, dependências ou scripts.',
      'Gere somente arquivos presentes em planned_files. Não tente alterar arquivos do template.',
      `AppSpec: ${JSON.stringify(spec)}`, `Plano: ${JSON.stringify(plan.slices)}`,
      ...(diagnostic === undefined ? [] : [`A tentativa anterior falhou. Corrija somente a causa: ${diagnostic}`]),
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

export interface PipelineResult { readonly state: 'VERIFIED_PROTOTYPE' | 'BUILD_FAILED' | 'TESTS_FAILED' | 'BLOCKED_EXTERNAL'; readonly runDirectory?: string; readonly attempts: number; readonly message: string }

export class PromptToAppPipeline {
  readonly #now: () => Date; readonly #createId: () => string
  constructor(private readonly options: PipelineOptions) { this.#now = options.now ?? (() => new Date()); this.#createId = options.createId ?? randomUUID }

  async run(actor: PromptToAppActor, projectId: string, generator: CodeGeneratorPort): Promise<PipelineResult> {
    const project = this.options.service.project(actor, projectId)
    const plan = this.options.service.plan(actor, projectId)
    if (plan.status !== 'APPROVED' || project.state !== 'PLAN_APPROVED') {
      throw new PromptToAppError('INVALID', 'A criação só começa depois que você aprovar o plano.')
    }
    const spec = this.options.service.latestSpec(actor, projectId).app_spec
    const preflight = await this.options.builder.preflight()
    if (preflight.state !== 'OK') {
      await this.options.service.putRun(actor, this.runRecord(actor, projectId, plan.plan_id, 'build', 1, 'BLOCKED_EXTERNAL', 'unavailable', '', null, 'BUILDER_UNAVAILABLE'))
      return { state: 'BLOCKED_EXTERNAL', attempts: 0, message: preflight.message }
    }
    await this.options.service.transition(actor, projectId, 'GENERATING')
    let diagnostic: string | undefined
    let finalFailureState: 'BUILD_FAILED' | 'TESTS_FAILED' = 'BUILD_FAILED'
    for (let attempt = 1; attempt <= 3; attempt++) {
      const runId = this.#createId(); const runDirectory = resolve(this.options.runsRoot, runId)
      await mkdir(this.options.runsRoot, { recursive: true }); await cp(this.options.templateDirectory, runDirectory, { recursive: true, errorOnExist: true })
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
      } catch (error) {
        diagnostic = error instanceof Error ? error.message : 'GENERATED_OUTPUT_REJECTED'
        finalFailureState = 'BUILD_FAILED'
        await this.recordFailure(actor, projectId, plan.plan_id, runId, runDirectory, attempt, null, diagnostic, 'generate')
        continue
      }
      const findings = scanGeneratedContent(Object.fromEntries(generated.files.map(file => [file.path, file.content])))
      if (findings.length > 0) {
        diagnostic = findings.join('; '); finalFailureState = 'BUILD_FAILED'
        await this.recordFailure(actor, projectId, plan.plan_id, runId, runDirectory, attempt, generated, diagnostic, 'verify')
        continue
      }
      let buildPassed = false; let testPassed = false; let log = ''; let failedStage: StudioRun['stage'] = 'build'
      for (const command of OFFLINE_PIPELINE_COMMANDS) {
        const result = await this.options.builder.execute(runDirectory, command)
        log += `$ ${command}\n${result.stdout}\n${result.stderr}\n`
        if (result.timedOut) { diagnostic = 'BUDGET_EXCEEDED'; failedStage = buildPassed ? 'test' : 'build'; break }
        if (result.exitCode !== 0) { diagnostic = `${command}: exit ${result.exitCode}`; failedStage = buildPassed ? 'test' : 'build'; break }
        if (command === 'pnpm run build') buildPassed = true
        if (command === 'pnpm run test:e2e') testPassed = true
      }
      try {
        const immutableAfter = await immutableHash(runDirectory, protectedTemplatePaths)
        if (immutableAfter !== immutableBefore) { diagnostic = 'TEMPLATE_INTEGRITY_FAILED'; failedStage = 'verify' }
      } catch { diagnostic = 'TEMPLATE_INTEGRITY_FAILED'; failedStage = 'verify' }
      const state = diagnostic === undefined && buildPassed && testPassed ? 'PASSED' : diagnostic === 'BUDGET_EXCEEDED' ? 'BUDGET_EXCEEDED' : 'FAILED'
      if (state !== 'PASSED') finalFailureState = failedStage === 'test' ? 'TESTS_FAILED' : 'BUILD_FAILED'
      await writeFile(resolve(runDirectory, 'pipeline.log'), log, 'utf8')
      await this.options.service.putRun(actor, this.runRecord(actor, projectId, plan.plan_id, state === 'PASSED' ? 'verify' : failedStage, attempt, state, 'full', runDirectory, generated, diagnostic ?? null, runId))
      await this.recordEvidence(actor, projectId, runId, runDirectory, 'pipeline.log', 'build-log')
      if (state === 'PASSED') {
        await this.options.service.transition(actor, projectId, 'BUILD_OK'); await this.options.service.transition(actor, projectId, 'TESTS_OK'); await this.options.service.transition(actor, projectId, 'VERIFIED_PROTOTYPE')
        return { state: 'VERIFIED_PROTOTYPE', runDirectory, attempts: attempt, message: 'Protótipo verificado — não está publicado nem disponível para outras pessoas' }
      }
    }
    const current = this.options.service.project(actor, projectId)
    if (current.state === 'GENERATING') {
      if (finalFailureState === 'TESTS_FAILED') {
        await this.options.service.transition(actor, projectId, 'BUILD_OK')
        await this.options.service.transition(actor, projectId, 'TESTS_FAILED')
      } else await this.options.service.transition(actor, projectId, 'BUILD_FAILED')
    }
    return { state: finalFailureState, attempts: 3, message: diagnostic ?? 'A verificação não foi concluída.' }
  }

  private runRecord(actor: PromptToAppActor, projectId: string, planId: string, stage: StudioRun['stage'], attempt: number, state: StudioRun['state'], sandbox: StudioRun['sandbox'], runDirectory: string, generation: CodeGenerationResult | null, failure: string | null, runId = this.#createId()): StudioRun {
    const now = this.#now().toISOString()
    return { run_id: runId, plan_id: planId, project_id: projectId, org_id: actor.orgId, tenant_id: actor.tenantId, stage, attempt, state, started_at: now, finished_at: state === 'RUNNING' ? null : now, sandbox, route: generation?.route ?? null, model: generation?.model ?? null, input_tokens: generation?.inputTokens ?? null, output_tokens: generation?.outputTokens ?? null, estimated_cost_usd: null, run_directory: runDirectory || 'not-created', failure_code: failure }
  }

  private async recordFailure(actor: PromptToAppActor, projectId: string, planId: string, runId: string, directory: string, attempt: number, generation: CodeGenerationResult | null, diagnostic: string, stage: StudioRun['stage']) {
    await writeFile(resolve(directory, 'pipeline.log'), diagnostic, 'utf8')
    await this.options.service.putRun(actor, this.runRecord(actor, projectId, planId, stage, attempt, 'FAILED', 'full', directory, generation, diagnostic, runId))
    await this.recordEvidence(actor, projectId, runId, directory, 'pipeline.log', 'security-scan')
  }

  private async recordEvidence(actor: PromptToAppActor, projectId: string, runId: string, directory: string, filename: string, kind: 'build-log' | 'security-scan') {
    const bytes = await readFile(resolve(directory, filename)); const id = this.#createId()
    await this.options.service.putEvidence(actor, { evidence_id: id, run_id: runId, project_id: projectId, org_id: actor.orgId, tenant_id: actor.tenantId, kind, sha256: createHash('sha256').update(bytes).digest('hex'), size_bytes: bytes.byteLength, relative_path: `${runId}/${filename}`, created_at: this.#now().toISOString() })
  }
}

async function immutableHash(root: string, files: readonly string[]): Promise<string> {
  const hash = createHash('sha256')
  for (const file of [...files].sort()) hash.update(file).update('\0').update(await readFile(resolve(root, file))).update('\0')
  return hash.digest('hex')
}

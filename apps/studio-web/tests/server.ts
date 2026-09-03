import type { JobId, JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { CSRF_COOKIE, SESSION_COOKIE, type SessionRecord, type StudioIdentityService } from '../../../plugins/identity/src/index.js'
import { createStudioWebHandler } from '../../../plugins/studio-web/src/index.js'
import type { StudioTenancyService } from '../../../plugins/tenancy/src/index.js'
import { createPromptToAppHttpHandler } from '../../../plugins/prompt-to-app/src/http.js'
import { IntakeEngine } from '../../../plugins/prompt-to-app/src/intake.js'
import { PromptToAppJobService, type PromptToAppJobRegistry } from '../../../plugins/prompt-to-app/src/jobs.js'
import type { StudioApproval, StudioAppSpecRecord, StudioDesignSpecRecord, StudioEvidence, StudioIntakeTurn, StudioPlan, StudioProject, StudioRun } from '../../../plugins/prompt-to-app/src/model.js'
import { ModelCodeGenerator, PromptToAppPipeline } from '../../../plugins/prompt-to-app/src/pipeline.js'
import { PlannerEngine } from '../../../plugins/prompt-to-app/src/planner.js'
import type { PromptModelPort } from '../../../plugins/prompt-to-app/src/ports.js'
import type { ContainerBuilder } from '../../../plugins/prompt-to-app/src/runner.js'
import { PromptToAppService, type PromptToAppRepository } from '../../../plugins/prompt-to-app/src/service.js'

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

function upsert<T, K extends keyof T>(rows: T[], value: T, key: K): T[] { return [...rows.filter(row => row[key] !== value[key]), value] }

const root = resolve(import.meta.dirname, '..', '..', '..')
const scratch = await mkdtemp(join(tmpdir(), 'dz23-studio-e2e-'))
const session = { session_id: 'e2e-session', user_id: 'owner', org_id: 'org-e2e', tenant_id: 'tenant-e2e' } as SessionRecord
const identity = {
  authenticate: async (token: string) => {
    if (token !== 'e2e') throw new Error('invalid-session')
    return session
  },
  validateCsrf: (_session: SessionRecord, cookie: string | undefined, header: string | undefined) => {
    if (cookie !== 'csrf-e2e' || header !== 'csrf-e2e') throw new Error('invalid-csrf')
  },
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
const builder = {
  preflight: async () => ({ state: 'OK' as const, message: 'fixture' }),
  execute: async (directory: string, command: string) => {
    if (command === 'pnpm run test:e2e') {
      const path = resolve(directory, 'evidence', 'appspec-report.json')
      const report = JSON.parse(await readFile(path, 'utf8')) as { checks: Array<{ status: string }> }
      report.checks = report.checks.map(check => check.status === 'PENDING' ? { ...check, status: 'PASSED' } : check)
      await writeFile(path, JSON.stringify(report))
    }
    return { exitCode: 0, stdout: command, stderr: '', timedOut: false, command, securityArgs: [] }
  },
} as unknown as ContainerBuilder
const pipeline = new PromptToAppPipeline({ service, builder, templateDirectory: resolve(root, 'templates', 'static-site@1'), runsRoot: resolve(scratch, 'runs'), createId: () => `pipeline-${++id}` })
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
const host = '127.0.0.1:4179'
const apiHandler = createPromptToAppHttpHandler({
  service, identity, tenancy, intake: new IntakeEngine(model), planner: new PlannerEngine(model), jobs,
  logos: { process: async () => ({
    sha256: 'a'.repeat(64), relative_path: `logos/${'b'.repeat(64)}/${'a'.repeat(64)}.png`, mime: 'image/png' as const,
    size_bytes: 100, width: 10, height: 10, extracted_primary: { h: 217, s: 91, l: 50 },
  }) },
  generatorFor: (actor, projectId) => new ModelCodeGenerator(model, actor, service.project(actor, projectId).privacy),
  health: async () => ({ state: 'OK', route: 'ollama-local', builder: 'OK', disk: 'OK' }), allowedHosts: [host], allowedOrigins: [`http://${host}`],
})
const webHandler = createStudioWebHandler({ distDirectory: resolve(root, 'apps', 'studio-web', 'dist'), identity, allowedHosts: [host] })
const server = createServer((request, response) => {
  if (request.url === '/healthz') return plain(response, 200, 'ok')
  if (request.url?.startsWith('/api/studio/apps') === true) return void apiHandler(request, response)
  return void webHandler(request, response)
})
server.listen(4179, '127.0.0.1')
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { server.close(() => { void rm(scratch, { recursive: true, force: true }).finally(() => process.exit(0)) }) })

function plain(response: ServerResponse<IncomingMessage>, status: number, body: string) { response.writeHead(status, { 'content-type': 'text/plain' }); response.end(body) }

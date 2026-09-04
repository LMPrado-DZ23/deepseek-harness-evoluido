import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppSpecV1 } from '../../prompt-to-app/src/appspec.js'
import type {
  StudioApproval, StudioAppSpecRecord, StudioDesignSpecRecord, StudioEvidence, StudioIntakeTurn,
  StudioPlan, StudioProject, StudioRun,
} from '../../prompt-to-app/src/model.js'
import { PromptToAppPipeline } from '../../prompt-to-app/src/pipeline.js'
import { ContainerBuilder } from '../../prompt-to-app/src/runner.js'
import { PromptToAppService, type PromptToAppActor, type PromptToAppRepository } from '../../prompt-to-app/src/service.js'
import type { HubEvent, StudioExport, StudioIntegration } from '../src/model.js'
import { IntegrationHubService, type HubActor, type HubRepository } from '../src/service.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

class PromptRepository implements PromptToAppRepository {
  projectRows: StudioProject[] = []; specRows: StudioAppSpecRecord[] = []; designRows: StudioDesignSpecRecord[] = []
  turnRows: StudioIntakeTurn[] = []; planRows: StudioPlan[] = []; runRows: StudioRun[] = []
  evidenceRows: StudioEvidence[] = []; approvalRows: StudioApproval[] = []
  projects = () => this.projectRows; specs = () => this.specRows; designs = () => this.designRows
  turns = () => this.turnRows; plans = () => this.planRows; runs = () => this.runRows
  evidence = () => this.evidenceRows; approvals = () => this.approvalRows
  putProject = async (value: StudioProject) => { this.projectRows = upsert(this.projectRows, value, 'project_id') }
  putSpec = async (value: StudioAppSpecRecord) => { this.specRows = upsert(this.specRows, value, 'spec_id') }
  putDesign = async (value: StudioDesignSpecRecord) => { this.designRows = upsert(this.designRows, value, 'design_id') }
  putTurn = async (value: StudioIntakeTurn) => { this.turnRows = upsert(this.turnRows, value, 'turn_id') }
  putPlan = async (value: StudioPlan) => { this.planRows = upsert(this.planRows, value, 'plan_id') }
  putRun = async (value: StudioRun) => { this.runRows = upsert(this.runRows, value, 'run_id') }
  putEvidence = async (value: StudioEvidence) => { this.evidenceRows = upsert(this.evidenceRows, value, 'evidence_id') }
  putApproval = async (value: StudioApproval) => { this.approvalRows = upsert(this.approvalRows, value, 'approval_id') }
}

class ExportRepository implements HubRepository {
  exportRows: StudioExport[] = []; eventRows: HubEvent[] = []
  integrations = (_scope: HubActor): readonly StudioIntegration[] => []
  integration = (_scope: HubActor, _id: string): StudioIntegration | undefined => undefined
  putIntegration = async (_value: StudioIntegration) => undefined
  compareAndSwapIntegration = async () => false
  exports = (scope: HubActor, projectId: string) => this.exportRows.filter(row => sameScope(scope, row) && row.project_id === projectId)
  export = (scope: HubActor, projectId: string, exportId: string) => this.exportRows.find(row => sameScope(scope, row) && row.project_id === projectId && row.export_id === exportId)
  putExport = async (value: StudioExport) => { this.exportRows.push(value) }
  eventPage = (scope: HubActor, _after: Pick<HubEvent, 'created_at' | 'event_id'> | undefined, limit: number) => this.eventRows.filter(row => sameScope(scope, row)).slice(0, limit)
  eventCount = (scope: HubActor) => this.eventRows.filter(row => sameScope(scope, row)).length
  putEvent = async (value: HubEvent) => { this.eventRows.push(value) }
  pruneEvents = async () => 0
}

const actor: PromptToAppActor & HubActor = { userId: 'owner-a', orgId: 'org-a', tenantId: 'tenant-a', role: 'owner', sessionId: 'session-a' }
const foreignActor: PromptToAppActor & HubActor = { userId: 'owner-b', orgId: 'org-b', tenantId: 'tenant-b', role: 'owner', sessionId: 'session-b' }
const spec: AppSpecV1 = {
  schema_version: 1, problem: 'Criar uma agenda.', audience: 'Clientes', journeys: ['Reservar'],
  pages: [{ name: 'Reservas', sections: ['Cadastro'] }], entities: [],
  sensitive_data: { detected: [], confirmed_by_user: false },
  accessibility: { wcag_level: 'AA', keyboard_required: true, reduced_motion: true }, language: 'pt-BR',
  acceptance_criteria: ['A tela mostra reservas.'],
}

describe('Prompt-to-App → Integration Hub export boundary', () => {
  it('keeps the executable proof on the real pipeline path with no manual PASSED or server fabrication', async () => {
    const proof = await readFile(resolve(process.cwd(), 'scripts/prove-integration-hub.mjs'), 'utf8')
    expect(proof).toContain('pipeline.run(actor, project.project_id')
    expect(proof).toContain("pipelineResult.state === 'BLOCKED_EXTERNAL'")
    expect(proof).not.toContain('p2a.putRun(')
    expect(proof).not.toMatch(/writeFile\([^\n]*standalone[^\n]*server\.js/u)
    expect(proof).not.toContain("transition(actor, project.project_id, 'VERIFIED_PROTOTYPE')")
  })

  it('keeps export NOT_EXECUTED when the real isolated builder is unavailable, without forging PASSED', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'dz23-real-export-contract-')); roots.push(root)
    const templateDirectory = resolve(root, 'template'); const runsRoot = resolve(root, 'runs')
    await mkdir(templateDirectory, { recursive: true }); await writeFile(resolve(templateDirectory, 'package.json'), '{"private":true}')
    const promptRepository = new PromptRepository()
    let id = 0
    const prompt = new PromptToAppService({ repository: promptRepository, createId: () => `id-${++id}` })
    const project = await prompt.createProject(actor, { name: 'Agenda', original_brief: spec.problem, category: 'landing-page', privacy: 'local-only' })
    await prompt.saveSpec(actor, project.project_id, spec, 'intake')
    await prompt.proposePlan(actor, project.project_id, [{ slice_id: 'slice', title: 'Tela', description: 'Agenda', acceptance_criteria: ['Compila'], planned_files: ['src/GeneratedApp.tsx'] }])
    await prompt.approvePlan(actor, project.project_id)

    // An invalid pin makes the production ContainerBuilder fail closed before
    // invoking Docker. This is the exact state of a machine with no prepared
    // builder image: the test proves composition, not an application build.
    const builder = new ContainerBuilder({
      engine: 'docker', imageDigest: 'sha256:unconfigured', templateStore: resolve(root, 'store'), user: '1000:1000',
      limits: { pids: 16, memory: '128m', cpus: '1', timeoutMs: 1_000 },
    })
    const pipeline = new PromptToAppPipeline({ service: prompt, builder, templateDirectory, runsRoot, createId: () => `run-${++id}` })
    const generator = { generate: async () => { throw new Error('GENERATOR_MUST_NOT_RUN') } }
    await expect(pipeline.run(actor, project.project_id, generator)).resolves.toMatchObject({ state: 'BLOCKED_EXTERNAL', attempts: 0 })
    expect(promptRepository.runRows).toEqual(expect.arrayContaining([expect.objectContaining({ state: 'BLOCKED_EXTERNAL', failure_code: 'BUILDER_UNAVAILABLE', artifact_sha256: null })]))
    expect(promptRepository.runRows.some(run => run.state === 'PASSED')).toBe(false)

    const exportRepository = new ExportRepository()
    const hub = new IntegrationHubService({
      repository: exportRepository, secrets: { inspect: async () => ({ present: false, shapeOk: false }) },
      projects: { project: (scope, projectId) => prompt.project(scope, projectId), runs: (scope, projectId) => prompt.runs(scope, projectId) },
      exportsRoot: resolve(root, 'exports'), runsRoot, publisherKeys: {}, channel: 'stable',
    })
    await expect(hub.createExport(actor, project.project_id)).rejects.toMatchObject({ code: 'INVALID' })
    expect(exportRepository.exportRows).toHaveLength(0)
    expect(exportRepository.eventRows).toContainEqual(expect.objectContaining({ action: 'export.created', outcome: 'failure' }))
    await expect(hub.createExport(foreignActor, project.project_id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(exportRepository.exportRows).toHaveLength(0)
  })
})

function upsert<T, K extends keyof T>(rows: T[], value: T, key: K): T[] { return [...rows.filter(row => row[key] !== value[key]), value] }
function sameScope(scope: HubActor, row: { readonly org_id: string; readonly tenant_id: string }): boolean { return scope.orgId === row.org_id && scope.tenantId === row.tenant_id }

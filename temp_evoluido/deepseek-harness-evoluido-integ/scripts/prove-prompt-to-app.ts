import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AppSpecV1 } from '../plugins/prompt-to-app/src/appspec.js'
import type { BuilderLifecycleResolverPort } from '../plugins/prompt-to-app/src/builder-lifecycle.js'
import type { StudioApproval, StudioAppSpecRecord, StudioDesignSpecRecord, StudioEvidence, StudioIntakeTurn, StudioPlan, StudioProject, StudioRun } from '../plugins/prompt-to-app/src/model.js'
import { PromptToAppPipeline, type CodeGeneratorPort } from '../plugins/prompt-to-app/src/pipeline.js'
import { PromptToAppError, PromptToAppService, type PromptToAppActor, type PromptToAppRepository } from '../plugins/prompt-to-app/src/service.js'

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

const root = process.cwd()
const scratch = await mkdtemp(join(tmpdir(), 'dz23-prompt-proof-'))
const runsRoot = resolve(scratch, 'runs')
const outside = resolve(scratch, 'outside-sentinel.txt')
await writeFile(outside, 'unchanged')
const outsideBefore = createHash('sha256').update(await readFile(outside)).digest('hex')
const repository = new MemoryRepository()
let sequence = 0
const service = new PromptToAppService({ repository, now: () => new Date('2026-09-03T12:00:00.000Z'), createId: () => `proof-${++sequence}` })
const actor: PromptToAppActor = { userId: 'owner-a', orgId: 'org-a', tenantId: 'tenant-a', role: 'owner' }
const attacker: PromptToAppActor = { userId: 'owner-b', orgId: 'org-b', tenantId: 'tenant-b', role: 'owner' }
const spec: AppSpecV1 = {
  schema_version: 1, problem: 'Apresentar serviços com clareza.', audience: 'Clientes locais',
  journeys: ['Conhecer os serviços'], pages: [{ name: 'Ateliê Aurora', sections: ['Serviços locais', 'Contato'] }], entities: [],
  sensitive_data: { detected: [], confirmed_by_user: false },
  accessibility: { wcag_level: 'AA', keyboard_required: true, reduced_motion: true },
  language: 'pt-BR', acceptance_criteria: ['Mostrar o texto “Fale com a equipe”.', 'A página deve ser clara.'],
}
const unsupported = async (): Promise<never> => { throw new Error('UNSUPPORTED_INGRESS') }
const builder: BuilderLifecycleResolverPort<PromptToAppActor> = {
  forActor: async () => ({
    preflight: async () => ({ state: 'BLOCKED_EXTERNAL' }),
    prepare: unsupported,
    execute: unsupported,
    cancel: unsupported,
    finish: unsupported,
    listManaged: async () => [],
  }),
}

try {
  const project = await service.createProject(actor, {
    name: 'Ateliê Aurora', original_brief: 'Quero apresentar meus serviços e um contato.', category: 'landing-page', privacy: 'local-only',
  })
  await service.saveSpec(actor, project.project_id, spec, 'intake')
  await service.proposePlan(actor, project.project_id, [{
    slice_id: 'page', title: 'Página principal', description: 'Criar uma apresentação acessível.',
    acceptance_criteria: ['Build e testes passam.'], planned_files: ['content/app.json', 'src/GeneratedApp.tsx'],
  }])
  await service.approvePlan(actor, project.project_id)
  let generatorCalled = false
  const generator: CodeGeneratorPort = { generate: async () => {
    generatorCalled = true
    return ({
    route: 'deterministic-fixture', model: 'fixture-v1', inputTokens: 0, outputTokens: 0,
    files: [
      { path: 'content/app.json', content: '{"title":"Ateliê Aurora","description":"Serviços locais e contato."}' },
      { path: 'src/GeneratedApp.tsx', content: 'export default function GeneratedApp() { return <main><h1>Ateliê Aurora</h1><section><h2>Serviços locais</h2></section><section><h2>Contato</h2><p>Fale com a equipe</p></section></main> }\n' },
    ],
    })
  } }
  const pipeline = new PromptToAppPipeline({
    service, builder, templateDirectory: resolve(root, 'templates/nextjs-app@1'), runsRoot,
    now: () => new Date('2026-09-03T12:00:00.000Z'), createId: () => `proof-${++sequence}`,
  })
  const result = await pipeline.run(actor, project.project_id, generator)
  if (result.state !== 'BLOCKED_EXTERNAL' || result.attempts !== 0 || result.runDirectory !== undefined) {
    const failure = [...repository.runRows].sort((left, right) => right.attempt - left.attempt)[0]
    throw new Error(`Pipeline terminou em ${result.state}: ${failure?.failure_code ?? result.message}`)
  }
  if (generatorCalled) throw new Error('GENERATOR_RAN_WITHOUT_AUTHENTICATED_INGRESS')
  if (await readFile(outside, 'utf8') !== 'unchanged') throw new Error('Arquivo fora do sandbox foi alterado.')
  const outsideAfter = createHash('sha256').update(await readFile(outside)).digest('hex')
  if (outsideAfter !== outsideBefore) throw new Error('Hash externo mudou.')
  let isolated = false
  try { service.project(attacker, project.project_id) } catch (error) { isolated = error instanceof PromptToAppError && error.code === 'NOT_FOUND' }
  if (!isolated) throw new Error('Isolamento tenant não foi provado.')
  if (repository.runRows.length !== 1 || repository.evidenceRows.length !== 0) throw new Error('Estado bloqueado não foi registrado de forma honesta.')
  if (repository.runRows[0]!.state !== 'BLOCKED_EXTERNAL' || repository.runRows[0]!.failure_code !== 'BUILDER_UNAVAILABLE') throw new Error('Bloqueio externo ausente.')

  const proof = [
    '# P32/P33 + P31-B — Prova da fatia vertical 1', '',
    '- Resultado lógico: **PASS**', '- Estado final: `BLOCKED_EXTERNAL`', '- Modelo e LLM real: `NOT_EXECUTED`',
    '- Ingresso autenticado do builder: `NOT_PRESENT`', '- Build, Vitest, Playwright e axe: `NOT_EXECUTED`',
    '- Tentativas: 0/3', '- Isolamento tenant adversarial: PASS (`org-b` recebeu `NOT_FOUND`)',
    `- Arquivo sentinela fora da raiz: hash antes/depois idêntico \`${outsideBefore}\``,
    '- Evidências de build gravadas: nenhuma.',
    '- Critérios AppSpec: `NOT_EXECUTED`; nenhuma promoção foi alegada.',
    '- Preview: `NOT_PRESENT`; publicação: `NOT_PRESENT`; experiência leiga: `NOT_VALIDATED`', '',
    'Esta prova valida somente composição lógica, isolamento tenant e contenção fail-closed. Ela não valida build, testes, qualidade com LLM real, uso por pessoas leigas, celular físico, preview ou deploy.', '',
  ].join('\n')
  await writeFile(resolve(root, 'docs/proofs/P32-prompt-to-app-fatia1-proof.md'), proof)
  process.stdout.write('PROMPT_TO_APP_LOGIC_PROOF=PASS state=BLOCKED_EXTERNAL ingress=NOT_PRESENT build=NOT_EXECUTED real_llm=NOT_EXECUTED\n')
} finally {
  await rm(scratch, { recursive: true, force: true })
}

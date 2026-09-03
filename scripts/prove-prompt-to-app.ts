import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import type { AppSpecV1 } from '../plugins/prompt-to-app/src/appspec.js'
import type { StudioApproval, StudioAppSpecRecord, StudioDesignSpecRecord, StudioEvidence, StudioIntakeTurn, StudioPlan, StudioProject, StudioRun } from '../plugins/prompt-to-app/src/model.js'
import { PromptToAppPipeline, type CodeGeneratorPort } from '../plugins/prompt-to-app/src/pipeline.js'
import { ContainerBuilder } from '../plugins/prompt-to-app/src/runner.js'
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
const digest = (await readFile(resolve(root, 'runtime/builder-image-digest'), 'utf8')).trim() as `sha256:${string}`
const uid = typeof process.getuid === 'function' ? process.getuid() : 1000
const gid = typeof process.getgid === 'function' ? process.getgid() : 1000
const builder = new ContainerBuilder({
  engine: 'docker', imageDigest: digest, templateStore: resolve(root, 'runtime/template-store-v2'), user: `${uid}:${gid}`,
  limits: { pids: 256, memory: '2g', cpus: '2', timeoutMs: 180_000 },
})

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
  const generator: CodeGeneratorPort = { generate: async () => ({
    route: 'deterministic-fixture', model: 'fixture-v1', inputTokens: 0, outputTokens: 0,
    files: [
      { path: 'content/app.json', content: '{"title":"Ateliê Aurora","description":"Serviços locais e contato."}' },
      { path: 'src/GeneratedApp.tsx', content: 'export default function GeneratedApp() { return <main><h1>Ateliê Aurora</h1><section><h2>Serviços locais</h2></section><section><h2>Contato</h2><p>Fale com a equipe</p></section></main> }\n' },
    ],
  }) }
  const pipeline = new PromptToAppPipeline({
    service, builder, templateDirectory: resolve(root, 'templates/nextjs-app@1'), runsRoot,
    now: () => new Date('2026-09-03T12:00:00.000Z'), createId: () => `proof-${++sequence}`,
  })
  const result = await pipeline.run(actor, project.project_id, generator)
  if (result.state !== 'VERIFIED_PROTOTYPE' || result.runDirectory === undefined) {
    const failure = [...repository.runRows].sort((left, right) => right.attempt - left.attempt)[0]
    throw new Error(`Pipeline terminou em ${result.state}: ${failure?.failure_code ?? result.message}`)
  }
  if (!result.runDirectory.startsWith(`${runsRoot}${sep}`)) throw new Error('Diretório de execução saiu da raiz autorizada.')
  if (await readFile(outside, 'utf8') !== 'unchanged') throw new Error('Arquivo fora do sandbox foi alterado.')
  const outsideAfter = createHash('sha256').update(await readFile(outside)).digest('hex')
  if (outsideAfter !== outsideBefore) throw new Error('Hash externo mudou.')
  let isolated = false
  try { service.project(attacker, project.project_id) } catch (error) { isolated = error instanceof PromptToAppError && error.code === 'NOT_FOUND' }
  if (!isolated) throw new Error('Isolamento tenant não foi provado.')
  if (repository.runRows.length !== 1 || repository.evidenceRows.length !== 2) throw new Error('Run ou evidência ausente.')
  if (repository.runRows[0]!.acceptance_checks.some(check => check.status !== 'PASSED' && check.status !== 'NOT_AUTOMATED')) throw new Error('Critério automático não passou.')
  if (!(await stat(resolve(result.runDirectory, 'pipeline.log'))).isFile()) throw new Error('Log do pipeline ausente.')

  const proof = [
    '# P32/P33 + P31-B — Prova da fatia vertical 1', '',
    '- Resultado: **PASS**', '- Estado final: `VERIFIED_PROTOTYPE`', '- Modelo: fixture determinística; LLM real: `NOT_EXECUTED`',
    `- Imagem do construtor: \`${digest}\``, '- Build, Vitest, Playwright e axe: PASS em contêiner sem rede',
    '- Tentativas: 1/3', '- Isolamento tenant adversarial: PASS (`org-b` recebeu `NOT_FOUND`)',
    `- Arquivo sentinela fora da raiz: hash antes/depois idêntico \`${outsideBefore}\``,
    `- Evidências gravadas: ${repository.evidenceRows.map(value => `\`${value.kind}:${value.sha256}\``).join(', ')}`,
    '- Critérios AppSpec: páginas, seções, idioma, título e texto literal passaram; o critério subjetivo ficou `NOT_AUTOMATED`.',
    '- Preview: `NOT_PRESENT`; publicação: `NOT_PRESENT`; experiência leiga: `NOT_VALIDATED`', '',
    'Esta prova valida a composição técnica determinística da fatia. Ela não valida qualidade com LLM real, uso por pessoas leigas, celular físico, preview ou deploy.', '',
  ].join('\n')
  await writeFile(resolve(root, 'docs/proofs/P32-prompt-to-app-fatia1-proof.md'), proof)
  process.stdout.write('PROMPT_TO_APP_PROOF=PASS state=VERIFIED_PROTOTYPE real_llm=NOT_EXECUTED\n')
} finally {
  await rm(scratch, { recursive: true, force: true })
}

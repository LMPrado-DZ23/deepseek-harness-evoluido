import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import type { BuilderLifecycleResolverPort } from '../plugins/prompt-to-app/src/builder-lifecycle.js'
import { scanGeneratedContent } from '../plugins/prompt-to-app/src/security.js'
import type { AppSpecV1 } from '../plugins/prompt-to-app/src/appspec.js'
import { generateAuthLayer, writeAuthLayer } from '../plugins/prompt-to-app/src/auth-generator.js'
import { generateCrudLayer, writeCrudLayer } from '../plugins/prompt-to-app/src/crud-generator.js'
import { generateDataLayer, writeDataLayer } from '../plugins/prompt-to-app/src/data-generator.js'
import { dataIdentifier } from '../plugins/prompt-to-app/src/data-generator.js'
import { generateFormLayer, writeFormLayer } from '../plugins/prompt-to-app/src/form-generator.js'
import { writeAcceptanceArtifacts } from '../plugins/prompt-to-app/src/acceptance.js'
import { generateSchedulingLayer, writeSchedulingLayer } from '../plugins/prompt-to-app/src/scheduling-generator.js'
import { generateDashboardLayer, writeDashboardLayer } from '../plugins/prompt-to-app/src/dashboard-generator.js'
import { generateSaasLayer, writeSaasLayer } from '../plugins/prompt-to-app/src/saas-generator.js'

type GoldenState = 'LOGICAL_GENERATION_ONLY' | 'NOT_IMPLEMENTED'
interface Criterion {
  readonly id: string
  readonly category: 'landing-page' | 'catalog' | 'form-database' | 'crud-panel' | 'scheduling' | 'saas-authenticated' | 'dashboard'
  readonly sensitive: boolean
  readonly acceptance: readonly string[]
}

const root = process.cwd()
const briefsDir = resolve(root, 'golden-set/briefs')
const criteriaDir = resolve(root, 'golden-set/criteria')
const reportsDir = resolve(root, 'golden-set/reports')
const implemented = new Set<Criterion['category']>([
  'landing-page', 'catalog', 'form-database', 'crud-panel', 'scheduling', 'saas-authenticated', 'dashboard',
])
const realLlmRequested = process.env.DZ23_GOLDEN_LLM === '1'

if (realLlmRequested) {
  process.stderr.write('GOLDEN_SET=NOT_CONFIGURED reason=real-llm-adapter-not-bound\n')
  process.exit(2)
}

const unsupported = async (): Promise<never> => { throw new Error('UNSUPPORTED_INGRESS') }
const builder: BuilderLifecycleResolverPort<unknown> = {
  forActor: async () => ({
    preflight: async () => ({ state: 'BLOCKED_EXTERNAL' }),
    prepare: unsupported,
    execute: unsupported,
    cancel: unsupported,
    finish: unsupported,
    listManaged: async () => [],
  }),
}
const preflight = await (await builder.forActor({})).preflight()
if (preflight.state !== 'BLOCKED_EXTERNAL') throw new Error('INGRESS_MUST_REMAIN_BLOCKED')

const criteriaFiles = (await readdir(criteriaDir)).filter(file => file.endsWith('.yml')).sort()
const briefFiles = (await readdir(briefsDir)).filter(file => file.endsWith('.md')).sort()
const EXPECTED_FIXTURES = 21
if (criteriaFiles.length !== EXPECTED_FIXTURES) throw new Error(`Golden set inválido: esperado exatamente ${EXPECTED_FIXTURES} critérios, encontrado ${criteriaFiles.length}.`)
if (briefFiles.length !== EXPECTED_FIXTURES) throw new Error(`Golden set inválido: esperado exatamente ${EXPECTED_FIXTURES} briefs, encontrado ${briefFiles.length}.`)
const expectedBriefFiles = criteriaFiles.map(file => `${basename(file, '.yml')}.md`)
if (JSON.stringify(briefFiles) !== JSON.stringify(expectedBriefFiles)) throw new Error('Golden set inválido: briefs e critérios não têm correspondência exata.')
// Cada categoria implementada precisa de pelo menos três casos. Sem esta
// conta, `scheduling` estava declarada em UM arquivo chamado
// `form-database-01`, e as outras duas agendas rodavam o gerador de formulário
// - o conjunto testava o gerador errado para o pedido, e ninguém via.
const perCategory = new Map<string, number>()
for (const file of criteriaFiles) {
  const criterion = parseCriterion(JSON.parse(await readFile(resolve(criteriaDir, file), 'utf8')), file)
  perCategory.set(criterion.category, (perCategory.get(criterion.category) ?? 0) + 1)
}
for (const category of implemented) {
  const total = perCategory.get(category) ?? 0
  if (total < 3) throw new Error(`Golden set inválido: categoria ${category} tem ${total} casos; o mínimo é 3.`)
}

const scratch = await mkdtemp(join(tmpdir(), 'dz23-golden-'))
const results: Array<{ id: string; category: string; state: GoldenState; critical: string; technical_checks_passed: number | null; declared_criteria_passed: number | null; declared_criteria_not_automated: number | null; detail: string }> = []
const seenIds = new Set<string>()

try {
  for (const file of criteriaFiles) {
    const criterion = parseCriterion(JSON.parse(await readFile(resolve(criteriaDir, file), 'utf8')), file)
    if (seenIds.has(criterion.id)) throw new Error(`Golden set inválido: id duplicado ${criterion.id}.`)
    seenIds.add(criterion.id)
    if (file !== `${criterion.id}.yml`) throw new Error(`Golden set inválido: ${file} declara id ${criterion.id}.`)
    const briefPath = resolve(briefsDir, `${criterion.id}.md`)
    const brief = await readFile(briefPath, 'utf8')
    if (brief.trim().length < 40 || criterion.acceptance.length < 3) throw new Error(`Fixture incompleta: ${criterion.id}`)
    if (!implemented.has(criterion.category)) {
      results.push({ id: criterion.id, category: criterion.category, state: 'NOT_IMPLEMENTED', critical: 'NOT_EXECUTED', technical_checks_passed: null, declared_criteria_passed: null, declared_criteria_not_automated: null, detail: 'Categoria declarada, ainda sem executor.' })
      continue
    }

    const runDirectory = resolve(scratch, criterion.id)
    await cp(resolve(root, 'templates/nextjs-app@1'), runDirectory, { recursive: true })
    await mkdir(resolve(runDirectory, 'content'), { recursive: true })
    await mkdir(resolve(runDirectory, 'src/styles'), { recursive: true })
    await writeFile(resolve(runDirectory, 'src/styles/tokens.css'), ':root { --background: 0 0% 100%; --foreground: 222 47% 11%; --card: 0 0% 100%; --card-foreground: 222 47% 11%; --primary: 222 72% 32%; --primary-foreground: 0 0% 100%; --secondary: 214 32% 91%; --secondary-foreground: 222 47% 11%; --muted: 210 40% 96%; --muted-foreground: 215 16% 40%; --accent: 214 100% 93%; --accent-foreground: 222 72% 26%; --destructive: 0 72% 45%; --border: 214 32% 88%; --input: 214 32% 88%; --ring: 217 91% 50%; --radius: 0.75rem; --font-body: sans-serif; }\n')
    const appSpec = goldenSpec(criterion, brief)
    const title = appSpec.pages[0]!.name
    const description = criterion.category === 'catalog'
      ? 'Produtos e serviços apresentados de forma clara e acessível.'
      : criterion.id === 'landing-01'
        ? 'Serviços, horários e contato pelo telefone 11987654321.'
        : 'Serviços, horários e contato apresentados de forma clara e acessível.'
    if (criterion.id === 'catalog-03') {
      if (scanGeneratedContent({ fixture: 'CPF 529.982.247-25' }).length !== 1) throw new Error('catalog-03: CPF válido não foi recusado.')
      if (scanGeneratedContent({ fixture: 'CPF 123.456.789-00' }).length !== 0) throw new Error('catalog-03: CPF inválido virou falso positivo.')
    }
    const content = JSON.stringify({ title, description }, null, 2)
    const component = generatedView(appSpec, criterion.category, description)
    const findings = scanGeneratedContent({ 'content/app.json': content, 'src/GeneratedApp.tsx': component })
    if (findings.length > 0) throw new Error(`${criterion.id}: controle crítico recusou ${findings.join(', ')}`)
    await writeFile(resolve(runDirectory, 'content/app.json'), content)
    await writeFile(resolve(runDirectory, 'src/GeneratedApp.tsx'), component)
    await writeAuthLayer(runDirectory, generateAuthLayer(appSpec, criterion.category))
    if (appSpec.entities.some(entity => entity.kind === 'database')) {
      await writeDataLayer(runDirectory, generateDataLayer(appSpec))
    }
    if (criterion.category === 'form-database' || criterion.category === 'crud-panel') {
      await writeFormLayer(runDirectory, generateFormLayer(appSpec, criterion.category))
      await writeCrudLayer(runDirectory, generateCrudLayer(appSpec, criterion.category))
    }
    if (criterion.category === 'scheduling') await writeSchedulingLayer(runDirectory, generateSchedulingLayer(appSpec))
    if (criterion.category === 'dashboard') await writeDashboardLayer(runDirectory, generateDashboardLayer(appSpec, criterion.category))
    if (criterion.category === 'saas-authenticated') await writeSaasLayer(runDirectory, generateSaasLayer(appSpec, criterion.category))
    await writeAcceptanceArtifacts(runDirectory, appSpec, criterion.category)
    results.push({
      id: criterion.id, category: criterion.category, state: 'LOGICAL_GENERATION_ONLY',
      critical: criterion.sensitive ? 'SENSITIVE_GATE_NOT_EXECUTED' : 'NOT_APPLICABLE',
      technical_checks_passed: null,
      declared_criteria_passed: null,
      declared_criteria_not_automated: null,
      detail: 'A geração declarativa e o scan estático local passaram; build, testes, E2E e critérios permanecem NOT_EXECUTED porque o ingresso autenticado do builder não existe.',
    })
  }
} finally {
  await rm(scratch, { recursive: true, force: true })
}

const generatedAt = new Date().toISOString()
const stamp = generatedAt.replaceAll(':', '-').replaceAll('.', '-')
const fixtureSha256 = await hashFixtures([...criteriaFiles.map(file => resolve(criteriaDir, file)), ...briefFiles.map(file => resolve(briefsDir, file))])
await mkdir(reportsDir, { recursive: true })
const report = {
  schema_version: 3, generated_at: generatedAt, route: 'deterministic-fixture', source_commit: 'NOT_CAPTURED_NO_SUBPROCESS',
  working_tree_dirty: 'NOT_CAPTURED_NO_SUBPROCESS', builder_ingress: 'NOT_PRESENT', fixture_sha256: fixtureSha256,
  real_llm: 'NOT_EXECUTED', build: 'NOT_EXECUTED', acceptance_attestation: 'NOT_PRESENT', promotion_eligible: false,
  counts: {
    total: results.length,
    logical_generation_only: results.filter(value => value.state === 'LOGICAL_GENERATION_ONLY').length,
    not_implemented: results.filter(value => value.state === 'NOT_IMPLEMENTED').length,
    technical_checks_passed: results.reduce((total, value) => total + (value.technical_checks_passed ?? 0), 0),
    declared_criteria_passed: results.reduce((total, value) => total + (value.declared_criteria_passed ?? 0), 0),
    declared_criteria_not_automated: results.reduce((total, value) => total + (value.declared_criteria_not_automated ?? 0), 0),
  },
  results,
}
await writeFile(resolve(reportsDir, `${stamp}-deterministic.json`), `${JSON.stringify(report, null, 2)}\n`)
await writeFile(resolve(reportsDir, `${stamp}-deterministic.md`), [
  '# Golden set — execução determinística', '',
  '- LLM real: **NOT_EXECUTED**', '- Elegível para promoção: **não**',
  '- Ingresso autenticado do builder: **NOT_PRESENT**; build, testes e E2E: **NOT_EXECUTED**.',
  `- SHA-256 conjunto das fixtures: \`${fixtureSha256}\`.`,
  `- Fixtures: ${report.counts.total}; geração lógica somente: ${report.counts.logical_generation_only}; NOT_IMPLEMENTED: ${report.counts.not_implemented}.`,
  '- Checks técnicos e critérios de negócio: **NOT_EXECUTED**.',
  '', '| Brief | Categoria | Estado técnico | Controle sensível | Checks técnicos | Critérios aprovados | Critérios não automatizados |', '| --- | --- | --- | --- | ---: | ---: | ---: |',
  ...results.map(value => `| ${value.id} | ${value.category} | ${value.state} | ${value.critical} | ${value.technical_checks_passed ?? 'NOT_EXECUTED'} | ${value.declared_criteria_passed ?? 'NOT_EXECUTED'} | ${value.declared_criteria_not_automated ?? 'NOT_EXECUTED'} |`), '',
  'Este relatório prova somente a geração declarativa local e o scan estático. Ele não prova pipeline, build, E2E, aceite integral dos briefs, gate sensível ou qualidade com modelo real, e não promove o produto.', '',
].join('\n'))
process.stdout.write(`GOLDEN_SET=LOGICAL_GENERATION_ONLY total=${results.length} generated=${report.counts.logical_generation_only} ingress=NOT_PRESENT build=NOT_EXECUTED real_llm=NOT_EXECUTED\n`)

function parseCriterion(value: unknown, file: string): Criterion {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`Fixture inválida: ${file}.`)
  const record = value as Record<string, unknown>
  const categories = new Set(['landing-page', 'catalog', 'form-database', 'crud-panel', 'scheduling', 'saas-authenticated', 'dashboard'])
  if (typeof record.id !== 'string' || !/^[a-z][a-z0-9-]*$/u.test(record.id)) throw new Error(`Fixture inválida: ${file} tem id inválido.`)
  if (typeof record.category !== 'string' || !categories.has(record.category)) throw new Error(`Fixture inválida: ${file} tem categoria inválida.`)
  if (typeof record.sensitive !== 'boolean') throw new Error(`Fixture inválida: ${file} não declara sensitive booleano.`)
  if (!Array.isArray(record.acceptance) || record.acceptance.length < 3 || record.acceptance.some(item => typeof item !== 'string' || item.trim().length < 3)) throw new Error(`Fixture inválida: ${file} tem critérios de aceite incompletos.`)
  const allowed = new Set(['id', 'category', 'sensitive', 'acceptance'])
  if (Object.keys(record).some(key => !allowed.has(key))) throw new Error(`Fixture inválida: ${file} contém campos desconhecidos.`)
  return record as unknown as Criterion
}

async function hashFixtures(paths: readonly string[]): Promise<string> {
  const hash = createHash('sha256')
  for (const path of [...paths].sort()) {
    hash.update(path.slice(root.length).replaceAll('\\', '/'))
    hash.update('\0')
    hash.update(await readFile(path))
    hash.update('\0')
  }
  return hash.digest('hex')
}

function escapeJsx(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('{', '&#123;').replaceAll('}', '&#125;').replaceAll('`', "'")
}

function goldenSpec(criterion: Criterion, brief: string): AppSpecV1 {
  if (criterion.category === 'landing-page' || criterion.category === 'catalog') {
    const page = criterion.category === 'catalog' ? 'Catálogo local' : 'Página de apresentação'
    const sections = criterion.category === 'catalog' ? ['Itens disponíveis', 'Como pedir'] : ['Serviços', 'Horários', 'Contato']
    const detected: AppSpecV1['sensitive_data']['detected'] = criterion.sensitive
      ? criterion.id === 'landing-03' ? ['health', 'minors'] : ['cpf', 'financial']
      : []
    return {
      schema_version: 1, problem: brief.trim(), audience: 'Pessoas interessadas no negócio',
      journeys: [criterion.category === 'catalog' ? 'Consultar itens e encontrar o contato' : 'Entender o negócio e encontrar o contato'],
      pages: [{ name: page, sections }],
      entities: [{ name: criterion.category === 'catalog' ? 'Item do catálogo' : 'Conteúdo', kind: 'static-content', fields: sections }],
      sensitive_data: { detected, confirmed_by_user: criterion.sensitive },
      accessibility: { wcag_level: 'AA', keyboard_required: true, reduced_motion: true }, language: 'pt-BR',
      acceptance_criteria: [...criterion.acceptance],
    }
  }

  if (criterion.category === 'scheduling') {
    return {
      schema_version: 1, problem: brief.trim(), audience: 'Clientes e equipe do salão',
      journeys: ['Escolher uma data e um horário disponível', 'Confirmar ou cancelar uma reserva'],
      pages: [{ name: 'Agenda', sections: ['Nova reserva', 'Reservas'] }],
      entities: [{
        name: 'Reserva', kind: 'database', sensitive: false,
        fields: [
          { name: 'Data', type: 'date', required: true },
          { name: 'Horário', type: 'selection', required: true, options: ['09:00', '10:00', '14:00', '15:00'] },
        ],
      }],
      sensitive_data: { detected: [], confirmed_by_user: false },
      accessibility: { wcag_level: 'AA', keyboard_required: true, reduced_motion: true }, language: 'pt-BR',
      acceptance_criteria: [...criterion.acceptance],
    }
  }

  if (criterion.category === 'dashboard') return dashboardSpec(criterion, brief)
  if (criterion.category === 'saas-authenticated') return saasSpec(criterion, brief)

  const crud = criterion.category === 'crud-panel'
  const sensitive = criterion.sensitive
  const entityName = crud ? 'Cliente' : sensitive ? 'Registro de saúde' : 'Reserva'
  const fields = crud
    ? [
        { name: 'Nome', type: 'text' as const, required: true },
        { name: sensitive ? 'CPF' : 'E-mail', type: sensitive ? 'text' as const : 'email' as const, required: true },
        { name: sensitive ? 'Limite financeiro' : 'Situação', type: sensitive ? 'number' as const : 'selection' as const, required: true, ...(sensitive ? {} : { options: ['Novo', 'Atendido'] }) },
      ]
    : sensitive
      ? [{ name: 'Nome', type: 'text' as const, required: true }, { name: 'Informação de saúde', type: 'text' as const, required: true }]
      : [{ name: 'Nome', type: 'text' as const, required: true }, { name: 'Data', type: 'date' as const, required: true }, { name: 'Horário', type: 'text' as const, required: true }]
  const detected: AppSpecV1['sensitive_data']['detected'] = sensitive ? (crud ? ['cpf', 'financial'] : ['health']) : []
  return {
    schema_version: 1, problem: brief.trim(), audience: 'Clientes e equipe da pequena empresa', journeys: [crud ? 'Criar, editar e excluir cadastros' : 'Cadastrar e consultar registros'],
    pages: [{ name: crud ? 'Painel de gestão' : 'Registros', sections: [crud ? 'Novo cadastro' : 'Cadastro', crud ? 'Cadastros' : 'Lista'] }],
    entities: [{
      name: entityName, kind: 'database', sensitive,
      fields,
    }],
    sensitive_data: { detected, confirmed_by_user: sensitive },
    accessibility: { wcag_level: 'AA', keyboard_required: true, reduced_motion: true }, language: 'pt-BR',
    acceptance_criteria: [...criterion.acceptance],
  }
}

function dashboardSpec(criterion: Criterion, brief: string): AppSpecV1 {
  const sensitive = criterion.sensitive
  const entityName = criterion.id === 'dashboard-01' ? 'Venda' : criterion.id === 'dashboard-02' ? 'Entrega' : 'Despesa'
  const selectionName = criterion.id === 'dashboard-02' ? 'Região' : 'Categoria'
  const detected: AppSpecV1['sensitive_data']['detected'] = sensitive ? ['financial'] : []
  return {
    schema_version: 1, problem: brief.trim(), audience: 'Equipe responsável pelo acompanhamento',
    journeys: ['Consultar totais e agrupamentos sem alterar cadastros'],
    pages: [{ name: 'Painel', sections: ['Resumo', `Por ${selectionName}`, 'Por mês'] }],
    entities: [{
      name: entityName, kind: 'database', sensitive,
      fields: [
        { name: selectionName, type: 'selection', required: true, options: criterion.id === 'dashboard-02' ? ['Norte', 'Sul'] : ['Produtos', 'Serviços'] },
        { name: 'Data', type: 'date', required: true },
        { name: criterion.id === 'dashboard-02' ? 'Responsável' : 'Valor', type: criterion.id === 'dashboard-02' ? 'text' : 'number', required: true },
      ],
    }],
    sensitive_data: { detected, confirmed_by_user: sensitive },
    accessibility: { wcag_level: 'AA', keyboard_required: true, reduced_motion: true }, language: 'pt-BR',
    acceptance_criteria: [...criterion.acceptance],
  }
}

function saasSpec(criterion: Criterion, brief: string): AppSpecV1 {
  const entityName = criterion.id === 'saas-authenticated-01' ? 'Documento' : criterion.id === 'saas-authenticated-02' ? 'Comunicado' : 'Nota do fornecedor'
  const detected: AppSpecV1['sensitive_data']['detected'] = criterion.id === 'saas-authenticated-02' ? ['minors'] : criterion.id === 'saas-authenticated-03' ? ['financial'] : []
  return {
    schema_version: 1, problem: brief.trim(), audience: 'Pessoas autenticadas e proprietário da organização',
    journeys: ['Entrar por código e consultar somente os próprios registros'],
    pages: [{ name: 'Área protegida', sections: ['Novo registro', 'Meus registros'] }],
    entities: [{
      name: entityName, kind: 'database', sensitive: criterion.sensitive,
      fields: [
        { name: 'Título', type: 'text', required: true },
        { name: 'Descrição', type: 'text', required: true },
      ],
    }],
    sensitive_data: { detected, confirmed_by_user: criterion.sensitive },
    accessibility: { wcag_level: 'AA', keyboard_required: true, reduced_motion: true }, language: 'pt-BR',
    acceptance_criteria: [...criterion.acceptance],
  }
}

function generatedView(spec: AppSpecV1, category: Criterion['category'], description: string): string {
  const labels = [spec.pages[0]!.name, ...spec.pages[0]!.sections, ...spec.entities.flatMap(entity => [entity.name, ...entity.fields.map(field => typeof field === 'string' ? field : field.name)])]
  if (category === 'landing-page' || category === 'catalog') {
    return `export default function GeneratedApp(){return <main>${labels.map((label, index) => index === 0 ? `<h1>${escapeJsx(label)}</h1>` : `<p>${escapeJsx(label)}</p>`).join('')}<p>${escapeJsx(description)}</p></main>}\n`
  }
  if (category === 'scheduling') return generatedComponentView(labels, "import SchedulingPanel from '@/src/components/generated/scheduling-panel'", 'SchedulingPanel')
  if (category === 'dashboard') {
    const entity = spec.entities.find(value => value.kind === 'database')!
    const symbol = `${pascal(dataIdentifier(entity.name))}Dashboard`
    return generatedComponentView(labels, `import ${symbol} from '@/src/components/generated/dashboards/${dataIdentifier(entity.name)}-dashboard'`, symbol)
  }
  if (category === 'saas-authenticated') return generatedComponentView(labels, "import SaasPanel from '@/src/components/generated/saas-panel'", 'SaasPanel')

  const entity = spec.entities.find(value => value.kind === 'database')!
  const symbol = pascal(dataIdentifier(entity.name))
  const component = category === 'crud-panel' ? `${symbol}Panel` : `${symbol}Manager`
  const path = category === 'crud-panel' ? `${dataIdentifier(entity.name)}-panel` : `${dataIdentifier(entity.name)}-manager`
  return `import ${component} from '@/src/components/generated/${path}'\n\nexport default function GeneratedApp(){return <main>${labels.map((label, index) => index === 0 ? `<h1>${escapeJsx(label)}</h1>` : `<p>${escapeJsx(label)}</p>`).join('')}<${component}/></main>}\n`
}

function generatedComponentView(labels: readonly string[], importLine: string, component: string): string {
  const header = labels.map((label, index) => index === 0 ? `<h1>${escapeJsx(label)}</h1>` : `<p>${escapeJsx(label)}</p>`).join('')
  return `${importLine}\n\nexport default function GeneratedApp(){return <><header>${header}</header><${component}/></>}\n`
}

function pascal(value: string): string { return value.split('_').map(part => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join('') }

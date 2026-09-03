import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { ContainerBuilder, OFFLINE_PIPELINE_COMMANDS } from '../plugins/prompt-to-app/src/runner.js'
import { scanGeneratedContent } from '../plugins/prompt-to-app/src/security.js'
import type { AppSpecV1 } from '../plugins/prompt-to-app/src/appspec.js'
import { generateAuthLayer, writeAuthLayer } from '../plugins/prompt-to-app/src/auth-generator.js'
import { generateCrudLayer, writeCrudLayer } from '../plugins/prompt-to-app/src/crud-generator.js'
import { generateDataLayer, writeDataLayer } from '../plugins/prompt-to-app/src/data-generator.js'
import { dataIdentifier } from '../plugins/prompt-to-app/src/data-generator.js'
import { generateFormLayer, writeFormLayer } from '../plugins/prompt-to-app/src/form-generator.js'
import { writeAcceptanceArtifacts } from '../plugins/prompt-to-app/src/acceptance.js'

type GoldenState = 'PASS_DETERMINISTIC' | 'NOT_IMPLEMENTED'
interface Criterion {
  readonly id: string
  readonly category: 'landing-page' | 'catalog' | 'form-database' | 'crud-panel' | 'saas-authenticated' | 'dashboard'
  readonly sensitive: boolean
  readonly acceptance: readonly string[]
}

const root = process.cwd()
const briefsDir = resolve(root, 'golden-set/briefs')
const criteriaDir = resolve(root, 'golden-set/criteria')
const reportsDir = resolve(root, 'golden-set/reports')
const implemented = new Set<Criterion['category']>(['landing-page', 'catalog', 'form-database', 'crud-panel'])
const realLlmRequested = process.env.DZ23_GOLDEN_LLM === '1'

if (realLlmRequested) {
  process.stderr.write('GOLDEN_SET=NOT_CONFIGURED reason=real-llm-adapter-not-bound\n')
  process.exit(2)
}

const digest = (await readFile(resolve(root, 'runtime/builder-image-digest'), 'utf8')).trim() as `sha256:${string}`
const uid = typeof process.getuid === 'function' ? process.getuid() : 1000
const gid = typeof process.getgid === 'function' ? process.getgid() : 1000
const builder = new ContainerBuilder({
  engine: 'docker', imageDigest: digest, templateStore: resolve(root, 'runtime/template-store-v2'),
  user: `${uid}:${gid}`, limits: { pids: 256, memory: '2g', cpus: '2', timeoutMs: 180_000 },
})
const preflight = await builder.preflight()
if (preflight.state !== 'OK') throw new Error(preflight.message)

const criteriaFiles = (await readdir(criteriaDir)).filter(file => file.endsWith('.yml')).sort()
if (criteriaFiles.length < 18) throw new Error(`Golden set incompleto: ${criteriaFiles.length}/18 critérios.`)
const scratch = await mkdtemp(join(tmpdir(), 'dz23-golden-'))
const results: Array<{ id: string; category: string; state: GoldenState; critical: string; detail: string }> = []

try {
  for (const file of criteriaFiles) {
    const criterion = JSON.parse(await readFile(resolve(criteriaDir, file), 'utf8')) as Criterion
    const briefPath = resolve(briefsDir, `${criterion.id}.md`)
    const brief = await readFile(briefPath, 'utf8')
    if (brief.trim().length < 40 || criterion.acceptance.length < 3) throw new Error(`Fixture incompleta: ${criterion.id}`)
    if (!implemented.has(criterion.category)) {
      results.push({ id: criterion.id, category: criterion.category, state: 'NOT_IMPLEMENTED', critical: 'NOT_EXECUTED', detail: 'Categoria declarada, ainda sem executor.' })
      continue
    }

    const runDirectory = resolve(scratch, criterion.id)
    await cp(resolve(root, 'templates/nextjs-app@1'), runDirectory, { recursive: true })
    await mkdir(resolve(runDirectory, 'content'), { recursive: true })
    await mkdir(resolve(runDirectory, 'src/styles'), { recursive: true })
    await writeFile(resolve(runDirectory, 'src/styles/tokens.css'), ':root { --background: 0 0% 100%; --foreground: 222 47% 11%; --card: 0 0% 100%; --card-foreground: 222 47% 11%; --primary: 222 72% 32%; --primary-foreground: 0 0% 100%; --secondary: 214 32% 91%; --secondary-foreground: 222 47% 11%; --muted: 210 40% 96%; --muted-foreground: 215 16% 40%; --accent: 214 100% 93%; --accent-foreground: 222 72% 26%; --destructive: 0 72% 45%; --border: 214 32% 88%; --input: 214 32% 88%; --ring: 217 91% 50%; --radius: 0.75rem; --font-body: sans-serif; }\n')
    const title = criterion.category === 'catalog' ? 'Catálogo local' : criterion.category === 'form-database' ? 'Registros' : criterion.category === 'crud-panel' ? 'Painel de gestão' : 'Página de apresentação'
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
    const appSpec = dataSpec(criterion, brief)
    const component = appSpec === undefined
      ? `export default function GeneratedApp() {\n  return <main><h1>${title}</h1><p>${escapeJsx(description)}</p></main>\n}\n`
      : generatedDataView(appSpec, criterion.category)
    const findings = scanGeneratedContent({ 'content/app.json': content, 'src/GeneratedApp.tsx': component })
    if (findings.length > 0) throw new Error(`${criterion.id}: controle crítico recusou ${findings.join(', ')}`)
    await writeFile(resolve(runDirectory, 'content/app.json'), content)
    await writeFile(resolve(runDirectory, 'src/GeneratedApp.tsx'), component)
    if (appSpec !== undefined) {
      await writeDataLayer(runDirectory, generateDataLayer(appSpec))
      await writeAuthLayer(runDirectory, generateAuthLayer(appSpec, criterion.category))
      await writeFormLayer(runDirectory, generateFormLayer(appSpec, criterion.category))
      await writeCrudLayer(runDirectory, generateCrudLayer(appSpec, criterion.category))
      await writeAcceptanceArtifacts(runDirectory, appSpec, criterion.category)
    }
    for (const command of OFFLINE_PIPELINE_COMMANDS) {
      const result = await builder.execute(runDirectory, command)
      if (result.exitCode !== 0 || result.timedOut) throw new Error(`${criterion.id}: ${command} falhou.`)
    }
    results.push({
      id: criterion.id, category: criterion.category, state: 'PASS_DETERMINISTIC',
      critical: criterion.sensitive ? 'SENSITIVE_QUESTION_REQUIRED' : 'NO_SENSITIVE_DATA_DETECTED',
      detail: 'Build, teste unitário, Playwright, axe e scan passaram em contêiner sem rede.',
    })
  }
} finally {
  await rm(scratch, { recursive: true, force: true })
}

const stamp = new Date().toISOString().slice(0, 10)
await mkdir(reportsDir, { recursive: true })
const report = {
  schema_version: 1, generated_at: new Date().toISOString(), route: 'deterministic-fixture',
  real_llm: 'NOT_EXECUTED', promotion_eligible: false,
  counts: {
    total: results.length,
    pass_deterministic: results.filter(value => value.state === 'PASS_DETERMINISTIC').length,
    not_implemented: results.filter(value => value.state === 'NOT_IMPLEMENTED').length,
  },
  results,
}
await writeFile(resolve(reportsDir, `${stamp}-deterministic.json`), `${JSON.stringify(report, null, 2)}\n`)
await writeFile(resolve(reportsDir, `${stamp}-deterministic.md`), [
  '# Golden set — execução determinística', '',
  '- LLM real: **NOT_EXECUTED**', '- Elegível para promoção: **não**',
  `- Fixtures: ${report.counts.total}; executáveis: ${report.counts.pass_deterministic}; NOT_IMPLEMENTED: ${report.counts.not_implemented}.`,
  `- As ${report.counts.pass_deterministic} fixtures executáveis passaram por build, Vitest, Playwright, axe e scan dentro do contêiner sem rede.`,
  '', '| Brief | Categoria | Estado | Controle crítico |', '| --- | --- | --- | --- |',
  ...results.map(value => `| ${value.id} | ${value.category} | ${value.state} | ${value.critical} |`), '',
  'Este relatório não valida qualidade com modelo real e não promove o produto.', '',
].join('\n'))
process.stdout.write(`GOLDEN_SET=PASS_DETERMINISTIC total=${results.length} executable=${report.counts.pass_deterministic} real_llm=NOT_EXECUTED\n`)

function escapeJsx(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('{', '&#123;').replaceAll('}', '&#125;').replaceAll('`', "'")
}

function dataSpec(criterion: Criterion, brief: string): AppSpecV1 | undefined {
  if (criterion.category !== 'form-database' && criterion.category !== 'crud-panel') return undefined
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

function generatedDataView(spec: AppSpecV1, category: Criterion['category']): string {
  const entity = spec.entities.find(value => value.kind === 'database')!
  const symbol = pascal(dataIdentifier(entity.name))
  const component = category === 'crud-panel' ? `${symbol}Panel` : `${symbol}Manager`
  const path = category === 'crud-panel' ? `${dataIdentifier(entity.name)}-panel` : `${dataIdentifier(entity.name)}-manager`
  const labels = [spec.pages[0]!.name, ...spec.pages[0]!.sections, entity.name, ...entity.fields.map(field => field.name)]
  return `import ${component} from '@/src/components/generated/${path}'\n\nexport default function GeneratedApp(){return <main>${labels.map((label, index) => index === 0 ? `<h1>${escapeJsx(label)}</h1>` : `<p>${escapeJsx(label)}</p>`).join('')}<${component}/></main>}\n`
}

function pascal(value: string): string { return value.split('_').map(part => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join('') }

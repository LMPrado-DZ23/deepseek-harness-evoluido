import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { ContainerBuilder, OFFLINE_PIPELINE_COMMANDS } from '../plugins/prompt-to-app/src/runner.js'
import { scanGeneratedContent } from '../plugins/prompt-to-app/src/security.js'
import type { AppSpecV1 } from '../plugins/prompt-to-app/src/appspec.js'
import { generateDataLayer, writeDataLayer } from '../plugins/prompt-to-app/src/data-generator.js'
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
const implemented = new Set<Criterion['category']>(['landing-page', 'catalog', 'form-database'])
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
    if (!implemented.has(criterion.category) || (criterion.category === 'form-database' && criterion.sensitive)) {
      results.push({ id: criterion.id, category: criterion.category, state: 'NOT_IMPLEMENTED', critical: 'NOT_EXECUTED', detail: 'Categoria declarada, ainda sem executor.' })
      continue
    }

    const runDirectory = resolve(scratch, criterion.id)
    await cp(resolve(root, 'templates/nextjs-app@1'), runDirectory, { recursive: true })
    await mkdir(resolve(runDirectory, 'content'), { recursive: true })
    await mkdir(resolve(runDirectory, 'src/styles'), { recursive: true })
    await writeFile(resolve(runDirectory, 'src/styles/tokens.css'), ':root { --background: 0 0% 100%; --foreground: 222 47% 11%; --card: 0 0% 100%; --card-foreground: 222 47% 11%; --primary: 222 72% 32%; --primary-foreground: 0 0% 100%; --secondary: 214 32% 91%; --secondary-foreground: 222 47% 11%; --muted: 210 40% 96%; --muted-foreground: 215 16% 40%; --accent: 214 100% 93%; --accent-foreground: 222 72% 26%; --destructive: 0 72% 45%; --border: 214 32% 88%; --input: 214 32% 88%; --ring: 217 91% 50%; --radius: 0.75rem; --font-body: sans-serif; }\n')
    const title = criterion.category === 'catalog' ? 'Catálogo local' : criterion.category === 'form-database' ? 'Reservas' : 'Página de apresentação'
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
    const formSpec = criterion.category === 'form-database' ? formDatabaseSpec(criterion, brief) : undefined
    const component = formSpec === undefined
      ? `export default function GeneratedApp() {\n  return <main><h1>${title}</h1><p>${escapeJsx(description)}</p></main>\n}\n`
      : `import ReservaManager from '@/src/components/generated/reserva-manager'\n\nexport default function GeneratedApp() {\n  return <main><h1>Reservas</h1><p>Cadastro</p><p>Lista</p><ReservaManager /></main>\n}\n`
    const findings = scanGeneratedContent({ 'content/app.json': content, 'src/GeneratedApp.tsx': component })
    if (findings.length > 0) throw new Error(`${criterion.id}: controle crítico recusou ${findings.join(', ')}`)
    await writeFile(resolve(runDirectory, 'content/app.json'), content)
    await writeFile(resolve(runDirectory, 'src/GeneratedApp.tsx'), component)
    if (formSpec !== undefined) {
      await writeDataLayer(runDirectory, generateDataLayer(formSpec))
      await writeFormLayer(runDirectory, generateFormLayer(formSpec, 'form-database'))
      await writeAcceptanceArtifacts(runDirectory, formSpec, 'form-database')
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

function formDatabaseSpec(criterion: Criterion, brief: string): AppSpecV1 {
  return {
    schema_version: 1, problem: brief.trim(), audience: 'Clientes e equipe da pequena empresa', journeys: ['Cadastrar e consultar reservas'],
    pages: [{ name: 'Reservas', sections: ['Cadastro', 'Lista'] }],
    entities: [{
      name: 'Reserva', kind: 'database', sensitive: false,
      fields: [{ name: 'Nome', type: 'text', required: true }, { name: 'Data', type: 'date', required: true }, { name: 'Horário', type: 'text', required: true }],
    }],
    sensitive_data: { detected: [], confirmed_by_user: false },
    accessibility: { wcag_level: 'AA', keyboard_required: true, reduced_motion: true }, language: 'pt-BR',
    acceptance_criteria: [...criterion.acceptance],
  }
}

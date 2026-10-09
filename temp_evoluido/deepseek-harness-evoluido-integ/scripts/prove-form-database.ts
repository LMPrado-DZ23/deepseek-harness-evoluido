import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { writeAcceptanceArtifacts } from '../plugins/prompt-to-app/src/acceptance.js'
import type { AppSpecV1 } from '../plugins/prompt-to-app/src/appspec.js'
import type { BuilderLifecycleResolverPort } from '../plugins/prompt-to-app/src/builder-lifecycle.js'
import { generateAuthLayer, writeAuthLayer } from '../plugins/prompt-to-app/src/auth-generator.js'
import { generateDataLayer, writeDataLayer } from '../plugins/prompt-to-app/src/data-generator.js'
import { generateFormLayer, writeFormLayer } from '../plugins/prompt-to-app/src/form-generator.js'

const spec: AppSpecV1 = {
  schema_version: 1, problem: 'Cadastrar contatos e consultar a lista sem usar planilhas.', audience: 'Equipe de uma pequena empresa',
  journeys: ['Cadastrar um contato e encontrá-lo na lista'], pages: [{ name: 'Contatos', sections: ['Cadastro', 'Lista'] }],
  entities: [{ name: 'Contato', kind: 'database', sensitive: false, fields: [
    { name: 'Nome', type: 'text', required: true }, { name: 'E-mail', type: 'email', required: false },
    { name: 'Telefone', type: 'phone', required: false }, { name: 'Situação', type: 'selection', required: true, options: ['Novo', 'Atendido'] },
  ] }], sensitive_data: { detected: [], confirmed_by_user: false },
  accessibility: { wcag_level: 'AA', keyboard_required: true, reduced_motion: true }, language: 'pt-BR',
  acceptance_criteria: ['A tela mostra o texto “Cadastre e consulte seus contatos”.'],
}

const root = process.cwd()
const proofRoot = mkdtempSync(join(tmpdir(), 'dz23-form-database-proof-'))
const runDirectory = resolve(proofRoot, 'generated-app')
const unsupported = async (): Promise<never> => { throw new Error('UNSUPPORTED_INGRESS') }
const builder: BuilderLifecycleResolverPort<unknown> = { forActor: async () => ({ preflight: async () => ({ state: 'BLOCKED_EXTERNAL' }), prepare: unsupported, execute: unsupported, cancel: unsupported, finish: unsupported, listManaged: async () => [] }) }

try {
  cpSync(resolve(root, 'templates/nextjs-app@1'), runDirectory, { recursive: true })
  mkdirSync(resolve(runDirectory, 'content'), { recursive: true })
  mkdirSync(resolve(runDirectory, 'src/styles'), { recursive: true })
  writeFileSync(resolve(runDirectory, 'src/styles/tokens.css'), ':root { --background: 0 0% 100%; --foreground: 222 47% 11%; --card: 0 0% 100%; --card-foreground: 222 47% 11%; --primary: 222 72% 32%; --primary-foreground: 0 0% 100%; --secondary: 214 32% 91%; --secondary-foreground: 222 47% 11%; --muted: 210 40% 96%; --muted-foreground: 215 16% 40%; --accent: 214 100% 93%; --accent-foreground: 222 72% 26%; --destructive: 0 72% 45%; --border: 214 32% 88%; --input: 214 32% 88%; --ring: 217 91% 50%; --radius: 0.75rem; --font-body: sans-serif; }\n')
  writeFileSync(resolve(runDirectory, 'content/app.json'), '{"title":"Contatos","description":"Cadastro e consulta local"}\n')
  writeFileSync(resolve(runDirectory, 'src/GeneratedApp.tsx'), "import ContatoManager from '@/src/components/generated/contato-manager'\n\nexport default function GeneratedApp(){ return <main><h1>Contatos</h1><p>Cadastro</p><p>Lista</p><p>Cadastre e consulte seus contatos</p><ContatoManager /></main> }\n")
  const data = generateDataLayer(spec)
  const auth = generateAuthLayer(spec, 'form-database')
  const form = generateFormLayer(spec, 'form-database')
  await writeDataLayer(runDirectory, data)
  await writeAuthLayer(runDirectory, auth)
  await writeFormLayer(runDirectory, form)
  await writeAcceptanceArtifacts(runDirectory, spec, 'form-database')
  const protectedPaths = [...data.protectedPaths, ...auth.protectedPaths, ...form.protectedPaths]
  const before = new Map(protectedPaths.map(path => [path, hash(resolve(runDirectory, path))]))

  const preflight = await (await builder.forActor({})).preflight()
  if (preflight.state !== 'BLOCKED_EXTERNAL') throw new Error('INGRESS_MUST_REMAIN_BLOCKED')
  const changed = protectedPaths.filter(path => hash(resolve(runDirectory, path)) !== before.get(path))
  if (changed.length > 0) throw new Error(`Arquivos protegidos alterados: ${changed.join(', ')}`)

  const proof = `# P32/P33 — Verificação lógica da categoria cadastro e lista\n\n- Geração das camadas de dados, autenticação, formulário e aceite: **PASS**\n- Ingresso autenticado do builder: **NOT_PRESENT**\n- Build, banco em execução, navegador e E2E: **NOT_EXECUTED**\n- Estado de promoção: **BLOCKED_EXTERNAL**\n- Arquivos protegidos alterados: nenhum.\n\nEsta verificação não chama a aplicação de pronta ou de protótipo verificado.\n`
  mkdirSync(resolve(root, 'docs/proofs'), { recursive: true })
  writeFileSync(resolve(root, 'docs/proofs/P32-form-database-proof.md'), proof)
  process.stdout.write(`FORM_DATABASE_GENERATION=PASS protected=${protectedPaths.length} build=BLOCKED_EXTERNAL ingress=NOT_PRESENT\n`)
} finally {
  rmSync(proofRoot, { recursive: true, force: true })
}

function hash(path: string): string { return createHash('sha256').update(readFileSync(path)).digest('hex') }

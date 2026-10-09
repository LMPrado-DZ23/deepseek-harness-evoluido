import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { writeAcceptanceArtifacts } from '../plugins/prompt-to-app/src/acceptance.js'
import type { AppSpecV1 } from '../plugins/prompt-to-app/src/appspec.js'
import type { BuilderLifecycleResolverPort } from '../plugins/prompt-to-app/src/builder-lifecycle.js'
import { generateAuthLayer, writeAuthLayer } from '../plugins/prompt-to-app/src/auth-generator.js'
import { generateCrudLayer, writeCrudLayer } from '../plugins/prompt-to-app/src/crud-generator.js'
import { generateDataLayer, writeDataLayer } from '../plugins/prompt-to-app/src/data-generator.js'

const spec: AppSpecV1 = {
  schema_version: 1,
  problem: 'Organizar clientes sem depender de planilhas.',
  audience: 'Equipe de uma pequena empresa',
  journeys: ['Entrar por código e gerenciar clientes'],
  pages: [{ name: 'Clientes', sections: ['Novo cadastro', 'Cadastros'] }],
  entities: [{
    name: 'Cliente', kind: 'database', sensitive: false,
    fields: [
      { name: 'Nome', type: 'text', required: true },
      { name: 'E-mail', type: 'email', required: false },
      { name: 'Situação', type: 'selection', required: true, options: ['Novo', 'Atendido'] },
    ],
  }],
  sensitive_data: { detected: [], confirmed_by_user: false },
  accessibility: { wcag_level: 'AA', keyboard_required: true, reduced_motion: true },
  language: 'pt-BR',
  acceptance_criteria: ['A equipe consegue criar, editar e excluir um cliente depois de entrar.'],
}

const root = process.cwd()
const proofRoot = mkdtempSync(join(tmpdir(), 'dz23-auth-crud-proof-'))
const runDirectory = resolve(proofRoot, 'generated-app')
const unsupported = async (): Promise<never> => { throw new Error('UNSUPPORTED_INGRESS') }
const builder: BuilderLifecycleResolverPort<unknown> = { forActor: async () => ({ preflight: async () => ({ state: 'BLOCKED_EXTERNAL' }), prepare: unsupported, execute: unsupported, cancel: unsupported, finish: unsupported, listManaged: async () => [] }) }

try {
  cpSync(resolve(root, 'templates/nextjs-app@1'), runDirectory, { recursive: true })
  mkdirSync(resolve(runDirectory, 'content'), { recursive: true })
  mkdirSync(resolve(runDirectory, 'src/styles'), { recursive: true })
  writeFileSync(resolve(runDirectory, 'src/styles/tokens.css'), ':root { --background: 0 0% 100%; --foreground: 222 47% 11%; --card: 0 0% 100%; --card-foreground: 222 47% 11%; --primary: 222 72% 32%; --primary-foreground: 0 0% 100%; --secondary: 214 32% 91%; --secondary-foreground: 222 47% 11%; --muted: 210 40% 96%; --muted-foreground: 215 16% 40%; --accent: 214 100% 93%; --accent-foreground: 222 72% 26%; --destructive: 0 72% 45%; --border: 214 32% 88%; --input: 214 32% 88%; --ring: 217 91% 50%; --radius: 0.75rem; --font-body: sans-serif; }\n')
  writeFileSync(resolve(runDirectory, 'content/app.json'), '{"title":"Clientes","description":"Gestão protegida por código de acesso"}\n')
  writeFileSync(resolve(runDirectory, 'src/GeneratedApp.tsx'), "import ClientePanel from '@/src/components/generated/cliente-panel'\n\nexport default function GeneratedApp(){ return <main><h1>Clientes</h1><p>Cliente</p><p>Novo cadastro</p><p>Cadastros</p><ClientePanel /></main> }\n")

  const data = generateDataLayer(spec)
  const auth = generateAuthLayer(spec, 'crud-panel')
  const crud = generateCrudLayer(spec, 'crud-panel')
  await writeDataLayer(runDirectory, data)
  await writeAuthLayer(runDirectory, auth)
  await writeCrudLayer(runDirectory, crud)
  await writeAcceptanceArtifacts(runDirectory, spec, 'crud-panel')
  const protectedPaths = [...data.protectedPaths, ...auth.protectedPaths, ...crud.protectedPaths]
  const before = new Map(protectedPaths.map(path => [path, hash(resolve(runDirectory, path))]))

  const preflight = await (await builder.forActor({})).preflight()
  if (preflight.state !== 'BLOCKED_EXTERNAL') throw new Error('INGRESS_MUST_REMAIN_BLOCKED')
  const changed = protectedPaths.filter(path => hash(resolve(runDirectory, path)) !== before.get(path))
  if (changed.length > 0) throw new Error(`Arquivos protegidos alterados: ${changed.join(', ')}`)
  const proof = `# P32/P33 — Verificação lógica de acesso e painel CRUD\n\n- Geração das camadas de dados, autenticação, CRUD e aceite: **PASS**\n- Ingresso autenticado do builder: **NOT_PRESENT**\n- Build, Docker, login real, banco em execução e E2E: **NOT_EXECUTED**\n- Estado de promoção: **BLOCKED_EXTERNAL**\n- Arquivos protegidos alterados: nenhum.\n\nEsta verificação não chama a aplicação de pronta ou de protótipo verificado.\n`
  mkdirSync(resolve(root, 'docs/proofs'), { recursive: true })
  writeFileSync(resolve(root, 'docs/proofs/P32-auth-crud-proof.md'), proof)
  process.stdout.write(`AUTH_CRUD_GENERATION=PASS protected=${protectedPaths.length} build=BLOCKED_EXTERNAL ingress=NOT_PRESENT\n`)
} finally {
  rmSync(proofRoot, { recursive: true, force: true })
}

function hash(path: string): string { return createHash('sha256').update(readFileSync(path)).digest('hex') }

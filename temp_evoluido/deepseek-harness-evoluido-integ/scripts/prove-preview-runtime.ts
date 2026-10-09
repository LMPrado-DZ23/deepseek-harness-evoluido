import { randomUUID } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { writeAcceptanceArtifacts } from '../plugins/prompt-to-app/src/acceptance.js'
import type { AppSpecV1 } from '../plugins/prompt-to-app/src/appspec.js'
import { generateAuthLayer, writeAuthLayer } from '../plugins/prompt-to-app/src/auth-generator.js'
import type { BuilderLifecycleResolverPort } from '../plugins/prompt-to-app/src/builder-lifecycle.js'
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
const proofRoot = mkdtempSync(join(tmpdir(), 'dz23-preview-logic-proof-'))
const runDirectory = resolve(proofRoot, `generated-${randomUUID()}`)
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

try {
  await prepareGeneratedApp()
  const lifecycle = await builder.forActor({})
  const preflight = await lifecycle.preflight()
  if (preflight.state !== 'BLOCKED_EXTERNAL') throw new Error('INGRESS_MUST_REMAIN_BLOCKED')

  const proof = {
    result: 'BLOCKED_EXTERNAL',
    logical_generation: 'PASS',
    authenticated_builder_ingress: 'NOT_PRESENT',
    build: 'NOT_EXECUTED',
    acceptance_attestation: 'NOT_PRESENT',
    artifact_export: 'NOT_EXECUTED',
    preview_runtime: 'NOT_EXECUTED',
    promotion_eligible: false,
  }
  mkdirSync(resolve(root, 'runtime-artifacts'), { recursive: true, mode: 0o700 })
  writeFileSync(resolve(root, 'runtime-artifacts/P34-M1-runtime-proof.json'), `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 })
  process.stdout.write('PREVIEW_RUNTIME_PROOF=BLOCKED_EXTERNAL ingress=NOT_PRESENT build=NOT_EXECUTED preview=NOT_EXECUTED\n')
} finally {
  rmSync(proofRoot, { recursive: true, force: true })
}

async function prepareGeneratedApp(): Promise<void> {
  cpSync(resolve(root, 'templates/nextjs-app@1'), runDirectory, { recursive: true })
  mkdirSync(resolve(runDirectory, 'content'), { recursive: true })
  mkdirSync(resolve(runDirectory, 'src/styles'), { recursive: true })
  writeFileSync(resolve(runDirectory, 'src/styles/tokens.css'), ':root { --background: 0 0% 100%; --foreground: 222 47% 11%; --card: 0 0% 100%; --card-foreground: 222 47% 11%; --primary: 222 72% 32%; --primary-foreground: 0 0% 100%; --secondary: 214 32% 91%; --secondary-foreground: 222 47% 11%; --muted: 210 40% 96%; --muted-foreground: 215 16% 40%; --accent: 214 100% 93%; --accent-foreground: 222 72% 26%; --destructive: 0 72% 45%; --border: 214 32% 88%; --input: 214 32% 88%; --ring: 217 91% 50%; --radius: 0.75rem; }\n')
  writeFileSync(resolve(runDirectory, 'content/app.json'), '{"title":"Clientes","description":"Gestão protegida por código de acesso"}\n')
  writeFileSync(resolve(runDirectory, 'src/GeneratedApp.tsx'), "import ClientePanel from '@/src/components/generated/cliente-panel'\nexport default function GeneratedApp(){return <main><h1>Clientes</h1><p>Cliente</p><p>Novo cadastro</p><p>Cadastros</p><ClientePanel /></main>}\n")
  await writeDataLayer(runDirectory, generateDataLayer(spec))
  await writeAuthLayer(runDirectory, generateAuthLayer(spec, 'crud-panel'))
  await writeCrudLayer(runDirectory, generateCrudLayer(spec, 'crud-panel'))
  await writeAcceptanceArtifacts(runDirectory, spec, 'crud-panel')
}

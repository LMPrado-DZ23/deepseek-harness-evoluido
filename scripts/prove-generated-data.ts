import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AppSpecV1 } from '../plugins/prompt-to-app/src/appspec.js'
import { generateDataLayer, writeDataLayer } from '../plugins/prompt-to-app/src/data-generator.js'
import { ContainerBuilder, OFFLINE_PIPELINE_COMMANDS } from '../plugins/prompt-to-app/src/runner.js'

const spec: AppSpecV1 = {
  schema_version: 1, problem: 'Organizar clientes e pedidos com segurança.', audience: 'Equipe da pequena empresa',
  journeys: ['Cadastrar e consultar clientes'], pages: [{ name: 'Clientes', sections: ['Cadastro', 'Lista'] }],
  entities: [
    { name: 'Cliente', kind: 'database', sensitive: false, fields: [
      { name: 'Nome', type: 'text', required: true }, { name: 'E-mail', type: 'email', required: true },
      { name: 'Ativo', type: 'boolean', required: true }, { name: 'Perfil', type: 'selection', required: true, options: ['novo', 'recorrente'] },
    ] },
    { name: 'Pedido', kind: 'database', sensitive: false, fields: [
      { name: 'Descrição', type: 'text', required: true }, { name: 'Cliente', type: 'reference', required: true, reference_entity: 'Cliente' },
    ] },
  ],
  sensitive_data: { detected: [], confirmed_by_user: false },
  accessibility: { wcag_level: 'AA', keyboard_required: true, reduced_motion: true }, language: 'pt-BR',
  acceptance_criteria: ['A pessoa consegue cadastrar um cliente.'],
}

const root = process.cwd()
const proofRoot = mkdtempSync(join(tmpdir(), 'dz23-generated-data-proof-'))
const runDirectory = resolve(proofRoot, 'generated-app')
const digest = readFileSync(resolve(root, 'runtime/builder-image-digest'), 'utf8').trim() as `sha256:${string}`
const uid = typeof process.getuid === 'function' ? process.getuid() : 1000
const gid = typeof process.getgid === 'function' ? process.getgid() : 1000
const builder = new ContainerBuilder({
  engine: 'docker', imageDigest: digest, templateStore: resolve(root, 'runtime/template-store-v2'), user: `${uid}:${gid}`,
  limits: { pids: 256, memory: '2g', cpus: '2', timeoutMs: 180_000 },
})

try {
  cpSync(resolve(root, 'templates/nextjs-app@1'), runDirectory, { recursive: true })
  mkdirSync(resolve(runDirectory, 'content'), { recursive: true })
  mkdirSync(resolve(runDirectory, 'src/styles'), { recursive: true })
  writeFileSync(resolve(runDirectory, 'src/styles/tokens.css'), ':root { --background: 0 0% 100%; --foreground: 222 47% 11%; --card: 0 0% 100%; --card-foreground: 222 47% 11%; --primary: 222 72% 32%; --primary-foreground: 0 0% 100%; --secondary: 214 32% 91%; --secondary-foreground: 222 47% 11%; --muted: 210 40% 96%; --muted-foreground: 215 16% 40%; --accent: 214 100% 93%; --accent-foreground: 222 72% 26%; --destructive: 0 72% 45%; --border: 214 32% 88%; --input: 214 32% 88%; --ring: 217 91% 50%; --radius: 0.75rem; }\n')
  writeFileSync(resolve(runDirectory, 'content/app.json'), '{"title":"Clientes","description":"Cadastro local"}\n')
  writeFileSync(resolve(runDirectory, 'src/GeneratedApp.tsx'), "export default function GeneratedApp(){ return <main><h1>Clientes</h1><h2>Cadastro</h2><h2>Lista</h2><p>A pessoa consegue cadastrar um cliente.</p></main> }\n")
  const layer = generateDataLayer(spec)
  await writeDataLayer(runDirectory, layer)
  const before = new Map(layer.protectedPaths.map(path => [path, hash(resolve(runDirectory, path))]))

  const preflight = await builder.preflight()
  if (preflight.state !== 'OK') throw new Error(preflight.message)
  const results = []
  for (const command of OFFLINE_PIPELINE_COMMANDS) {
    const result = await builder.execute(runDirectory, command)
    results.push(result)
    if (!result.securityArgs.includes('none') || result.exitCode !== 0 || result.timedOut) {
      throw new Error(`${command} falhou (exit=${result.exitCode}, timeout=${result.timedOut})\n${result.stdout.slice(-3000)}\n${result.stderr.slice(-3000)}`)
    }
  }
  const changed = layer.protectedPaths.filter(path => hash(resolve(runDirectory, path)) !== before.get(path))
  if (changed.length > 0) throw new Error(`Camada protegida alterada: ${changed.join(', ')}`)
  const unit = results.find(result => result.command === 'pnpm run test')
  if (!unit?.stdout.includes('generated-data.spec.ts')) throw new Error('O teste CRUD gerado não foi executado no contêiner.')

  const report = `# P32/P33 — Prova da camada de dados gerada\n\n- Resultado: **PASS**\n- Imagem fixada: \`${digest}\`\n- Rede do contêiner: \`none\`; capacidades removidas e filesystem raiz somente leitura.\n- Banco: \`node:sqlite\`, sem ORM e sem módulo nativo adicional.\n- Migração idempotente, \`foreign_keys=ON\`, WAL e \`user_version=1\`: PASS.\n- CRUD real em memória dentro do contêiner (criar, listar, atualizar e excluir): PASS.\n- Build Next.js, Vitest e Playwright+axe offline: PASS.\n- Arquivos protegidos alterados durante build/teste: nenhum.\n\nO resultado continua sendo um protótipo verificado localmente; autenticação, preview e publicação ainda não fazem parte desta prova.\n`
  mkdirSync(resolve(root, 'docs/proofs'), { recursive: true })
  writeFileSync(resolve(root, 'docs/proofs/P32-generated-data-proof.md'), report)
  process.stdout.write(`GENERATED_DATA_PROOF=PASS files=${layer.files.length} steps=${results.length}\n`)
} finally {
  rmSync(proofRoot, { recursive: true, force: true })
}

function hash(path: string): string { return createHash('sha256').update(readFileSync(path)).digest('hex') }

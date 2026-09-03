import { createHash, randomUUID } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { writeAcceptanceArtifacts } from '../plugins/prompt-to-app/src/acceptance.js'
import type { AppSpecV1 } from '../plugins/prompt-to-app/src/appspec.js'
import { generateAuthLayer, writeAuthLayer } from '../plugins/prompt-to-app/src/auth-generator.js'
import { generateCrudLayer, writeCrudLayer } from '../plugins/prompt-to-app/src/crud-generator.js'
import { generateDataLayer, writeDataLayer } from '../plugins/prompt-to-app/src/data-generator.js'
import { ContainerBuilder, OFFLINE_PIPELINE_COMMANDS } from '../plugins/prompt-to-app/src/runner.js'

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

  const preflight = await builder.preflight()
  if (preflight.state !== 'OK') throw new Error(preflight.message)
  const isolation = await builder.execute(runDirectory, "node -e \"fetch('http://example.com').then(()=>process.exit(9)).catch(()=>process.stdout.write('NETWORK_BLOCKED'))\"")
  if (isolation.exitCode !== 0 || !isolation.stdout.includes('NETWORK_BLOCKED') || !hasIsolatedNetwork(isolation.securityArgs)) {
    throw new Error(`A prova negativa de rede falhou: ${isolation.stdout} ${isolation.stderr}`)
  }
  const inspectedMode = inspectDisposableNetworkMode(digest)
  if (inspectedMode !== 'none') throw new Error(`Docker NetworkMode inesperado: ${inspectedMode}`)

  const results = []
  for (const command of OFFLINE_PIPELINE_COMMANDS) {
    const result = await builder.execute(runDirectory, command)
    results.push(result)
    if (!hasIsolatedNetwork(result.securityArgs) || result.exitCode !== 0 || result.timedOut) {
      throw new Error(`${command} falhou (exit=${result.exitCode}, timeout=${result.timedOut})\n${result.stdout.slice(-8000)}\n${result.stderr.slice(-8000)}`)
    }
  }
  const changed = protectedPaths.filter(path => hash(resolve(runDirectory, path)) !== before.get(path))
  if (changed.length > 0) throw new Error(`Arquivos protegidos alterados: ${changed.join(', ')}`)
  const report = JSON.parse(readFileSync(resolve(runDirectory, 'evidence/appspec-report.json'), 'utf8')) as { checks: Array<{ kind: string; status: string }> }
  for (const kind of ['auth', 'crud']) {
    if (!report.checks.some(check => check.kind === kind && check.status === 'PASSED')) throw new Error(`Aceite ${kind} não passou.`)
  }
  if (!readFileSync(resolve(runDirectory, 'data/app.sqlite')).byteLength) throw new Error('O banco em arquivo não foi criado.')
  if (process.platform !== 'win32' && (statSync(resolve(runDirectory, 'data/app.sqlite')).mode & 0o777) !== 0o600) throw new Error('O banco não ficou restrito ao usuário do processo.')
  const captures = JSON.parse(readFileSync(resolve(runDirectory, 'data/studio-capture.json'), 'utf8')) as Array<{ kind: string }>
  if (!captures.some(capture => capture.kind === 'code')) throw new Error('O canal de código de desenvolvimento não foi exercitado.')

  const proof = `# P32/P33 — Prova de acesso e painel CRUD\n\n- Resultado: **PASS**\n- Imagem fixada: \`${digest}\`\n- \`docker inspect\`: \`HostConfig.NetworkMode=none\`.\n- Tentativa de conexão externa dentro do contêiner: bloqueada.\n- Login: código de 6 dígitos capturado pelo canal local de desenvolvimento; sessão real em SQLite.\n- Rota \`/api/auth/session\`: 401 sem sessão e 200 após autenticação.\n- Fluxo real no navegador: login → listar → criar → editar → excluir com confirmação: PASS.\n- Vitest cobre sessão válida, expirada e revogada, CSRF ausente, cinco tentativas e recusa de captura em produção.\n- Build Next.js, testes, Playwright, acessibilidade e scan: PASS em contêiner sem rede.\n- SQLite restrito a modo \`0600\` no Linux.\n- Arquivos de banco, autenticação e CRUD alterados durante build/teste: nenhum.\n\nO modo \`studio-capture\` é somente para verificar o protótipo e é recusado em produção. Não houve preview remoto, publicação ou modelo real.\n`
  mkdirSync(resolve(root, 'docs/proofs'), { recursive: true })
  writeFileSync(resolve(root, 'docs/proofs/P32-auth-crud-proof.md'), proof)
  process.stdout.write(`AUTH_CRUD_PROOF=PASS protected=${protectedPaths.length} checks=${report.checks.length} steps=${results.length} network=${inspectedMode}\n`)
} finally {
  rmSync(proofRoot, { recursive: true, force: true })
}

function hasIsolatedNetwork(args: readonly string[]): boolean {
  const index = args.indexOf('--network')
  return index >= 0 && args[index + 1] === 'none' && args.includes('--cap-drop') && args.includes('ALL') && args.includes('no-new-privileges')
}

function inspectDisposableNetworkMode(image: string): string {
  const name = `dz23-network-proof-${randomUUID()}`
  let created = false
  try {
    execFileSync('docker', ['create', '--name', name, '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', image, 'node', '-e', 'process.exit(0)'], { stdio: 'pipe' })
    created = true
    return execFileSync('docker', ['inspect', name, '--format', '{{.HostConfig.NetworkMode}}'], { encoding: 'utf8' }).trim()
  } finally {
    if (created) spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' })
  }
}

function hash(path: string): string { return createHash('sha256').update(readFileSync(path)).digest('hex') }

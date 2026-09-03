import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { writeAcceptanceArtifacts } from '../plugins/prompt-to-app/src/acceptance.js'
import type { AppSpecV1 } from '../plugins/prompt-to-app/src/appspec.js'
import { generateAuthLayer, writeAuthLayer } from '../plugins/prompt-to-app/src/auth-generator.js'
import { generateDataLayer, writeDataLayer } from '../plugins/prompt-to-app/src/data-generator.js'
import { generateFormLayer, writeFormLayer } from '../plugins/prompt-to-app/src/form-generator.js'
import { ContainerBuilder, OFFLINE_PIPELINE_COMMANDS } from '../plugins/prompt-to-app/src/runner.js'

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

  const preflight = await builder.preflight()
  if (preflight.state !== 'OK') throw new Error(preflight.message)
  const results = []
  for (const command of OFFLINE_PIPELINE_COMMANDS) {
    const result = await builder.execute(runDirectory, command)
    results.push(result)
    if (!hasIsolatedNetwork(result.securityArgs) || result.exitCode !== 0 || result.timedOut) {
      throw new Error(`${command} falhou (exit=${result.exitCode}, timeout=${result.timedOut})\n${result.stdout.slice(-5000)}\n${result.stderr.slice(-5000)}`)
    }
  }
  const changed = protectedPaths.filter(path => hash(resolve(runDirectory, path)) !== before.get(path))
  if (changed.length > 0) throw new Error(`Arquivos protegidos alterados: ${changed.join(', ')}`)
  const report = JSON.parse(readFileSync(resolve(runDirectory, 'evidence/appspec-report.json'), 'utf8')) as { checks: Array<{ kind: string; status: string }> }
  const flow = report.checks.find(check => check.kind === 'flow')
  if (flow?.status !== 'PASSED') throw new Error('O fluxo preencher, salvar e listar não passou no navegador.')
  if (!readFileSync(resolve(runDirectory, 'data/app.sqlite')).byteLength) throw new Error('O banco em arquivo não foi criado.')
  if (process.platform !== 'win32' && (statSync(resolve(runDirectory, 'data/app.sqlite')).mode & 0o777) !== 0o600) throw new Error('O banco não ficou restrito ao usuário do processo.')

  const proof = `# P32/P33 — Prova da categoria cadastro e lista\n\n- Resultado: **PASS**\n- Imagem fixada: \`${digest}\`\n- Rede do contêiner: \`none\`; capacidades removidas e filesystem raiz somente leitura.\n- Fluxo real no navegador: preencher anonimamente → lista ausente para visitante → entrar como proprietário → registro aparece na lista: PASS.\n- Banco: arquivo \`data/app.sqlite\` criado pela aplicação gerada, restrito a modo \`0600\` no Linux; migração e repositório protegidos pelo Studio.\n- Build Next.js, Vitest, Playwright, acessibilidade e scan offline: PASS.\n- Arquivos protegidos alterados durante build/teste: nenhum.\n- Dados sensíveis confirmados exigem autenticação também no envio; esta prova usa dados comuns com envio público e leitura privada.\n\nO resultado é um protótipo local verificado. Não houve preview remoto, publicação ou modelo real.\n`
  mkdirSync(resolve(root, 'docs/proofs'), { recursive: true })
  writeFileSync(resolve(root, 'docs/proofs/P32-form-database-proof.md'), proof)
  process.stdout.write(`FORM_DATABASE_PROOF=PASS protected=${protectedPaths.length} checks=${report.checks.length} steps=${results.length}\n`)
} finally {
  rmSync(proofRoot, { recursive: true, force: true })
}

function hasIsolatedNetwork(args: readonly string[]): boolean {
  const index = args.indexOf('--network')
  return index >= 0 && args[index + 1] === 'none' && args.includes('--cap-drop') && args.includes('ALL')
}
function hash(path: string): string { return createHash('sha256').update(readFileSync(path)).digest('hex') }

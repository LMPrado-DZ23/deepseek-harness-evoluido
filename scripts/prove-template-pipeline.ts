import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ContainerBuilder, OFFLINE_PIPELINE_COMMANDS } from '../plugins/prompt-to-app/src/runner.js'

const root = process.cwd()
const proofRoot = mkdtempSync(join(tmpdir(), 'dz23-template-proof-'))
const runDirectory = resolve(proofRoot, 'generated-app')
const digest = readFileSync(resolve(root, 'runtime/builder-image-digest'), 'utf8').trim() as `sha256:${string}`
const uid = typeof process.getuid === 'function' ? process.getuid() : 1000
const gid = typeof process.getgid === 'function' ? process.getgid() : 1000
const builder = new ContainerBuilder({
  engine: 'docker', imageDigest: digest,
  templateStore: resolve(root, 'runtime/template-store-v1'), user: `${uid}:${gid}`,
  limits: { pids: 256, memory: '2g', cpus: '2', timeoutMs: 180_000 },
})

try {
  cpSync(resolve(root, 'templates/static-site@1'), runDirectory, { recursive: true })
  mkdirSync(resolve(runDirectory, 'content'), { recursive: true })
  writeFileSync(resolve(runDirectory, 'content/app.json'), JSON.stringify({
    title: 'Ateliê Aurora', description: 'Uma apresentação local e acessível dos serviços do ateliê.',
  }, null, 2))
  writeFileSync(resolve(runDirectory, 'src/GeneratedApp.tsx'), `export default function GeneratedApp() {
  return <main><h1>Ateliê Aurora</h1><p>Conheça nossos serviços e fale com a equipe.</p></main>
}
`)

  const preflight = await builder.preflight()
  if (preflight.state !== 'OK') throw new Error(preflight.message)
  const results = []
  for (const command of OFFLINE_PIPELINE_COMMANDS) {
    const result = await builder.execute(runDirectory, command)
    results.push(result)
    if (result.exitCode !== 0 || result.timedOut) {
      throw new Error(`${command} falhou (exit=${result.exitCode}, timeout=${result.timedOut})\n${result.stdout.slice(-2000)}\n${result.stderr.slice(-2000)}`)
    }
  }

  const report = `# P32 — Prova executável do template v1\n\n` +
    `- Resultado: **PASS**\n` +
    `- Imagem fixada: \`${digest}\`\n` +
    `- Instalação: offline, lockfile congelado e scripts de pacote desativados.\n` +
    `- Build: PASS\n- Teste unitário: PASS\n- E2E Playwright + axe: PASS\n` +
    `- Execuções: ${results.map(result => `\`${result.command}\` → exit ${result.exitCode}`).join('; ')}.\n` +
    `- Isolamento: todos os comandos foram emitidos pelo \`ContainerBuilder\` com rede desativada e limites de recursos.\n\n` +
    `O artefato é somente um protótipo verificado dentro do contêiner; não houve preview público nem deploy.\n`
  mkdirSync(resolve(root, 'docs/proofs'), { recursive: true })
  writeFileSync(resolve(root, 'docs/proofs/P32-template-pipeline-proof.md'), report)
  process.stdout.write('TEMPLATE_PIPELINE_PROOF=PASS steps=4\n')
} finally {
  if (proofRoot.startsWith(`${resolve(tmpdir())}/`) || proofRoot.startsWith(`${resolve(tmpdir())}\\`)) rmSync(proofRoot, { recursive: true, force: true })
}

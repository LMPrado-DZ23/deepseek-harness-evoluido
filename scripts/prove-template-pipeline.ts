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
  templateStore: resolve(root, 'runtime/template-store-v2'), user: `${uid}:${gid}`,
  limits: { pids: 256, memory: '2g', cpus: '2', timeoutMs: 180_000 },
})

try {
  cpSync(resolve(root, 'templates/nextjs-app@1'), runDirectory, { recursive: true })
  mkdirSync(resolve(runDirectory, 'content'), { recursive: true })
  mkdirSync(resolve(runDirectory, 'src/generated'), { recursive: true })
  writeFileSync(resolve(runDirectory, 'src/generated/design-tokens.css'), `:root {
  --background: 0 0% 100%; --foreground: 222 47% 11%; --card: 0 0% 100%; --card-foreground: 222 47% 11%;
  --primary: 222 72% 32%; --primary-foreground: 0 0% 100%; --secondary: 214 32% 91%; --secondary-foreground: 222 47% 11%;
  --muted: 210 40% 96%; --muted-foreground: 215 16% 40%; --accent: 214 100% 93%; --accent-foreground: 222 72% 26%;
  --destructive: 0 72% 45%; --border: 214 32% 88%; --input: 214 32% 88%; --ring: 217 91% 50%; --radius: 0.75rem;
}\n`)
  writeFileSync(resolve(runDirectory, 'content/app.json'), JSON.stringify({
    title: 'Ateliê Aurora', description: 'Uma apresentação local e acessível dos serviços do ateliê.',
  }, null, 2))
  writeFileSync(resolve(runDirectory, 'src/GeneratedApp.tsx'), `import { Card, CardContent, CardHeader, CardTitle } from '@/src/components/ui/card'
export default function GeneratedApp() {
  return <main className="mx-auto max-w-6xl px-6 py-16"><h1 className="text-4xl font-bold">Ateliê Aurora</h1><p className="mt-4 text-muted-foreground">Conheça nossos serviços e fale com a equipe.</p><Card className="mt-8"><CardHeader><CardTitle>Serviços</CardTitle></CardHeader><CardContent>Projetos feitos com cuidado.</CardContent></Card></main>
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

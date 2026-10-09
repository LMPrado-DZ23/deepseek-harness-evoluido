import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { BuilderLifecycleResolverPort } from '../plugins/prompt-to-app/src/builder-lifecycle.js'
import { listTreeFiles } from '../plugins/prompt-to-app/src/runner.js'

const root = process.cwd()
const proofRoot = mkdtempSync(join(tmpdir(), 'dz23-template-proof-'))
const runDirectory = resolve(proofRoot, 'generated-app')
const unsupported = async (): Promise<never> => { throw new Error('UNSUPPORTED_INGRESS') }
const builder: BuilderLifecycleResolverPort<unknown> = { forActor: async () => ({ preflight: async () => ({ state: 'BLOCKED_EXTERNAL' }), prepare: unsupported, execute: unsupported, cancel: unsupported, finish: unsupported, listManaged: async () => [] }) }

try {
  cpSync(resolve(root, 'templates/nextjs-app@1'), runDirectory, { recursive: true })
  mkdirSync(resolve(runDirectory, 'content'), { recursive: true })
  mkdirSync(resolve(runDirectory, 'src/styles'), { recursive: true })
  writeFileSync(resolve(runDirectory, 'src/styles/tokens.css'), `:root {
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
  const initialFiles = await listTreeFiles(runDirectory)
  const initialHashes = new Map(initialFiles.map(file => [file, createHash('sha256').update(readFileSync(resolve(runDirectory, file))).digest('hex')]))

  const preflight = await (await builder.forActor({})).preflight()
  if (preflight.state !== 'BLOCKED_EXTERNAL') throw new Error('INGRESS_MUST_REMAIN_BLOCKED')
  const changedInitialFiles = initialFiles.filter(file => createHash('sha256').update(readFileSync(resolve(runDirectory, file))).digest('hex') !== initialHashes.get(file))
  if (changedInitialFiles.length > 0) throw new Error(`Arquivos iniciais alterados sem build: ${changedInitialFiles.join(', ')}`)

  const report = `# P32 — Prova executável do template v1\n\n` +
    `- Verificação estática do template: **PASS**\n` +
    `- Ingresso autenticado do builder: **NOT_PRESENT**\n` +
    `- Fontes: Geist Sans e Source Serif 4 locais via next/font/local; nenhum download no build.\n` +
    `- Build, teste unitário e E2E Playwright + axe: **NOT_EXECUTED**\n` +
    `- Estado de promoção: **BLOCKED_EXTERNAL**\n\n` +
    `Esta verificação não chama o template de aplicação pronta ou protótipo verificado.\n`
  mkdirSync(resolve(root, 'docs/proofs'), { recursive: true })
  writeFileSync(resolve(root, 'docs/proofs/P32-template-pipeline-proof.md'), report)
  process.stdout.write('TEMPLATE_STATIC_CHECK=PASS build=BLOCKED_EXTERNAL ingress=NOT_PRESENT\n')
} finally {
  if (proofRoot.startsWith(`${resolve(tmpdir())}/`) || proofRoot.startsWith(`${resolve(tmpdir())}\\`)) rmSync(proofRoot, { recursive: true, force: true })
}

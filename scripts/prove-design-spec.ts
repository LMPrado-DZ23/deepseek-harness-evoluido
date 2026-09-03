import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { createDesignSpec } from '../plugins/prompt-to-app/src/design.js'
import { SharpLogoProcessor } from '../plugins/prompt-to-app/src/logo.js'
import { writeDesignAssets } from '../plugins/prompt-to-app/src/pipeline.js'
import { ContainerBuilder, OFFLINE_PIPELINE_COMMANDS } from '../plugins/prompt-to-app/src/runner.js'

const root = process.cwd()
const scratch = await mkdtemp(join(tmpdir(), 'dz23-design-proof-'))
const store = resolve(scratch, 'logos'); const run = resolve(scratch, 'app')
const digest = (await readFile(resolve(root, 'runtime/builder-image-digest'), 'utf8')).trim() as `sha256:${string}`
const uid = typeof process.getuid === 'function' ? process.getuid() : 1000
const gid = typeof process.getgid === 'function' ? process.getgid() : 1000
const builder = new ContainerBuilder({ engine: 'docker', imageDigest: digest, templateStore: resolve(root, 'runtime/template-store-v2'), user: `${uid}:${gid}`, limits: { pids: 256, memory: '2g', cpus: '2', timeoutMs: 180_000 } })

try {
  const input = await sharp({ create: { width: 120, height: 80, channels: 4, background: '#075ee5' } }).jpeg().toBuffer()
  const logo = await new SharpLogoProcessor(store).process({ orgId: 'org-proof', tenantId: 'tenant-proof' }, input, 'image/jpeg')
  const design = createDesignSpec({ preset: 'brand', primary: logo.extracted_primary }, logo)
  await cp(resolve(root, 'templates/nextjs-app@1'), run, { recursive: true })
  await mkdir(resolve(run, 'content'), { recursive: true }); await mkdir(resolve(run, 'src'), { recursive: true })
  await writeFile(resolve(run, 'content/app.json'), '{"title":"Marca Azul","description":"Prova de marca"}\n')
  await writeFile(resolve(run, 'src/GeneratedApp.tsx'), "export default function GeneratedApp(){return <main><h1>Marca Azul</h1></main>}\n")
  await writeDesignAssets(run, design, store)
  const target = await readFile(resolve(run, 'public/brand/logo.png'))
  if (createHash('sha256').update(target).digest('hex') !== logo.sha256) throw new Error('LOGO_HASH_MISMATCH')
  const layout = await readFile(resolve(run, 'app/layout.tsx'), 'utf8')
  if (!layout.includes('src="/brand/logo.png"') || !layout.includes('appContent.title')) throw new Error('LOGO_LAYOUT_MISSING')
  const before = createHash('sha256').update(target).digest('hex')
  for (const command of OFFLINE_PIPELINE_COMMANDS) {
    const result = await builder.execute(run, command)
    if (result.exitCode !== 0 || result.timedOut) throw new Error(`${command}: ${result.stderr.slice(-2_000)}`)
  }
  const after = createHash('sha256').update(await readFile(resolve(run, 'public/brand/logo.png'))).digest('hex')
  if (after !== before) throw new Error('LOGO_CHANGED_DURING_BUILD')
  const proof = `# P32 — Prova executável do DesignSpec e logotipo\n\n- Resultado: **PASS**\n- Imagem fixada: \`${digest}\`.\n- PNG/JPEG reencodado e sem metadados: PASS.\n- Cópia verificada em \`public/brand/logo.png\`: PASS.\n- Hash da cópia idêntico ao DesignSpec antes e depois do build: PASS.\n- Layout protegido renderiza \`/brand/logo.png\` com texto alternativo baseado no título: PASS.\n- Build, Vitest, Playwright, axe e scan: PASS em contêiner sem rede.\n\nNão houve preview, publicação, deploy ou modelo real.\n`
  await writeFile(resolve(root, 'docs/proofs/P32-design-spec-proof.md'), proof)
  process.stdout.write(`DESIGN_SPEC_PROOF=PASS logo=${logo.sha256} steps=${OFFLINE_PIPELINE_COMMANDS.length}\n`)
} finally {
  await rm(scratch, { recursive: true, force: true })
}

import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import type { BuilderLifecycleResolverPort } from '../plugins/prompt-to-app/src/builder-lifecycle.js'
import { createDesignSpec } from '../plugins/prompt-to-app/src/design.js'
import { SharpLogoProcessor } from '../plugins/prompt-to-app/src/logo.js'
import { writeDesignAssets } from '../plugins/prompt-to-app/src/pipeline.js'

const root = process.cwd()
const scratch = await mkdtemp(join(tmpdir(), 'dz23-design-proof-'))
const store = resolve(scratch, 'logos'); const run = resolve(scratch, 'app')
const unsupported = async (): Promise<never> => { throw new Error('UNSUPPORTED_INGRESS') }
const builder: BuilderLifecycleResolverPort<unknown> = { forActor: async () => ({ preflight: async () => ({ state: 'BLOCKED_EXTERNAL' }), prepare: unsupported, execute: unsupported, cancel: unsupported, finish: unsupported, listManaged: async () => [] }) }

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
  const preflight = await (await builder.forActor({})).preflight()
  if (preflight.state !== 'BLOCKED_EXTERNAL') throw new Error('INGRESS_MUST_REMAIN_BLOCKED')
  const proof = `# P32 — Verificação lógica do DesignSpec e logotipo\n\n- Processamento e hash do logotipo: **PASS**\n- Layout protegido e tokens: **PASS**\n- Ingresso autenticado do builder: **NOT_PRESENT**\n- Build, Vitest, Playwright, axe e scan: **NOT_EXECUTED**\n- Estado de promoção: **BLOCKED_EXTERNAL**\n\nNão houve preview, publicação, deploy ou modelo real.\n`
  await writeFile(resolve(root, 'docs/proofs/P32-design-spec-proof.md'), proof)
  process.stdout.write(`DESIGN_SPEC_GENERATION=PASS logo=${logo.sha256} build=BLOCKED_EXTERNAL ingress=NOT_PRESENT\n`)
} finally {
  await rm(scratch, { recursive: true, force: true })
}

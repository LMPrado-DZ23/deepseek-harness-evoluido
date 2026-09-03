import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

if (!process.argv.includes('--approve-t2')) {
  process.stderr.write('Setup recusado: confirme a instalação de dependências com --approve-t2.\n')
  process.exit(2)
}
const root = process.cwd()
const digestFile = resolve(root, 'runtime/builder-image-digest')
if (existsSync(digestFile) && !process.argv.includes('--replace-existing')) {
  process.stderr.write('Setup recusado: a imagem local já está fixada; use --replace-existing para confirmar a substituição.\n')
  process.exit(3)
}
const templates = [resolve(root, 'templates/static-site@1'), resolve(root, 'templates/nextjs-app@1')]
const store = resolve(root, 'runtime/template-store-v2')
mkdirSync(store, { recursive: true })
const fetchRoot = mkdtempSync(resolve(tmpdir(), 'dz23-template-fetch-'))
try {
  for (const [index, template] of templates.entries()) {
    const workspace = resolve(fetchRoot, `template-${index}`)
    mkdirSync(workspace)
    copyFileSync(resolve(template, 'package.json'), resolve(workspace, 'package.json'))
    copyFileSync(resolve(template, 'pnpm-lock.yaml'), resolve(workspace, 'pnpm-lock.yaml'))
    const fetch = spawnSync('corepack', ['pnpm', 'fetch', '--ignore-workspace', '--frozen-lockfile', '--store-dir', store], {
      cwd: workspace, stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, CI: 'true' },
    })
    if (fetch.status !== 0) process.exit(fetch.status ?? 1)
  }
} finally {
  rmSync(fetchRoot, { recursive: true, force: true })
}
const build = spawnSync('docker', ['build', '--file', 'deploy/builder/Dockerfile', '--tag', 'dz23-studio-builder:local', '.'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
if (build.status !== 0) process.exit(build.status ?? 1)
const inspect = spawnSync('docker', ['image', 'inspect', 'dz23-studio-builder:local', '--format', '{{.Id}}'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' })
if (inspect.status !== 0 || !inspect.stdout.trim().startsWith('sha256:')) process.exit(1)
writeFileSync(digestFile, `${inspect.stdout.trim()}\n`, { mode: 0o600 })
process.stdout.write(`BUILDER_IMAGE=${inspect.stdout.trim()}\n`)

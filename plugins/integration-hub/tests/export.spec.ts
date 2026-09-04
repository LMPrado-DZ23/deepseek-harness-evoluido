import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ExportError, packagePrototype, slug } from '../src/export.ts'
import { readZip } from '../src/zip.ts'
import { execFileSync } from 'node:child_process'
import { rm as rmDir } from 'node:fs/promises'

const scratch: string[] = []
afterEach(async () => { for (const directory of scratch.splice(0)) await rm(directory, { recursive: true, force: true }) })

async function runDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dz23-export-'))
  scratch.push(root)
  await mkdir(join(root, '.next', 'standalone', 'node_modules', 'next'), { recursive: true })
  await mkdir(join(root, '.next', 'standalone', 'data'), { recursive: true })
  await mkdir(join(root, '.next', 'static', 'chunks'), { recursive: true })
  await mkdir(join(root, 'public', 'brand'), { recursive: true })
  await mkdir(join(root, 'data'), { recursive: true })
  await mkdir(join(root, 'evidence'), { recursive: true })
  await mkdir(join(root, 'tests'), { recursive: true })
  await writeFile(join(root, '.next', 'standalone', 'server.js'), 'console.log("server")')
  await chmod(join(root, '.next', 'standalone', 'server.js'), 0o755)
  await writeFile(join(root, '.next', 'standalone', 'node_modules', 'next', 'package.json'), '{}')
  await writeFile(join(root, '.next', 'standalone', 'data', 'app.sqlite'), 'db')
  await writeFile(join(root, '.next', 'standalone', '.env'), 'APP_SMTP_URL=smtp://user:pass@host')
  await writeFile(join(root, '.next', 'static', 'chunks', 'main.js'), 'chunk')
  await writeFile(join(root, 'public', 'brand', 'logo.png'), 'png')
  await writeFile(join(root, 'data', 'studio-capture.json'), '[{"code":"987654"}]')
  await writeFile(join(root, 'data', 'studio-auth-state.json'), '{"cookies":[]}')
  await writeFile(join(root, 'evidence', 'appspec-report.json'), '{"checks":[]}')
  await writeFile(join(root, 'tests', 'x.spec.ts'), 'test')
  await symlink('/etc/passwd', join(root, 'public', 'link'))
  return root
}

describe('prototype export package', () => {
  it('keeps library data/ folders and files whose names contain "..", excluding only the app root data/ and caches', async () => {
    const root = await runDirectory()
    await mkdir(join(root, '.next', 'standalone', 'node_modules', 'lib', 'data'), { recursive: true })
    await writeFile(join(root, '.next', 'standalone', 'node_modules', 'lib', 'data', 'table.json'), '[]')
    await writeFile(join(root, '.next', 'standalone', 'jquery..min.js'), 'js')
    await mkdir(join(root, '.next', 'standalone', '.cache'), { recursive: true })
    await writeFile(join(root, '.next', 'standalone', '.cache', 'x'), 'x')
    const built = await packagePrototype({ runDirectory: root, projectName: 'A', runId: 'run-1' })
    const names = readZip(built.archive).map(entry => entry.name)
    expect(names).toContain('app/node_modules/lib/data/table.json')
    expect(names).toContain('app/jquery..min.js')
    expect(names.some(name => name.startsWith('app/data/') || name.startsWith('app/.cache/'))).toBe(false)
  })

  it('writes Unix file-type bits so system unzip sees regular files with the right permissions', async () => {
    const root = await runDirectory()
    const built = await packagePrototype({ runDirectory: root, projectName: 'A', runId: 'run-1' })
    const out = await mkdtemp(join(tmpdir(), 'dz23-unzip-'))
    scratch.push(out)
    await writeFile(join(out, 'p.zip'), built.archive)
    let listing = ''
    try { listing = execFileSync('unzip', ['-Z', join(out, 'p.zip')], { encoding: 'utf8' }) } catch { return } // unzip not installed here: nothing to assert
    const serverLine = listing.split('\n').find(line => line.endsWith('app/server.js'))!
    expect(serverLine.startsWith('-rwxr-xr-x')).toBe(true)
    expect(listing.split('\n').some(line => line.startsWith('?'))).toBe(false)
    await rmDir(out, { recursive: true, force: true })
  })

  it('packages the standalone server, static assets, public files, report, README and .env.example — and nothing private', async () => {
    const root = await runDirectory()
    const built = await packagePrototype({ runDirectory: root, projectName: 'Agenda do Salão', runId: 'run-abcdef123456' })
    const entries = readZip(built.archive)
    const names = entries.map(entry => entry.name)
    expect(names).toEqual([
      '.env.example', 'EXCLUIDOS.txt', 'README.md', 'app/.next/static/chunks/main.js', 'app/node_modules/next/package.json', 'app/public/brand/logo.png',
      'app/server.js', 'evidence/appspec-report.json',
    ].sort())
    // Nothing is dropped in silence: what stayed out is listed by name (never by content) inside the package.
    const left = entries.find(entry => entry.name === 'EXCLUIDOS.txt')!.data.toString('utf8')
    expect(left).toContain('app/.env')
    expect(left).toContain('app/data/') // the app's own data folder is named as a whole, not file by file
    expect(entries.find(entry => entry.name === 'app/server.js')!.mode).toBe(0o755)
    const all = entries.map(entry => entry.data.toString('utf8')).join('\n')
    expect(all).not.toContain("987654")
    expect(all).not.toContain('user:pass')
    expect(all).not.toContain('cookies')
    expect(entries.find(entry => entry.name === '.env.example')!.data.toString('utf8')).toMatch(/APP_SMTP_URL=\n/u)
    expect(entries.find(entry => entry.name === 'README.md')!.data.toString('utf8')).toContain('Agenda do Salão')
    expect(built.fileName).toBe('agenda-do-salao-run-abcd.zip')
    expect(built.sha256).toMatch(/^[a-f0-9]{64}$/u)
    const again = await packagePrototype({ runDirectory: root, projectName: 'Agenda do Salão', runId: 'run-abcdef123456' })
    expect(again.sha256).toBe(built.sha256)
  })

  it('packages only allowed file types and lists every exclusion by name', async () => {
    const root = await runDirectory()
    await writeFile(join(root, '.next', 'standalone', 'deploy.sh'), 'echo hi')
    await writeFile(join(root, '.next', 'standalone', 'backup.bak'), 'x')
    await writeFile(join(root, '.next', 'standalone', 'LICENSE'), 'MIT')
    const built = await packagePrototype({ runDirectory: root, projectName: 'A', runId: 'run-1' })
    const entries = readZip(built.archive)
    const names = entries.map(entry => entry.name)
    expect(names).not.toContain('app/deploy.sh')
    expect(names).not.toContain('app/backup.bak')
    expect(names).toContain('app/LICENSE') // an extension-less file on the short allow-list still ships
    const left = entries.find(entry => entry.name === 'EXCLUIDOS.txt')!.data.toString('utf8')
    expect(left).toContain('app/deploy.sh')
    expect(left).toContain('app/backup.bak')
  })

  it('fails the whole export when a packaged file carries a private key or a connection string with a password', async () => {
    const key = await runDirectory()
    await writeFile(join(key, '.next', 'standalone', 'config.js'), 'export const k = `-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----`')
    await expect(packagePrototype({ runDirectory: key, projectName: 'A', runId: 'run-1' }))
      .rejects.toMatchObject({ code: 'SECRET_DETECTED', message: expect.stringContaining('config.js') })

    const dsn = await runDirectory()
    await writeFile(join(dsn, '.next', 'standalone', 'db.json'), '{"url":"postgresql://app:s3nh4@db.example.test:5432/app"}')
    await expect(packagePrototype({ runDirectory: dsn, projectName: 'A', runId: 'run-1' }))
      .rejects.toMatchObject({ code: 'SECRET_DETECTED', message: expect.stringContaining('db.json') })

    // A password-shaped word without a secret shape is NOT a secret: the scan must not block ordinary code.
    const ordinary = await runDirectory()
    await writeFile(join(ordinary, '.next', 'standalone', 'form.js'), 'const field = { name: "password", label: "Senha" }')
    await expect(packagePrototype({ runDirectory: ordinary, projectName: 'A', runId: 'run-1' })).resolves.toMatchObject({ entries: expect.any(Number) })
  })

  it('refuses a run without a standalone build and slugs names safely', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-export-empty-'))
    scratch.push(root)
    await expect(packagePrototype({ runDirectory: root, projectName: 'x', runId: 'r' })).rejects.toBeInstanceOf(ExportError)
    expect(slug('  Ção & Cia!!  ')).toBe('cao-cia')
    expect(slug('___')).toBe('prototipo')
  })
})

import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ExportError, packagePrototype, slug } from '../src/export.ts'
import { readZip } from '../src/zip.ts'

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
  it('packages the standalone server, static assets, public files, report, README and .env.example — and nothing private', async () => {
    const root = await runDirectory()
    const built = await packagePrototype({ runDirectory: root, projectName: 'Agenda do Salão', runId: 'run-abcdef123456' })
    const entries = readZip(built.archive)
    const names = entries.map(entry => entry.name)
    expect(names).toEqual([
      '.env.example', 'README.md', 'app/.next/static/chunks/main.js', 'app/node_modules/next/package.json', 'app/public/brand/logo.png',
      'app/server.js', 'evidence/appspec-report.json',
    ].sort())
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

  it('refuses a run without a standalone build and slugs names safely', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-export-empty-'))
    scratch.push(root)
    await expect(packagePrototype({ runDirectory: root, projectName: 'x', runId: 'r' })).rejects.toBeInstanceOf(ExportError)
    expect(slug('  Ção & Cia!!  ')).toBe('cao-cia')
    expect(slug('___')).toBe('prototipo')
  })
})

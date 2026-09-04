import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ExportError, packagePrototype, slug } from '../src/export.ts'
import { readZip } from '../src/zip.ts'
import { execFileSync } from 'node:child_process'
import { rm as rmDir } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'

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
  /**
   * `open()` on a FIFO in O_RDONLY without O_NONBLOCK waits for a writer that may never come. A
   * named pipe where a file is expected therefore froze `packagePrototype` itself — and, above it,
   * the global packaging slot and the in-flight entry of that project, for good. Both opens that
   * read a file are covered: the acceptance report, which is opened BEFORE anything asks whether it
   * is a regular file, and any entry of the walk that becomes a pipe between `readdir` and `open`.
   * The test times out (and fails) instead of hanging the suite if the flag is taken away again.
   */
  it('does not hang on a FIFO where a file is expected, and names it as an exclusion', async () => {
    const root = await runDirectory()
    await rmDir(join(root, 'evidence', 'appspec-report.json'), { force: true })
    execFileSync('mkfifo', [join(root, 'evidence', 'appspec-report.json')])
    execFileSync('mkfifo', [join(root, '.next', 'standalone', 'pipe.js')])
    const built = await packagePrototype({ runDirectory: root, projectName: 'Agenda', runId: 'run-fifo' })
    const entries = readZip(built.archive)
    expect(entries.map(entry => entry.name)).not.toContain('evidence/appspec-report.json')
    expect(entries.map(entry => entry.name)).not.toContain('app/pipe.js')
    const left = entries.find(entry => entry.name === 'EXCLUIDOS.txt')!.data.toString('utf8')
    // Named, not silently dropped: both of them.
    expect(left).toContain('evidence/appspec-report.json')
    expect(left).toContain('app/pipe.js')
  }, 15_000)

  it('keeps a dependency\'s data/ folder but drops the app\'s own at any depth, and keeps names containing ".."', async () => {
    const root = await runDirectory()
    await mkdir(join(root, '.next', 'standalone', 'node_modules', 'lib', 'data'), { recursive: true })
    await writeFile(join(root, '.next', 'standalone', 'node_modules', 'lib', 'data', 'table.json'), '[]')
    await writeFile(join(root, '.next', 'standalone', 'jquery..min.js'), 'js')
    await mkdir(join(root, '.next', 'standalone', '.cache'), { recursive: true })
    await writeFile(join(root, '.next', 'standalone', '.cache', 'x'), 'x')
    // A generated app one folder down keeps its own store there, captured access codes included.
    await mkdir(join(root, '.next', 'standalone', 'meu-app', 'data'), { recursive: true })
    await writeFile(join(root, '.next', 'standalone', 'meu-app', 'data', 'codigos.json'), '[{"code":"654321"}]')
    const built = await packagePrototype({ runDirectory: root, projectName: 'A', runId: 'run-1' })
    const entries = readZip(built.archive)
    const names = entries.map(entry => entry.name)
    expect(names).toContain('app/node_modules/lib/data/table.json') // a dependency's data IS the dependency
    expect(names).toContain('app/jquery..min.js')
    expect(names.some(name => name.startsWith('app/data/') || name.startsWith('app/.cache/'))).toBe(false)
    expect(names.some(name => name.includes('meu-app/data/'))).toBe(false) // …but the app's own store never travels
    expect(entries.map(entry => entry.data.toString('utf8')).join('\n')).not.toContain('654321')
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

  it('scans a file far larger than one slice, and names what it could not inspect', async () => {
    const root = await runDirectory()
    // A 5 MB bundle with the key at the very end: a size limit here would answer "no secret found"
    // for exactly the files most likely to carry one.
    const filler = 'x'.repeat(5 * 1024 * 1024)
    await writeFile(join(root, '.next', 'standalone', 'bundle.js'), `${filler}\nconst k = "-----BEGIN PRIVATE KEY-----"`)
    await expect(packagePrototype({ runDirectory: root, projectName: 'A', runId: 'run-1' }))
      .rejects.toMatchObject({ code: 'SECRET_DETECTED', message: expect.stringContaining('bundle.js') })

    // A type the scan cannot read still ships, but the package says nobody looked inside it.
    const quiet = await runDirectory()
    await writeFile(join(quiet, '.next', 'standalone', 'imagem.png'), 'nao-e-texto')
    const built = await packagePrototype({ runDirectory: quiet, projectName: 'A', runId: 'run-1' })
    const entries = readZip(built.archive)
    expect(entries.map(entry => entry.name)).toContain('app/imagem.png')
    expect(entries.find(entry => entry.name === 'EXCLUIDOS.txt')!.data.toString('utf8')).toContain('app/imagem.png')
  })

  it('finds a credential in ANY URI scheme, not only the five that were listed first', async () => {
    // `smtp://usuario:senha@host` is the app's OWN e-mail setting: the shape most likely to be pasted
    // into a config file, and the one the pattern list did not cover.
    const mail = await runDirectory()
    await writeFile(join(mail, '.next', 'standalone', 'mail.json'), '{"url":"smtp://usuario:senha@mail.example.test:587"}')
    await expect(packagePrototype({ runDirectory: mail, projectName: 'A', runId: 'run-1' }))
      .rejects.toMatchObject({ code: 'SECRET_DETECTED', message: expect.stringContaining('mail.json') })

    const ftp = await runDirectory()
    await writeFile(join(ftp, '.next', 'standalone', 'deploy.yml'), 'destino: ftp://deploy:s3nh4@ftp.example.test/site\n')
    await expect(packagePrototype({ runDirectory: ftp, projectName: 'A', runId: 'run-1' }))
      .rejects.toMatchObject({ code: 'SECRET_DETECTED', message: expect.stringContaining('deploy.yml') })

    // A URL without credentials is still just a URL: broadening the scheme must not block ordinary code.
    const plain = await runDirectory()
    await writeFile(join(plain, '.next', 'standalone', 'links.json'), '{"a":"https://exemplo.test/caminho","b":"ldap://servidor.test:389","c":"http://user@host.test"}')
    await expect(packagePrototype({ runDirectory: plain, projectName: 'A', runId: 'run-1' })).resolves.toMatchObject({ entries: expect.any(Number) })
  })

  it('opens a compressed copy of a bundle to scan it, and refuses to ship one it cannot open', async () => {
    // The `.gz` next to `main.js` used to travel as "nobody looked inside": the secret was caught in
    // the bundle and shipped in its compressed twin.
    const hidden = await runDirectory()
    await writeFile(join(hidden, '.next', 'standalone', 'bundle.js.gz'), gzipSync(Buffer.from('const k = "-----BEGIN PRIVATE KEY-----"')))
    await expect(packagePrototype({ runDirectory: hidden, projectName: 'A', runId: 'run-1' }))
      .rejects.toMatchObject({ code: 'SECRET_DETECTED', message: expect.stringContaining('bundle.js.gz') })

    const mixed = await runDirectory()
    await writeFile(join(mixed, '.next', 'standalone', 'app.js.gz'), gzipSync(Buffer.from('console.log("ok")')))
    await writeFile(join(mixed, '.next', 'standalone', 'quebrado.js.gz'), Buffer.from('isto nao e um gzip'))
    const built = await packagePrototype({ runDirectory: mixed, projectName: 'A', runId: 'run-1' })
    const entries = readZip(built.archive)
    const names = entries.map(entry => entry.name)
    expect(names).toContain('app/app.js.gz')
    expect(names).not.toContain('app/quebrado.js.gz') // cannot be opened, so it is not shipped as if it had been checked
    const left = entries.find(entry => entry.name === 'EXCLUIDOS.txt')!.data.toString('utf8')
    expect(left).toContain('app/quebrado.js.gz')
    // …and a `.gz` that WAS opened is no longer listed among the files nobody looked inside.
    expect(left.split('sem conferência de segredos')[1] ?? '').not.toContain('app/app.js.gz')
  })

  it('refuses on the entry ceiling BEFORE reading the file that would trip the scan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-export-count-'))
    scratch.push(root)
    const standalone = join(root, '.next', 'standalone')
    await mkdir(standalone, { recursive: true })
    await writeFile(join(standalone, 'a.js'), 'const a = 1')
    await writeFile(join(standalone, 'b.js'), 'const b = 2')
    // Sorted last, and it carries a private key. A ceiling checked AFTER the reading it exists to
    // prevent would answer SECRET_DETECTED here — that answer is the proof the file was read.
    await writeFile(join(standalone, 'c.js'), 'const k = "-----BEGIN PRIVATE KEY-----"')
    await expect(packagePrototype({ runDirectory: root, projectName: 'A', runId: 'run-1' }, { maxEntries: 6 }))
      .rejects.toMatchObject({ code: 'TOO_LARGE', message: expect.stringContaining('arquivos demais') })
    // The same tree under the real ceiling is refused for the honest reason instead.
    await expect(packagePrototype({ runDirectory: root, projectName: 'A', runId: 'run-1' }))
      .rejects.toMatchObject({ code: 'SECRET_DETECTED' })
  })

  it('refuses when the list of exclusions would grow without bound, instead of truncating it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-export-listed-'))
    scratch.push(root)
    const standalone = join(root, '.next', 'standalone')
    await mkdir(standalone, { recursive: true })
    await writeFile(join(standalone, 'server.js'), 'ok')
    for (const name of ['a.bak', 'b.bak', 'c.bak']) await writeFile(join(standalone, name), 'x')
    await expect(packagePrototype({ runDirectory: root, projectName: 'A', runId: 'run-1' }, { maxListed: 2 }))
      .rejects.toMatchObject({ code: 'TOO_LARGE', message: expect.stringContaining('itens demais') })
    // Under the real ceiling the very same tree exports and names all three: the bound is a bound, not a wall.
    const built = await packagePrototype({ runDirectory: root, projectName: 'A', runId: 'run-1' })
    const left = readZip(built.archive).find(entry => entry.name === 'EXCLUIDOS.txt')!.data.toString('utf8')
    for (const name of ['a.bak', 'b.bak', 'c.bak']) expect(left).toContain(`app/${name}`)
  })

  it('refuses a run without a standalone build and slugs names safely', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-export-empty-'))
    scratch.push(root)
    await expect(packagePrototype({ runDirectory: root, projectName: 'x', runId: 'r' })).rejects.toBeInstanceOf(ExportError)
    expect(slug('  Ção & Cia!!  ')).toBe('cao-cia')
    expect(slug('___')).toBe('prototipo')
  })
})

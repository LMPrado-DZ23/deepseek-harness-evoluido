import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const root = resolve(import.meta.dirname, '../..')
const captureScript = join(root, 'deploy', 'windows', 'Get-Dz23TrustStoreSnapshot.ps1')
const compareScript = join(root, 'deploy', 'windows', 'Compare-Dz23TrustStoreSnapshot.ps1')
const pwsh = process.platform === 'win32' ? 'pwsh.exe' : 'pwsh'

function run(script, args) {
  return spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, ...args], {
    encoding: 'utf8', timeout: 130_000, maxBuffer: 8 * 1024 * 1024,
  })
}

function parseLastJson(stdout) {
  const lines = stdout.trim().split(/\r?\n/u)
  return JSON.parse(lines.at(-1))
}

test('coletores são somente leitura e não contêm operações de instalação de certificado', () => {
  const capture = readFileSync(captureScript, 'utf8')
  const compare = readFileSync(compareScript, 'utf8')
  const source = `${capture}\n${compare}`
  assert.match(source, /trust_store_modified\s*=\s*\$false/u)
  assert.match(source, /network_contacted\s*=\s*\$false/u)
  assert.doesNotMatch(source, /Import-Certificate|certutil(?:\.exe)?\s+-addstore|update-ca-certificates|security\s+add-trusted-cert/iu)
  assert.doesNotMatch(source, /Remove-Item[^\r\n]*(?:Cert:|ssl\/certs|ca-certificates)/iu)
})

test('captura real é estável e a comparação acusa qualquer alteração', { skip: process.platform !== 'win32' }, (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dz23-trust-store-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const beforePath = join(directory, 'before.json')
  const afterPath = join(directory, 'after.json')
  const changedPath = join(directory, 'changed.json')
  const reportPath = join(directory, 'report.json')

  const before = run(captureScript, ['-OutputPath', beforePath, '-Distro', 'Ubuntu'])
  assert.notEqual(before.error?.code, 'ENOENT', 'PowerShell 7 é obrigatório para a prova Windows.')
  assert.equal(before.status, 0, `${before.stdout}\n${before.stderr}`)
  assert.equal(parseLastJson(before.stdout).trust_store_modified, false)

  const after = run(captureScript, ['-OutputPath', afterPath, '-Distro', 'Ubuntu'])
  assert.equal(after.status, 0, `${after.stdout}\n${after.stderr}`)
  const equal = run(compareScript, ['-BeforePath', beforePath, '-AfterPath', afterPath, '-ReportPath', reportPath])
  assert.equal(equal.status, 0, `${equal.stdout}\n${equal.stderr}`)
  const equalReport = parseLastJson(equal.stdout)
  assert.equal(equalReport.state, 'PASS')
  assert.equal(equalReport.invariant.trust_store_unchanged, true)

  const changed = JSON.parse(readFileSync(afterPath, 'utf8'))
  changed.windows.certificates.push({
    location: 'CurrentUser',
    store: 'Root',
    thumbprint_sha1: '0'.repeat(40),
    certificate_sha256: '0'.repeat(64),
  })
  writeFileSync(changedPath, `${JSON.stringify(changed, null, 2)}\n`, 'utf8')
  const unequal = run(compareScript, ['-BeforePath', beforePath, '-AfterPath', changedPath])
  assert.equal(unequal.status, 3, `${unequal.stdout}\n${unequal.stderr}`)
  const unequalReport = parseLastJson(unequal.stdout)
  assert.equal(unequalReport.state, 'CHANGED')
  assert.equal(unequalReport.invariant.trust_store_unchanged, false)
  assert.ok(unequalReport.changes.length > 0)
})

test('captura não sobrescreve evidência anterior', { skip: process.platform !== 'win32' }, (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dz23-trust-store-overwrite-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const outputPath = join(directory, 'snapshot.json')
  writeFileSync(outputPath, 'preservar\n', 'utf8')
  const result = run(captureScript, ['-OutputPath', outputPath, '-Distro', 'Ubuntu'])
  assert.notEqual(result.status, 0)
  assert.equal(readFileSync(outputPath, 'utf8'), 'preservar\n')
  assert.match(`${result.stdout}\n${result.stderr}`, /não sobrescrever uma prova anterior/iu)
})

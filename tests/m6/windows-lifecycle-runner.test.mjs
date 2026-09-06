import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '../..')
const runner = resolve(root, 'deploy/windows/Invoke-Dz23LifecycleProof.ps1')
const proof = resolve(root, 'tests/m6/prove-windows-lifecycle-runner.ps1')
const pwsh = process.platform === 'win32' ? 'pwsh.exe' : 'pwsh'

test('runner M77 é explícito, fail-closed e deixa evidência estruturada', () => {
  const source = readFileSync(runner, 'utf8')
  assert.match(source, /PREPARED_NOT_EXECUTED/u)
  assert.match(source, /EXECUTAR PROVA REAL M77 EM AMBIENTE DESCARTAVEL/u)
  assert.match(source, /UNINSTALLED_DATA_PRESERVED/u)
  assert.match(source, /update-failure-rollback/u)
  assert.match(source, /sentinel-verify/u)
  assert.match(source, /trust-compare/u)
  assert.doesNotMatch(source, /Start-Process|Start-Service|Import-Certificate|certutil|update-ca-certificates/iu)
  assert.doesNotMatch(source, /-PurgeData/u)

  const result = spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', proof], {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  })
  assert.notEqual(result.error?.code, 'ENOENT', 'PowerShell 7 é obrigatório para a prova M77.')
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error ?? ''}`)
  assert.match(result.stdout, /M77_LIFECYCLE_RUNNER=PASS prepare=no-side-effects confirmation=literal operations=16 phases=17 rollback=expected persistence=sentinel trust=compared final=uninstalled-data-preserved/u)
})

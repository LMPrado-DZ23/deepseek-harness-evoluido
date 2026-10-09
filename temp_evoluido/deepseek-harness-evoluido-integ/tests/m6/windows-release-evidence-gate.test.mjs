import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const root = resolve(import.meta.dirname, '../..')
const verifier = join(root, 'deploy', 'windows', 'Test-Dz23LifecycleEvidence.ps1')
const pwsh = process.platform === 'win32' ? 'pwsh.exe' : 'pwsh'
const commits = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)]
const phases = [
  'trust-before', 'isolation-preflight', 'install-initial', 'doctor-initial', 'sentinel-create',
  'update-success', 'doctor-upgrade', 'update-failure-rollback', 'doctor-after-rollback',
  'uninstall-preserve', 'reinstall-preserve', 'doctor-reinstall', 'sentinel-verify',
  'uninstall-final-preserve', 'trust-after', 'trust-compare', 'evidence-finalize',
]

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex').toUpperCase()
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function snapshot() {
  return {
    schema_version: 1,
    captured_at_utc: '2026-09-06T20:00:00.0000000+00:00',
    host: { platform: 'windows', os_version: 'Microsoft Windows NT 10.0.26100.0', powershell_version: '7.5.2' },
    windows: {
      stores: ['CurrentUser/Root', 'CurrentUser/CA', 'LocalMachine/Root', 'LocalMachine/CA'],
      certificates: [{
        location: 'CurrentUser', store: 'Root', thumbprint_sha1: '1'.repeat(40), certificate_sha256: '2'.repeat(64),
      }],
    },
    wsl: {
      distro: 'Ubuntu',
      roots: [
        { path: '/etc/ssl/certs', kind: 'directory' },
        { path: '/usr/local/share/ca-certificates', kind: 'directory' },
        { path: '/usr/share/ca-certificates', kind: 'directory' },
      ],
      entries: [{ path: '/etc/ssl/certs/example.pem', kind: 'file', sha256: '3'.repeat(64), size: 123, target: null }],
    },
    safety: { read_only: true, trust_store_modified: false, network_contacted: false, elevated: false },
  }
}

function createFixture(parent, name = 'evidence') {
  const directory = join(parent, name)
  mkdirSync(directory)
  const beforePath = join(directory, 'trust-before.json')
  const afterPath = join(directory, 'trust-after.json')
  const comparisonPath = join(directory, 'trust-comparison.json')
  writeJson(beforePath, snapshot())
  writeJson(afterPath, snapshot())
  writeJson(comparisonPath, {
    schema_version: 1,
    compared_at_utc: '2026-09-06T20:01:00.0000000+00:00',
    state: 'PASS',
    before_path: beforePath,
    after_path: afterPath,
    distro: 'Ubuntu',
    changes: [],
    invariant: { trust_store_unchanged: true, comparison_read_only: true },
  })
  const report = {
    schema_version: 1,
    state: 'PASS',
    initial_commit: commits[0],
    upgrade_commit: commits[1],
    failure_commit: commits[2],
    execution_mode: 'REAL',
    final_state: 'UNINSTALLED_DATA_PRESERVED',
    source_and_images: 'VERIFIED_BY_LIFECYCLE_SCRIPTS',
    docker_desktop_started_by_runner: false,
    docker_containers: 'STARTED_AND_STOPPED_DURING_PROOF',
    phases: phases.map((phase) => ({
      name: phase,
      status: phase === 'update-failure-rollback' ? 'EXPECTED_FAILURE_ROLLBACK_CONFIRMED' : 'PASS',
      duration_ms: 1,
    })),
    artifacts: {
      trust_before: { file: 'trust-before.json', sha256: sha256(beforePath) },
      trust_after: { file: 'trust-after.json', sha256: sha256(afterPath) },
      trust_comparison: { file: 'trust-comparison.json', sha256: sha256(comparisonPath) },
    },
    updated_at: '2026-09-06T20:02:00.0000000+00:00',
  }
  writeJson(join(directory, 'lifecycle-report.json'), report)
  return directory
}

function run(directory, report = join(directory, 'lifecycle-report.json')) {
  return spawnSync(pwsh, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-File', verifier,
    '-ReportPath', report,
    '-EvidenceDirectory', directory,
    '-ExpectedReportSha256', sha256(report),
    '-ExpectedInitialCommit', commits[0],
    '-ExpectedUpgradeCommit', commits[1],
    '-ExpectedFailureCommit', commits[2],
  ], { encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })
}

function mutateReport(directory, mutate) {
  const path = join(directory, 'lifecycle-report.json')
  const report = JSON.parse(readFileSync(path, 'utf8'))
  mutate(report)
  writeJson(path, report)
}

function refreshArtifact(directory, key) {
  const reportPath = join(directory, 'lifecycle-report.json')
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  report.artifacts[key].sha256 = sha256(join(directory, report.artifacts[key].file))
  writeJson(reportPath, report)
}

test('gate M78 aceita somente a evidência real completa e intacta', (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'dz23-m78-pass-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  const directory = createFixture(scratch)
  const result = run(directory)
  assert.notEqual(result.error?.code, 'ENOENT', 'PowerShell 7 é obrigatório para o gate M78.')
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.equal(result.stdout.trim(), 'DZ23_M78_RELEASE_EVIDENCE=PASS')
})

test('gate M78 rejeita pacote inteiramente refeito sem o digest externo confiável', (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'dz23-m78-forged-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  const directory = createFixture(scratch)
  const reportPath = join(directory, 'lifecycle-report.json')
  const trustedDigest = sha256(reportPath)
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  report.updated_at = '2026-09-06T20:03:00.0000000+00:00'
  writeJson(reportPath, report)
  assert.notEqual(sha256(reportPath), trustedDigest)
  const result = spawnSync(pwsh, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-File', verifier,
    '-ReportPath', reportPath,
    '-EvidenceDirectory', directory,
    '-ExpectedReportSha256', trustedDigest,
    '-ExpectedInitialCommit', commits[0],
    '-ExpectedUpgradeCommit', commits[1],
    '-ExpectedFailureCommit', commits[2],
  ], { encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(`${result.stdout}\n${result.stderr}`, /canal confiável/iu)
})

test('gate M78 falha fechado para simulação e adulterações estruturais', (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'dz23-m78-negative-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  const cases = [
    ['simulated', (directory) => mutateReport(directory, (report) => { report.state = 'SIMULATED_PASS'; report.execution_mode = 'SIMULATED' })],
    ['duplicate-phase', (directory) => mutateReport(directory, (report) => { report.phases[1] = { ...report.phases[0] } })],
    ['unknown-status', (directory) => mutateReport(directory, (report) => { report.phases[0].status = 'OK' })],
    ['changed-hash', (directory) => writeFileSync(join(directory, 'trust-before.json'), '{}\n', 'utf8')],
    ['missing-file', (directory) => rmSync(join(directory, 'trust-after.json'))],
    ['path-traversal', (directory) => mutateReport(directory, (report) => { report.artifacts.trust_before.file = '../trust-before.json' })],
    ['duplicate-json-property', (directory) => {
      const path = join(directory, 'lifecycle-report.json')
      const text = readFileSync(path, 'utf8').replace('"state": "PASS",', '"state": "PASS",\n  "state": "PASS",')
      writeFileSync(path, text, 'utf8')
    }],
    ['reparse-artifact', (directory) => {
      const path = join(directory, 'trust-before.json')
      const target = join(scratch, 'external-artifact-directory')
      if (!existsSync(target)) mkdirSync(target)
      rmSync(path)
      symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
    }],
    ['comparison-lie', (directory) => {
      const path = join(directory, 'trust-comparison.json')
      const comparison = JSON.parse(readFileSync(path, 'utf8'))
      comparison.invariant.trust_store_unchanged = false
      writeJson(path, comparison)
      refreshArtifact(directory, 'trust_comparison')
    }],
    ['snapshot-changed', (directory) => {
      const path = join(directory, 'trust-after.json')
      const after = JSON.parse(readFileSync(path, 'utf8'))
      after.windows.certificates[0].certificate_sha256 = '9'.repeat(64)
      writeJson(path, after)
      refreshArtifact(directory, 'trust_after')
    }],
  ]
  for (const [name, mutate] of cases) {
    const directory = createFixture(scratch, name)
    mutate(directory)
    const result = run(directory)
    assert.notEqual(result.status, 0, `${name} foi aceito:\n${result.stdout}\n${result.stderr}`)
    assert.doesNotMatch(result.stdout, /DZ23_M78_RELEASE_EVIDENCE=PASS/u, name)
  }
})

test('gate M78 rejeita raiz de evidência atravessando junction/reparse point', { skip: process.platform !== 'win32' }, (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'dz23-m78-reparse-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  const real = createFixture(scratch, 'real-evidence')
  const linked = join(dirname(real), 'linked-evidence')
  symlinkSync(real, linked, 'junction')
  const result = run(linked, join(linked, 'lifecycle-report.json'))
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(`${result.stdout}\n${result.stderr}`, /reparse points/iu)
})

test('gate M78 é somente leitura e não chama Docker, WSL, rede ou trust mutation', () => {
  const source = readFileSync(verifier, 'utf8')
  assert.doesNotMatch(source, /\bwsl\.exe\b|\bdocker\b\s+(?:run|start|exec|compose)|Invoke-WebRequest|Invoke-RestMethod|Start-Process|Start-Service/iu)
  assert.doesNotMatch(source, /Import-Certificate|certutil|update-ca-certificates|Remove-Item|Move-Item|WriteAllText|WriteAllBytes/iu)
  assert.match(source, /SIMULATED_PASS/u)
  assert.match(source, /DZ23_M78_RELEASE_EVIDENCE=PASS/u)
  assert.ok(existsSync(verifier))
})

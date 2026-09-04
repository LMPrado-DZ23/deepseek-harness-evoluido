import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const windows = path.join(root, 'deploy', 'windows')
const scripts = ['install.ps1', 'doctor.ps1', 'update.ps1', 'uninstall.ps1']
const fullCommit = 'a'.repeat(40)
const image = `registry.example/dz23-studio@sha256:${'b'.repeat(64)}`

for (const name of scripts) {
  const source = readFileSync(path.join(windows, name), 'utf8')
  assert.doesNotMatch(source, /certutil|Import-Certificate|RootCertificate|netsh|mitm|tproxy|Start-Process\s+[^\n]*-Verb\s+RunAs/i)
  assert.doesNotMatch(source, /TODO|FIXME/)
  assert.match(source, /Set-StrictMode -Version Latest/)
}

const moduleSource = readFileSync(path.join(windows, 'Dz23.Windows.psm1'), 'utf8')
assert.match(moduleSource, /execute novamente como usuário comum/)
assert.match(moduleSource, /microsoft-standard-wsl2/)
assert.match(moduleSource, /contêineres Linux/)
assert.match(moduleSource, /@sha256:\[0-9a-f\]\{64\}/)
assert.match(moduleSource, /Resolve-Dz23InstallRoot/)
assert.doesNotMatch(moduleSource, /TODO|FIXME/)

const pwsh = process.platform === 'win32' ? 'pwsh.exe' : 'pwsh'
const probe = spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `
  $ErrorActionPreference = 'Stop'
  Import-Module '${path.join(windows, 'Dz23.Windows.psm1').replaceAll("'", "''")}' -Force
  Assert-Dz23Commit '${fullCommit}'
  Assert-Dz23ImageDigest '${image}'
  Assert-Dz23LinuxPath '/home/teste/dz23-studio'
  if ((Resolve-Dz23InstallRoot -Distro Ubuntu -InstallRoot '/home/teste/dz23-studio') -ne '/home/teste/dz23-studio') { exit 10 }
  $native = Invoke-Dz23Native -FilePath (Get-Process -Id $PID).Path -ArgumentList @('-NoLogo', '-NoProfile', '-Command', '[Console]::Write("argument with space")')
  if ($native.ExitCode -ne 0 -or $native.StdOut -ne 'argument with space') { Write-Output ($native | ConvertTo-Json -Compress); exit 8 }
  $failed = 0
  try { Assert-Dz23Commit 'abc' } catch { $failed++ }
  try { Assert-Dz23ImageDigest 'dz23-studio:latest' } catch { $failed++ }
  try { Assert-Dz23LinuxPath '/mnt/c/dz23-studio' } catch { $failed++ }
  try { Assert-Dz23LinuxPath '/home' } catch { $failed++ }
  if ($failed -ne 4) { exit 9 }
`], { encoding: 'utf8' })

if (probe.error?.code === 'ENOENT') {
  console.log('SKIP: PowerShell 7 não está disponível neste ambiente; inspeção estática passou.')
} else {
  assert.equal(probe.status, 0, `${probe.stdout}\n${probe.stderr}`)
}

const update = readFileSync(path.join(windows, 'update.ps1'), 'utf8')
assert.match(update, /\.current\.rollback/)
assert.match(update, /versão anterior restaurada/)
const uninstall = readFileSync(path.join(windows, 'uninstall.ps1'), 'utf8')
assert.match(uninstall, /preservar dados e releases/)
assert.match(uninstall, /APAGAR DADOS DO DZ23 STUDIO/)

if (!probe.error) {
  const simulation = spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(root, 'tests', 'm6', 'simulate-windows-shell.ps1')], { encoding: 'utf8' })
  assert.equal(simulation.status, 0, `${simulation.stdout}\n${simulation.stderr}`)
  assert.match(simulation.stdout, /M6_COMMAND_SIMULATION=PASS/)
}

console.log('M6 Windows shell: PASS (contratos de segurança e validações simuladas).')

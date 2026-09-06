import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const windows = path.join(root, 'deploy', 'windows')
const modulePath = path.join(windows, 'Dz23.Windows.psm1')
const wrapperPath = path.join(windows, 'preflight.ps1')
const moduleSource = readFileSync(modulePath, 'utf8')
const wrapperSource = readFileSync(wrapperPath, 'utf8')

assert.match(wrapperSource, /Set-StrictMode -Version Latest/u)
assert.match(wrapperSource, /Invoke-Dz23WindowsPreflight/u)
assert.match(wrapperSource, /ConvertTo-Json/u)
assert.match(moduleSource, /--wait-timeout/u)
assert.match(moduleSource, /ls-tree -r -z --full-tree HEAD \| sha256sum/u)
assert.match(moduleSource, /'\/usr\/bin\/env', '-i'/u)
assert.match(moduleSource, /studio\.dz23\.localhost:8080/u)
assert.doesNotMatch(moduleSource, /@\(80, 443, 20128, 20130\)/u)
assert.doesNotMatch(wrapperSource, /Start-Process|RunAs|Install-|Set-NetFirewall|New-NetFirewall|netsh|Set-Dns|Add-Content|Set-Content|docker(?:\.exe)?\s+compose\s+up/iu)

const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'dz23-preflight-ação-'))
try {
  const escapedModule = modulePath.replaceAll("'", "''")
  const escapedFixture = fixtureRoot.replaceAll("'", "''")
  const probe = `
$ErrorActionPreference = 'Stop'
$env:DZ23_M6_TEST_MODE = '1'
Import-Module '${escapedModule}' -Force

$goodWsl = @'
kernel=5.15.153.1-microsoft-standard-WSL2
home_fs=ext2/ext3
home_path=/home/tester
available_kb=104857600
util_git=1
util_docker=1
util_bash=1
util_id=1
util_getent=1
util_cut=1
util_stat=1
util_df=1
util_realpath=1
util_mountpoint=1
util_findmnt=1
util_sha256sum=1
util_gzip=1
util_flock=1
util_od=1
util_awk=1
util_sed=1
util_grep=1
util_sort=1
docker_os=linux
'@

function New-TestInvoker([string]$Scenario) {
  $captured = $Scenario
  {
    param($FilePath, $ArgumentList)
    $joined = $ArgumentList -join ' '
    if ($FilePath -eq 'wsl.exe') {
      if ($joined -match 'wslpath') { return [pscustomobject]@{ ExitCode = 0; StdOut = '/home/tester/source'; StdErr = '' } }
      if ($joined -match 'manifest_sha256') {
        $code = if ($captured -eq 'upstream-bad') { 19 } else { 0 }
        return [pscustomobject]@{ ExitCode = $code; StdOut = ''; StdErr = 'token=ULTRA_SECRET_VALUE' }
      }
      if ($captured -eq 'missing') { return [pscustomobject]@{ ExitCode = 127; StdOut = ''; StdErr = 'token=ULTRA_SECRET_VALUE' } }
      $body = $goodWsl
      if ($captured -eq 'mnt') { $body = $body.Replace('home_path=/home/tester', 'home_path=/mnt/c/tester') }
      if ($captured -eq 'low-disk') { $body = $body.Replace('available_kb=104857600', 'available_kb=1048576') }
      if ($captured -eq 'malformed-wsl') { $body = 'senha=ULTRA_SECRET_VALUE' }
      return [pscustomobject]@{ ExitCode = 0; StdOut = $body; StdErr = '' }
    }
    if ($FilePath -eq 'git.exe') {
      if ($captured -eq 'missing') { return [pscustomobject]@{ ExitCode = 127; StdOut = ''; StdErr = '' } }
      $version = if ($captured -eq 'localized') { 'versión git dois' } else { 'git version 2.45.1.windows.1' }
      return [pscustomobject]@{ ExitCode = 0; StdOut = $version; StdErr = '' }
    }
    if ($FilePath -eq 'docker.exe') {
      if ($captured -eq 'missing') { return [pscustomobject]@{ ExitCode = 127; StdOut = ''; StdErr = 'Bearer ULTRA_SECRET_VALUE' } }
      if ($joined -eq 'info --format {{.OSType}}') {
        $kind = if ($captured -eq 'windows-container') { 'windows' } else { 'linux' }
        return [pscustomobject]@{ ExitCode = 0; StdOut = $kind; StdErr = '' }
      }
      if ($joined -eq 'compose version --short') {
        $version = if ($captured -eq 'malformed-version') { 'Docker Compose versão dois' } else { 'v2.32.4' }
        return [pscustomobject]@{ ExitCode = 0; StdOut = $version; StdErr = '' }
      }
      if ($joined -eq 'compose up --help') { return [pscustomobject]@{ ExitCode = 0; StdOut = '--wait --wait-timeout TIME --no-build'; StdErr = '' } }
      if ($joined -eq 'compose config --help') { return [pscustomobject]@{ ExitCode = 0; StdOut = '--images --services --volumes --networks --quiet'; StdErr = '' } }
      if ($joined -eq 'compose ps --help') {
        $help = if ($captured -eq 'missing-flag') { '--status --services' } else { '--status --services --quiet' }
        return [pscustomobject]@{ ExitCode = 0; StdOut = $help; StdErr = '' }
      }
    }
    return [pscustomobject]@{ ExitCode = 127; StdOut = ''; StdErr = 'password=ULTRA_SECRET_VALUE' }
  }.GetNewClosure()
}

$healthySystem = @{
  IsWindows = $true; PowerShellMajor = 7; WindowsBuild = 26100; CpuCount = 8
  MemoryBytes = 32GB; Virtualization = $true; LongPathsEnabled = $true
}
$firewall = @{ Available = $true; AllEnabled = $true }
$clock = @{ Readable = $true; ServiceRunning = $true; UtcYear = 2026 }

function Invoke-Scenario {
  param(
    [string]$Scenario,
    [hashtable]$System = $healthySystem,
    [object[]]$Ports = @(),
    [string]$Profile = 'local',
    [string]$Hostname = '',
    [string]$Origin = '',
    [string]$RpId = '',
    [AllowNull()][string[]]$Dns = @('100.64.0.1'),
    [string]$Source = ''
  )
  $arguments = @{
    Distro = 'Ubuntu'; Profile = $Profile; Hostname = $Hostname; Origin = $Origin; RpId = $RpId
    SourcePath = $Source; CommandInvoker = (New-TestInvoker $Scenario); SystemSnapshot = $System
    PortSnapshot = $Ports; DnsSnapshot = $Dns; FirewallSnapshot = $firewall; ClockSnapshot = $clock
  }
  Invoke-Dz23WindowsPreflight @arguments
}

function Assert-State($Report, [string]$Id, [string]$State) {
  $check = @($Report.checks | Where-Object id -eq $Id)
  if ($check.Count -ne 1 -or $check[0].state -ne $State) {
    throw "Estado inesperado para \${Id}: $($check | ConvertTo-Json -Compress)"
  }
}

$good = Invoke-Scenario good
if ($good.exit_code -ne 0 -or $good.overall_state -ne 'NOT_CONFIGURED') { throw ($good | ConvertTo-Json -Depth 8 -Compress) }
Assert-State $good 'docker.engine' PASS
Assert-State $good 'compose.flags' PASS
Assert-State $good 'network.dns' NOT_CONFIGURED
if (-not $good.safety.read_only -or $good.safety.services_started -or $good.safety.endpoint_contacted -or $good.safety.dns_queried -or -not $good.safety.local_docker_daemon_queried) { throw 'Contrato read-only inválido.' }
if (($good.checks | Where-Object id -eq 'network.ports').details.ports -join ',' -ne '8080,8443') { throw 'Portas locais padrão divergentes.' }

foreach ($case in @(
  @{ Scenario = 'missing'; Id = 'docker.engine' },
  @{ Scenario = 'windows-container'; Id = 'docker.engine' },
  @{ Scenario = 'mnt'; Id = 'wsl.linux-filesystem' },
  @{ Scenario = 'low-disk'; Id = 'resources.disk' },
  @{ Scenario = 'malformed-wsl'; Id = 'wsl.distro' },
  @{ Scenario = 'localized'; Id = 'git.windows' },
  @{ Scenario = 'malformed-version'; Id = 'compose.version' },
  @{ Scenario = 'missing-flag'; Id = 'compose.flags' }
)) {
  $report = Invoke-Scenario $case.Scenario
  Assert-State $report $case.Id BLOCKED
  if ($report.exit_code -eq 0) { throw "$($case.Scenario): bloqueio retornou zero" }
}

$weak = $healthySystem.Clone(); $weak.CpuCount = 5; $weak.MemoryBytes = 12GB
$weakReport = Invoke-Scenario good -System $weak
Assert-State $weakReport 'resources.cpu' WARN
Assert-State $weakReport 'resources.memory' WARN
if ($weakReport.overall_state -eq 'PASS') { throw 'WARN foi promovido indevidamente a PASS.' }

$tiny = $healthySystem.Clone(); $tiny.CpuCount = 2; $tiny.MemoryBytes = 4GB
$tinyReport = Invoke-Scenario good -System $tiny
Assert-State $tinyReport 'resources.cpu' BLOCKED
Assert-State $tinyReport 'resources.memory' BLOCKED

$omniRoutePresent = Invoke-Scenario good -Ports @([pscustomobject]@{ Port = 20128; ProcessName = 'OmniRoute' })
Assert-State $omniRoutePresent 'network.ports' PASS
$occupied = Invoke-Scenario good -Ports @([pscustomobject]@{ Port = 8080; ProcessName = 'token=ULTRA_SECRET_VALUE' })
Assert-State $occupied 'network.ports' BLOCKED
$occupiedJson = $occupied | ConvertTo-Json -Depth 8 -Compress
if ($occupiedJson -match 'ULTRA_SECRET_VALUE') { throw 'Segredo vazou no relatório de porta.' }
if ($occupiedJson -notmatch 'processo-redigido') { throw 'Processo sensível não foi redigido.' }

$mismatch = Invoke-Scenario good -Profile public -Hostname app.dz23.com.br -Origin 'https://outro.dz23.com.br' -RpId app.dz23.com.br -Dns @('192.0.2.10')
Assert-State $mismatch 'identity.profile' BLOCKED
$dnsMissing = Invoke-Scenario good -Profile public -Hostname app.dz23.com.br -Origin 'https://app.dz23.com.br' -RpId app.dz23.com.br -Dns @()
Assert-State $dnsMissing 'network.dns' BLOCKED

$source = '${escapedFixture}'
New-Item -ItemType File -Path (Join-Path $source 'UPSTREAM.lock') | Out-Null
New-Item -ItemType File -Path (Join-Path $source '.gitmodules') | Out-Null
$upstreamBad = Invoke-Scenario upstream-bad -Source $source
Assert-State $upstreamBad 'source.upstream-pin' BLOCKED
$upstreamBadJson = $upstreamBad | ConvertTo-Json -Depth 8 -Compress
if ($upstreamBadJson -match 'ULTRA_SECRET_VALUE' -or $upstreamBadJson -match [regex]::Escape($source)) { throw 'Erro ou caminho sensível vazou.' }

$preAbuse = $false
$env:DZ23_M6_TEST_MODE = '0'
try { Invoke-Dz23WindowsPreflight -Distro Ubuntu -CommandInvoker (New-TestInvoker good) | Out-Null } catch { $preAbuse = $true }
if (-not $preAbuse) { throw 'Injeção foi aceita fora do modo de teste.' }

'M64A_WINDOWS_PREFLIGHT=PASS scenarios=18 read_only=true secrets=redacted'
`
  const encoded = Buffer.from(probe, 'utf16le').toString('base64')
  const pwsh = process.platform === 'win32' ? 'pwsh.exe' : 'pwsh'
  const result = spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
  })
  assert.notEqual(result.error?.code, 'ENOENT', 'PowerShell 7 é obrigatório para provar o preflight Windows.')
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error ?? ''}`)
  assert.match(result.stdout, /M64A_WINDOWS_PREFLIGHT=PASS scenarios=18 read_only=true secrets=redacted/u)
} finally {
  await rm(fixtureRoot, { recursive: true, force: true })
}

console.log('M6.4-A Windows preflight: PASS (18 cenários herméticos e adversariais).')

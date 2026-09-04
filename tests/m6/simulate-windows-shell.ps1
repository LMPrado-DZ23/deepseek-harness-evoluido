Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$env:DZ23_M6_TEST_MODE = '1'

$commit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
$digest = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
$image = "registry.example/dz23-studio@sha256:$digest"
$calls = [Collections.Generic.List[string]]::new()
$invoker = {
    param([string]$FilePath, [string[]]$ArgumentList)
    $calls.Add("$FilePath $($ArgumentList -join ' ')")
    if ($FilePath -eq 'docker.exe' -and $ArgumentList[0] -eq 'info') {
        return [pscustomobject]@{ ExitCode = 0; StdOut = 'linux'; StdErr = '' }
    }
    if ($FilePath -eq 'docker.exe' -and $ArgumentList[0] -eq 'image') {
        return [pscustomobject]@{ ExitCode = 0; StdOut = "[`"registry.example/dz23-studio@sha256:$digest`"]"; StdErr = '' }
    }
    if ($FilePath -eq 'git.exe' -and $ArgumentList -contains 'rev-parse') {
        return [pscustomobject]@{ ExitCode = 0; StdOut = $commit; StdErr = '' }
    }
    if ($FilePath -eq 'git.exe' -and $ArgumentList -contains 'status') {
        return [pscustomobject]@{ ExitCode = 0; StdOut = ''; StdErr = '' }
    }
    if ($FilePath -eq 'wsl.exe') {
        return [pscustomobject]@{ ExitCode = 0; StdOut = ''; StdErr = '' }
    }
    return [pscustomobject]@{ ExitCode = 91; StdOut = ''; StdErr = "Comando simulado inesperado: $FilePath" }
}

& (Join-Path $PSScriptRoot '../../deploy/windows/install.ps1') -SourcePath 'C:\audited\studio' `
    -ExpectedCommit $commit -Image $image -InstallRoot '/home/test/.local/share/dz23-studio' `
    -WhatIf -CommandInvoker $invoker
& (Join-Path $PSScriptRoot '../../deploy/windows/update.ps1') -SourcePath 'C:\audited\studio' `
    -ExpectedCommit $commit -Image $image -SecretsFile '/home/test/.config/dz23/secrets.env' `
    -InstallRoot '/home/test/.local/share/dz23-studio' -WhatIf -CommandInvoker $invoker
& (Join-Path $PSScriptRoot '../../deploy/windows/doctor.ps1') -ExpectedCommit $commit -Image $image `
    -InstallRoot '/home/test/.local/share/dz23-studio' -CommandInvoker $invoker
& (Join-Path $PSScriptRoot '../../deploy/windows/uninstall.ps1') -InstallRoot '/home/test/.local/share/dz23-studio' `
    -WhatIf -CommandInvoker $invoker

if ($calls.Count -lt 13) { throw 'Poucos comandos passaram pelo executor simulado.' }
if (-not ($calls | Where-Object { $_ -like 'docker.exe image inspect*' })) { throw 'A conferência do digest não foi simulada.' }
if (-not ($calls | Where-Object { $_ -like 'git.exe *rev-parse*' })) { throw 'A conferência do commit não foi simulada.' }
if (-not ($calls | Where-Object { $_ -like 'wsl.exe *' })) { throw 'A conferência do WSL2 não foi simulada.' }
Write-Output "M6_COMMAND_SIMULATION=PASS calls=$($calls.Count)"

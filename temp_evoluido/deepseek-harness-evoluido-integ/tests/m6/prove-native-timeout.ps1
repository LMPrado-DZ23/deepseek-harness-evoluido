Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$modulePath = Join-Path $PSScriptRoot '../../deploy/windows/Dz23.Windows.psm1'
$fixturePath = Join-Path $PSScriptRoot 'timeout-fixture.ps1'
Import-Module $modulePath -Force

$proofRoot = Join-Path ([IO.Path]::GetTempPath()) "dz23-m6-timeout-$([Guid]::NewGuid().ToString('N'))"
$parentPid = $null
$childPid = $null
$secret = 'DZ23-M6-SECRET-MUST-NOT-ESCAPE'
[IO.Directory]::CreateDirectory($proofRoot) | Out-Null

try {
    $env:DZ23_TIMEOUT_SECRET = $secret
    $currentPwsh = (Get-Process -Id $PID).Path
    $timedOut = Invoke-Dz23Native -FilePath $currentPwsh `
        -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', $fixturePath, '-PidDirectory', $proofRoot) `
        -TimeoutSeconds 10 -OutputLimit 1024

    if ($timedOut.ExitCode -ne 124) { throw "O processo travado retornou $($timedOut.ExitCode), não timeout 124." }
    if ($timedOut.StdErr -notmatch 'tempo limite de 10s') { throw 'O timeout não retornou erro genérico reconhecível.' }
    if (($timedOut.StdOut + $timedOut.StdErr).Contains($secret)) { throw 'A saída do timeout vazou o segredo do subprocesso.' }

    $parentPid = [int](Get-Content -LiteralPath (Join-Path $proofRoot 'parent.pid') -Raw)
    $childPid = [int](Get-Content -LiteralPath (Join-Path $proofRoot 'child.pid') -Raw)
    Start-Sleep -Milliseconds 500
    if (Get-Process -Id $parentPid -ErrorAction SilentlyContinue) { throw 'O processo pai sobreviveu ao timeout.' }
    if (Get-Process -Id $childPid -ErrorAction SilentlyContinue) { throw 'O processo filho sobreviveu ao timeout.' }

    $bounded = Invoke-Dz23Native -FilePath $currentPwsh `
        -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '[Console]::Write("x" * 4096)') `
        -TimeoutSeconds 10 -OutputLimit 1024
    if ($bounded.ExitCode -ne 0) { throw 'A prova de saída limitada falhou ao executar.' }
    if ($bounded.StdOut.Length -gt 1050 -or $bounded.StdOut -notmatch '\[saída truncada\]$') {
        throw "A saída não foi limitada corretamente: $($bounded.StdOut.Length) caracteres."
    }

    Write-Output 'M6_NATIVE_TIMEOUT=PASS tree=terminated secret=redacted output=bounded'
}
finally {
    Remove-Item Env:DZ23_TIMEOUT_SECRET -ErrorAction SilentlyContinue
    foreach ($processId in @($parentPid, $childPid)) {
        if ($processId -and (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
            Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
        }
    }
    if (Test-Path -LiteralPath $proofRoot) {
        Remove-Item -LiteralPath $proofRoot -Recurse -Force
    }
}

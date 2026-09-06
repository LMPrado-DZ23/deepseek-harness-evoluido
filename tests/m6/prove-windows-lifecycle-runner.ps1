Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$runner = Join-Path $root 'deploy/windows/Invoke-Dz23LifecycleProof.ps1'
$scratch = Join-Path ([IO.Path]::GetTempPath()) ("dz23-m77-" + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($scratch) | Out-Null
$env:DZ23_M77_TEST_MODE = '1'

$base = @{
    InitialSourcePath = 'C:\audit\initial'
    InitialCommit = ('a' * 40)
    InitialImage = ('registry.example/dz23-initial@sha256:' + ('1' * 64))
    UpgradeSourcePath = 'C:\audit\upgrade'
    UpgradeCommit = ('b' * 40)
    UpgradeImage = ('registry.example/dz23-upgrade@sha256:' + ('2' * 64))
    FailureSourcePath = 'C:\audit\failure'
    FailureCommit = ('c' * 40)
    FailureImage = ('registry.example/dz23-failure@sha256:' + ('3' * 64))
    CaddyImage = ('registry.example/dz23-caddy@sha256:' + ('4' * 64))
    SecretsFile = '/home/test/.config/dz23/m77.env'
    InstallRoot = '/home/test/.local/share/dz23-m77-proof'
    Distro = 'Ubuntu'
}

try {
    $global:M77Calls = [System.Collections.Generic.List[string]]::new()
    $never = {
        param($Name, $Context)
        $global:M77Calls.Add($Name)
        throw 'O prepare mode não deveria invocar operações.'
    }
    $preparedPath = Join-Path $scratch 'prepared'
    $prepared = & $runner @base -EvidenceDirectory $preparedPath -OperationInvoker $never
    if ($prepared.state -cne 'PREPARED_NOT_EXECUTED' -or $global:M77Calls.Count -ne 0 -or (Test-Path $preparedPath)) {
        throw 'Prepare mode alterou estado ou chamou operação.'
    }

    $badConfirmationPath = Join-Path $scratch 'bad-confirmation'
    try {
        & $runner @base -EvidenceDirectory $badConfirmationPath -Execute `
            -ExecutionConfirmation 'sim' -OperationInvoker $never -Confirm:$false | Out-Null
        throw 'Confirmação fraca foi aceita.'
    } catch {
        if ($_.Exception.Message -notmatch 'confirmação literal') { throw }
    }
    if ($global:M77Calls.Count -ne 0 -or (Test-Path $badConfirmationPath)) {
        throw 'Confirmação inválida alterou estado.'
    }

    $global:M77Calls.Clear()
    $successInvoker = {
        param($Name, $Context)
        $global:M77Calls.Add($Name)
        if ($Name -in @('trust-before', 'trust-after')) {
            [IO.File]::WriteAllText($Context.OutputPath, "{`"schema_version`":1,`"state`":`"PASS`"}`n")
        } elseif ($Name -eq 'trust-compare') {
            [IO.File]::WriteAllText($Context.ReportPath, "{`"state`":`"PASS`",`"invariant`":{`"trust_store_unchanged`":true}}`n")
        } elseif ($Name -eq 'update-failure-rollback') {
            throw 'Atualização falhou; rollback executado e readiness da versão anterior confirmado'
        }
    }
    $successPath = Join-Path $scratch 'success'
    $result = & $runner @base -EvidenceDirectory $successPath -Execute `
        -ExecutionConfirmation 'EXECUTAR PROVA REAL M77 EM AMBIENTE DESCARTAVEL' `
        -OperationInvoker $successInvoker -Confirm:$false
    if ($result.state -cne 'SIMULATED_PASS' -or $result.phases -ne 17) { throw 'Fluxo simulado completo não terminou SIMULATED_PASS.' }
    $expected = @(
        'trust-before', 'isolation-preflight', 'install-initial', 'doctor-initial',
        'sentinel-create', 'update-success', 'doctor-upgrade', 'update-failure-rollback',
        'doctor-after-rollback', 'uninstall-preserve', 'reinstall-preserve',
        'doctor-reinstall', 'sentinel-verify', 'uninstall-final-preserve',
        'trust-after', 'trust-compare'
    )
    if (($global:M77Calls -join '|') -cne ($expected -join '|')) { throw 'A ordem do lifecycle divergiu do contrato.' }
    $reportText = Get-Content -Raw -LiteralPath (Join-Path $successPath 'lifecycle-report.json')
    $report = $reportText | ConvertFrom-Json
    if ($report.state -cne 'SIMULATED_PASS' -or $report.final_state -cne 'SIMULATED_NO_REAL_STATE_CHANGE') { throw 'Relatório simulado foi confundido com prova real.' }
    if ($reportText.Contains($base.SecretsFile) -or $reportText -match '"token"\s*:') { throw 'Relatório expôs caminho de segredo ou token do sentinela.' }
    if ((@($report.phases | Where-Object status -eq 'EXPECTED_FAILURE_ROLLBACK_CONFIRMED')).Count -ne 1) {
        throw 'Rollback esperado não foi registrado uma única vez.'
    }
    if ($report.phases[-1].name -cne 'evidence-finalize' -or $report.phases[-1].status -cne 'PASS') {
        throw 'A finalização de evidências não foi registrada.'
    }
    if ($report.execution_mode -cne 'SIMULATED' -or $report.source_and_images -cne 'PARTIAL_OR_NOT_VERIFIED') {
        throw 'O relatório simulado declarou verificação real.'
    }
    if ($report.docker_desktop_started_by_runner -ne $false -or $report.docker_containers -cne 'SIMULATED_ONLY') {
        throw 'O relatório não distingue Docker Desktop de contêineres.'
    }
    if ($reportText -match '"state"\s*:\s*"PASS"') { throw 'A simulação ainda emitiu state PASS.' }

    try {
        & $runner @base -EvidenceDirectory $successPath -Execute `
            -ExecutionConfirmation 'EXECUTAR PROVA REAL M77 EM AMBIENTE DESCARTAVEL' `
            -OperationInvoker $successInvoker -Confirm:$false | Out-Null
        throw 'EvidenceDirectory existente foi sobrescrito.'
    } catch {
        if ($_.Exception.Message -notmatch 'já existe') { throw }
    }

    $unexpectedInvoker = {
        param($Name, $Context)
        if ($Name -in @('trust-before', 'trust-after')) {
            [IO.File]::WriteAllText($Context.OutputPath, "{`"state`":`"PASS`"}`n")
        } elseif ($Name -eq 'trust-compare') {
            [IO.File]::WriteAllText($Context.ReportPath, "{`"state`":`"PASS`",`"invariant`":{`"trust_store_unchanged`":true}}`n")
        }
    }
    $unexpectedPath = Join-Path $scratch 'unexpected-success'
    try {
        & $runner @base -EvidenceDirectory $unexpectedPath -Execute `
            -ExecutionConfirmation 'EXECUTAR PROVA REAL M77 EM AMBIENTE DESCARTAVEL' `
            -OperationInvoker $unexpectedInvoker -Confirm:$false | Out-Null
        throw 'A imagem de falha controlada passou sem ser detectada.'
    } catch {
        if ($_.Exception.Message -notmatch "fase M77 'update-failure-rollback' falhou") { throw }
    }
    $failed = Get-Content -Raw -LiteralPath (Join-Path $unexpectedPath 'lifecycle-report.json') | ConvertFrom-Json
    if ($failed.state -cne 'FAILED' -or $failed.phases[-1].name -cne 'update-failure-rollback') {
        throw 'Falha inesperada não foi preservada no relatório.'
    }

    $source = Get-Content -Raw -LiteralPath $runner
    if ($source -match 'Start-Process|Start-Service|Import-Certificate|certutil|update-ca-certificates') {
        throw 'O runner contém operação proibida de host ou trust store.'
    }
    if ($source -match '-PurgeData') { throw 'O runner nunca pode executar purge.' }

    Write-Output 'M77_LIFECYCLE_RUNNER=PASS prepare=no-side-effects confirmation=literal operations=16 phases=17 rollback=expected persistence=sentinel trust=compared final=uninstalled-data-preserved'
}
finally {
    Remove-Item Env:DZ23_M77_TEST_MODE -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Variable M77Calls -Scope Global -ErrorAction SilentlyContinue
}

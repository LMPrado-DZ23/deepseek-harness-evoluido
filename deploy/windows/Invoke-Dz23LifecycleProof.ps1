[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory)][string]$InitialSourcePath,
    [Parameter(Mandatory)][string]$InitialCommit,
    [Parameter(Mandatory)][string]$InitialImage,
    [Parameter(Mandatory)][string]$UpgradeSourcePath,
    [Parameter(Mandatory)][string]$UpgradeCommit,
    [Parameter(Mandatory)][string]$UpgradeImage,
    [Parameter(Mandatory)][string]$FailureSourcePath,
    [Parameter(Mandatory)][string]$FailureCommit,
    [Parameter(Mandatory)][string]$FailureImage,
    [Parameter(Mandatory)][string]$CaddyImage,
    [Parameter(Mandatory)][string]$SecretsFile,
    [Parameter(Mandatory)][string]$InstallRoot,
    [Parameter(Mandatory)][string]$EvidenceDirectory,
    [string]$Distro = 'Ubuntu',
    [switch]$Execute,
    [string]$ExecutionConfirmation,
    [scriptblock]$OperationInvoker
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$windowsRoot = $PSScriptRoot
Import-Module (Join-Path $windowsRoot 'Dz23.Windows.psm1') -Force

$commits = @($InitialCommit, $UpgradeCommit, $FailureCommit)
foreach ($commit in $commits) { Assert-Dz23Commit $commit }
if (($commits | Select-Object -Unique).Count -ne 3) {
    throw 'A prova exige três commits distintos: instalação, atualização e falha controlada.'
}
foreach ($image in @($InitialImage, $UpgradeImage, $FailureImage, $CaddyImage)) {
    Assert-Dz23ImageDigest $image
}
if ($FailureImage -ceq $UpgradeImage) {
    throw 'A imagem de falha controlada precisa ser diferente da imagem saudável da atualização.'
}
Assert-Dz23LinuxPath $InstallRoot 'diretório descartável da prova'
Assert-Dz23LinuxPath $SecretsFile 'arquivo de segredos da prova'
if ($Distro -cnotmatch '^[A-Za-z0-9._-]{1,80}$') { throw 'Nome de distribuição WSL inválido.' }
if ($OperationInvoker -and $env:DZ23_M77_TEST_MODE -ne '1') {
    throw 'O executor simulado do lifecycle é exclusivo dos testes.'
}

$plan = [ordered]@{
    schema_version = 1
    state = 'PREPARED_NOT_EXECUTED'
    distro = $Distro
    initial_commit = $InitialCommit
    upgrade_commit = $UpgradeCommit
    failure_commit = $FailureCommit
    planned_final_state = 'UNINSTALLED_DATA_PRESERVED'
    source_and_images = 'NOT_VERIFIED'
    docker_desktop_started_by_runner = $false
    docker_containers = 'NOT_STARTED'
    note = 'A execução exige Docker Desktop já iniciado externamente e um ambiente descartável sem instalação DZ23 existente.'
}

if (-not $Execute) {
    [pscustomobject]$plan
    return
}
if ($ExecutionConfirmation -cne 'EXECUTAR PROVA REAL M77 EM AMBIENTE DESCARTAVEL') {
    throw 'Execução recusada. Informe a confirmação literal documentada para um ambiente descartável.'
}
if (-not $PSCmdlet.ShouldProcess("$Distro`:$InstallRoot", 'Executar instalação, atualização, rollback, desinstalação e reinstalação reais')) {
    [pscustomobject]$plan
    return
}

function New-M77EvidenceDirectory {
    param([Parameter(Mandatory)][string]$Path)
    if (-not [IO.Path]::IsPathFullyQualified($Path)) { throw 'EvidenceDirectory precisa ser um caminho absoluto do Windows.' }
    if (Test-Path -LiteralPath $Path) { throw 'EvidenceDirectory já existe; a prova nunca sobrescreve evidência anterior.' }
    $parentText = Split-Path -Parent $Path
    $leaf = Split-Path -Leaf $Path
    if ([string]::IsNullOrWhiteSpace($parentText) -or $leaf -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]{2,100}$') {
        throw 'EvidenceDirectory precisa ter pai existente e nome de pasta simples.'
    }
    $parent = Get-Item -LiteralPath $parentText -Force -ErrorAction Stop
    if (-not $parent.PSIsContainer -or ($parent.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'O pai de EvidenceDirectory precisa ser uma pasta real, não um link.'
    }
    [IO.Directory]::CreateDirectory((Join-Path $parent.FullName $leaf))
}

function Write-M77Report {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$State,
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.List[object]]$Phases,
        [hashtable]$Artifacts = @{}
    )
    $payload = [ordered]@{
        schema_version = 1
        state = $State
        initial_commit = $InitialCommit
        upgrade_commit = $UpgradeCommit
        failure_commit = $FailureCommit
        final_state = switch ($State) {
            'PASS' { 'UNINSTALLED_DATA_PRESERVED' }
            'FAILED' { 'REQUIRES_INSPECTION' }
            default { 'IN_PROGRESS' }
        }
        source_and_images = if ($State -eq 'PASS') { 'VERIFIED_BY_LIFECYCLE_SCRIPTS' } else { 'PARTIAL_OR_NOT_VERIFIED' }
        docker_desktop_started_by_runner = $false
        docker_containers = 'STARTED_AND_STOPPED_DURING_PROOF'
        phases = @($Phases)
        artifacts = $Artifacts
        updated_at = [DateTimeOffset]::UtcNow.ToString('O')
    }
    $temporary = "$Path.$PID.tmp"
    [IO.File]::WriteAllText($temporary, (($payload | ConvertTo-Json -Depth 8) + "`n"), [Text.UTF8Encoding]::new($false))
    [IO.File]::Move($temporary, $Path, $true)
}

function Invoke-M77Sentinel {
    param([ValidateSet('create', 'verify')][string]$Action, [string]$Token)
    $sentinelScript = (Get-Dz23WslSafetyPrelude) + "`n" + @'
set -euo pipefail
root="$1"; secrets="$2"; action="$3"; token="$4"
printf '%s' "$token" | grep -Eq '^[0-9a-f]{64}$' || die 'Token da prova inválido' 170
root_real="$(secure_root "$root")"
secure_layout "$root_real"
acquire_operation_lock "$root_real"
assert_no_operation_journal "$root_real"
current="$(resolve_current_release "$root_real")"
commit="$(basename -- "$current")"
assert_release_repository "$root_real" "$current" "$commit"
assert_release_env "$current" "$commit"
assert_installed_commit "$root_real" "$commit"
validate_secrets "$secrets"
compose_for_release "$current" "$secrets" config --quiet
assert_compose_images_pinned "$current" "$secrets"
assert_compose_ready "$current" "$secrets"
if [ "$action" = create ]; then
  compose_for_release "$current" "$secrets" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U dz23_studio -d dz23_studio -q \
    -c "CREATE TABLE IF NOT EXISTS dz23_lifecycle_probe (id integer PRIMARY KEY CHECK (id = 1), token text NOT NULL); INSERT INTO dz23_lifecycle_probe(id, token) VALUES (1, '$token') ON CONFLICT (id) DO UPDATE SET token = EXCLUDED.token;" >/dev/null
elif [ "$action" = verify ]; then
  actual="$(compose_for_release "$current" "$secrets" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U dz23_studio -d dz23_studio -Atq \
    -c 'SELECT token FROM dz23_lifecycle_probe WHERE id = 1')"
  test "$actual" = "$token" || die 'O sentinela persistente não sobreviveu ao ciclo' 171
else
  die 'Ação de sentinela inválida' 172
fi
'@
    Invoke-Dz23WslScript -Distro $Distro -Script $sentinelScript `
        -Arguments @($InstallRoot, $SecretsFile, $Action, $Token) `
        -FailureMessage 'A prova de persistência falhou' -TimeoutSeconds 300 | Out-Null
}

function Invoke-M77IsolationProbe {
    Test-Dz23Prerequisites -Distro $Distro
    $probe = @'
set -euo pipefail
root="$1"
if [ -e "$root" ] || [ -L "$root" ]; then
  printf '%s\n' 'O diretório descartável já existe; execução recusada' >&2
  exit 180
fi
containers="$(docker ps -aq --filter 'label=com.docker.compose.project=dz23-studio'; docker ps -aq --filter 'name=^/dz23-studio-')"
volumes="$(docker volume ls -q --filter 'label=com.docker.compose.project=dz23-studio'; docker volume ls -q --filter 'name=^dz23-studio_')"
networks="$(docker network ls -q --filter 'label=com.docker.compose.project=dz23-studio'; docker network ls -q --filter 'name=^dz23-studio_')"
test -z "$(printf '%s\n' "$containers" | sed '/^$/d' | sort -u)" || { printf '%s\n' 'Já existem contêineres DZ23; use ambiente descartável' >&2; exit 181; }
test -z "$(printf '%s\n' "$volumes" | sed '/^$/d' | sort -u)" || { printf '%s\n' 'Já existem volumes DZ23; use ambiente descartável' >&2; exit 182; }
test -z "$(printf '%s\n' "$networks" | sed '/^$/d' | sort -u)" || { printf '%s\n' 'Já existem redes DZ23; use ambiente descartável' >&2; exit 183; }
'@
    Invoke-Dz23WslScript -Distro $Distro -Script $probe -Arguments @($InstallRoot) `
        -FailureMessage 'O ambiente não está isolado para a prova destrutiva' -TimeoutSeconds 120 | Out-Null
}

function Invoke-M77Operation {
    param([Parameter(Mandatory)][string]$Name, [hashtable]$Context = @{})
    if ($OperationInvoker) { return & $OperationInvoker $Name $Context }
    switch ($Name) {
        'trust-before' {
            & (Join-Path $windowsRoot 'Get-Dz23TrustStoreSnapshot.ps1') -OutputPath $Context.OutputPath -Distro $Distro | Out-Null
        }
        'isolation-preflight' { Invoke-M77IsolationProbe }
        'install-initial' {
            & (Join-Path $windowsRoot 'install.ps1') -SourcePath $InitialSourcePath -ExpectedCommit $InitialCommit `
                -Image $InitialImage -CaddyImage $CaddyImage -SecretsFile $SecretsFile -InstallRoot $InstallRoot `
                -Distro $Distro -Start -Confirm:$false
        }
        'doctor-initial' {
            & (Join-Path $windowsRoot 'doctor.ps1') -ExpectedCommit $InitialCommit -Image $InitialImage `
                -CaddyImage $CaddyImage -SecretsFile $SecretsFile -InstallRoot $InstallRoot -Distro $Distro
        }
        'sentinel-create' { Invoke-M77Sentinel -Action create -Token $Context.Token }
        'update-success' {
            & (Join-Path $windowsRoot 'update.ps1') -SourcePath $UpgradeSourcePath -ExpectedCommit $UpgradeCommit `
                -Image $UpgradeImage -CaddyImage $CaddyImage -SecretsFile $SecretsFile -InstallRoot $InstallRoot `
                -Distro $Distro -Confirm:$false
        }
        'doctor-upgrade' {
            & (Join-Path $windowsRoot 'doctor.ps1') -ExpectedCommit $UpgradeCommit -Image $UpgradeImage `
                -CaddyImage $CaddyImage -SecretsFile $SecretsFile -InstallRoot $InstallRoot -Distro $Distro
        }
        'update-failure-rollback' {
            & (Join-Path $windowsRoot 'update.ps1') -SourcePath $FailureSourcePath -ExpectedCommit $FailureCommit `
                -Image $FailureImage -CaddyImage $CaddyImage -SecretsFile $SecretsFile -InstallRoot $InstallRoot `
                -Distro $Distro -Confirm:$false
        }
        'doctor-after-rollback' {
            & (Join-Path $windowsRoot 'doctor.ps1') -ExpectedCommit $UpgradeCommit -Image $UpgradeImage `
                -CaddyImage $CaddyImage -SecretsFile $SecretsFile -InstallRoot $InstallRoot -Distro $Distro
        }
        'uninstall-preserve' {
            & (Join-Path $windowsRoot 'uninstall.ps1') -SecretsFile $SecretsFile -InstallRoot $InstallRoot `
                -Distro $Distro -Confirm:$false
        }
        'reinstall-preserve' {
            & (Join-Path $windowsRoot 'install.ps1') -SourcePath $UpgradeSourcePath -ExpectedCommit $UpgradeCommit `
                -Image $UpgradeImage -CaddyImage $CaddyImage -SecretsFile $SecretsFile -InstallRoot $InstallRoot `
                -Distro $Distro -Start -Confirm:$false
        }
        'doctor-reinstall' {
            & (Join-Path $windowsRoot 'doctor.ps1') -ExpectedCommit $UpgradeCommit -Image $UpgradeImage `
                -CaddyImage $CaddyImage -SecretsFile $SecretsFile -InstallRoot $InstallRoot -Distro $Distro
        }
        'sentinel-verify' { Invoke-M77Sentinel -Action verify -Token $Context.Token }
        'uninstall-final-preserve' {
            & (Join-Path $windowsRoot 'uninstall.ps1') -SecretsFile $SecretsFile -InstallRoot $InstallRoot `
                -Distro $Distro -Confirm:$false
        }
        'trust-after' {
            & (Join-Path $windowsRoot 'Get-Dz23TrustStoreSnapshot.ps1') -OutputPath $Context.OutputPath -Distro $Distro | Out-Null
        }
        'trust-compare' {
            & (Join-Path $windowsRoot 'Compare-Dz23TrustStoreSnapshot.ps1') -BeforePath $Context.BeforePath `
                -AfterPath $Context.AfterPath -ReportPath $Context.ReportPath | Out-Null
            $comparison = Get-Content -Raw -LiteralPath $Context.ReportPath | ConvertFrom-Json
            if ($comparison.state -cne 'PASS' -or -not $comparison.invariant.trust_store_unchanged) {
                throw 'O trust store mudou durante o lifecycle.'
            }
        }
        default { throw "Operação M77 desconhecida: $Name" }
    }
}

$evidence = New-M77EvidenceDirectory -Path $EvidenceDirectory
$reportPath = Join-Path $evidence.FullName 'lifecycle-report.json'
$beforePath = Join-Path $evidence.FullName 'trust-before.json'
$afterPath = Join-Path $evidence.FullName 'trust-after.json'
$comparisonPath = Join-Path $evidence.FullName 'trust-comparison.json'
$lockPath = Join-Path $evidence.FullName 'execution.lock'
$lock = [IO.File]::Open($lockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
$phases = [System.Collections.Generic.List[object]]::new()
$artifacts = @{}
$currentPhase = 'initialization'
$sentinel = ([Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N'))

function Invoke-M77Phase {
    param([Parameter(Mandatory)][string]$Name, [hashtable]$Context = @{}, [switch]$ExpectRollbackFailure)
    $script:currentPhase = $Name
    $started = [DateTimeOffset]::UtcNow
    try {
        if ($ExpectRollbackFailure) {
            $failedAsExpected = $false
            try { Invoke-M77Operation -Name $Name -Context $Context | Out-Null }
            catch {
                if ($_.Exception.Message -notmatch 'rollback executado e readiness da versão anterior confirmado') { throw }
                $failedAsExpected = $true
            }
            if (-not $failedAsExpected) { throw 'A atualização de falha controlada terminou com sucesso inesperado.' }
            $status = 'EXPECTED_FAILURE_ROLLBACK_CONFIRMED'
        } else {
            Invoke-M77Operation -Name $Name -Context $Context | Out-Null
            $status = 'PASS'
        }
        $phases.Add([ordered]@{
            name = $Name
            status = $status
            duration_ms = [Math]::Max(0, [int64]([DateTimeOffset]::UtcNow - $started).TotalMilliseconds)
        })
        Write-M77Report -Path $reportPath -State 'RUNNING' -Phases $phases -Artifacts $artifacts
    }
    catch {
        $phases.Add([ordered]@{
            name = $Name
            status = 'FAIL'
            duration_ms = [Math]::Max(0, [int64]([DateTimeOffset]::UtcNow - $started).TotalMilliseconds)
        })
        Write-M77Report -Path $reportPath -State 'FAILED' -Phases $phases -Artifacts $artifacts
        throw "A fase M77 '$Name' falhou. O estado foi preservado para inspeção; nenhuma limpeza automática foi tentada."
    }
}

try {
    Write-M77Report -Path $reportPath -State 'RUNNING' -Phases $phases -Artifacts $artifacts
    Invoke-M77Phase -Name 'trust-before' -Context @{ OutputPath = $beforePath }
    Invoke-M77Phase -Name 'isolation-preflight'
    Invoke-M77Phase -Name 'install-initial'
    Invoke-M77Phase -Name 'doctor-initial'
    Invoke-M77Phase -Name 'sentinel-create' -Context @{ Token = $sentinel }
    Invoke-M77Phase -Name 'update-success'
    Invoke-M77Phase -Name 'doctor-upgrade'
    Invoke-M77Phase -Name 'update-failure-rollback' -ExpectRollbackFailure
    Invoke-M77Phase -Name 'doctor-after-rollback'
    Invoke-M77Phase -Name 'uninstall-preserve'
    Invoke-M77Phase -Name 'reinstall-preserve'
    Invoke-M77Phase -Name 'doctor-reinstall'
    Invoke-M77Phase -Name 'sentinel-verify' -Context @{ Token = $sentinel }
    Invoke-M77Phase -Name 'uninstall-final-preserve'
    Invoke-M77Phase -Name 'trust-after' -Context @{ OutputPath = $afterPath }
    Invoke-M77Phase -Name 'trust-compare' -Context @{
        BeforePath = $beforePath
        AfterPath = $afterPath
        ReportPath = $comparisonPath
    }
    $currentPhase = 'evidence-finalize'
    $finalizeStarted = [DateTimeOffset]::UtcNow
    try {
        foreach ($item in @(
            @{ Key = 'trust_before'; Path = $beforePath; Name = 'trust-before.json' },
            @{ Key = 'trust_after'; Path = $afterPath; Name = 'trust-after.json' },
            @{ Key = 'trust_comparison'; Path = $comparisonPath; Name = 'trust-comparison.json' }
        )) {
            if (-not (Test-Path -LiteralPath $item.Path -PathType Leaf)) { throw "Evidência ausente: $($item.Name)" }
            $artifacts[$item.Key] = [ordered]@{
                file = $item.Name
                sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $item.Path).Hash
            }
        }
        $phases.Add([ordered]@{
            name = 'evidence-finalize'
            status = 'PASS'
            duration_ms = [Math]::Max(0, [int64]([DateTimeOffset]::UtcNow - $finalizeStarted).TotalMilliseconds)
        })
    }
    catch {
        $phases.Add([ordered]@{
            name = 'evidence-finalize'
            status = 'FAIL'
            duration_ms = [Math]::Max(0, [int64]([DateTimeOffset]::UtcNow - $finalizeStarted).TotalMilliseconds)
        })
        Write-M77Report -Path $reportPath -State 'FAILED' -Phases $phases -Artifacts $artifacts
        throw "A fase M77 'evidence-finalize' falhou. A evidência parcial foi preservada."
    }
    Write-M77Report -Path $reportPath -State 'PASS' -Phases $phases -Artifacts $artifacts
    [pscustomobject]@{
        state = 'PASS'
        phases = $phases.Count
        final_state = 'UNINSTALLED_DATA_PRESERVED'
        report = $reportPath
    }
}
finally {
    $sentinel = $null
    $lock.Dispose()
}

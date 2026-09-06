[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ReportPath,
    [Parameter(Mandatory)][string]$EvidenceDirectory,
    [Parameter(Mandatory)][string]$ExpectedInitialCommit,
    [Parameter(Mandatory)][string]$ExpectedUpgradeCommit,
    [Parameter(Mandatory)][string]$ExpectedFailureCommit
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-Dz23ExactProperties {
    param(
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][string[]]$Expected,
        [Parameter(Mandatory)][string]$Label
    )
    if ($Value -isnot [pscustomobject]) { throw "$Label precisa ser um objeto JSON." }
    $actual = @($Value.PSObject.Properties.Name | Sort-Object)
    $wanted = @($Expected | Sort-Object)
    if (($actual -join "`n") -cne ($wanted -join "`n")) {
        throw "$Label contém campos ausentes ou desconhecidos."
    }
}

function Assert-Dz23NoDuplicateJsonProperties {
    param([Parameter(Mandatory)][string]$Text, [Parameter(Mandatory)][string]$Label)
    $document = [Text.Json.JsonDocument]::Parse($Text)
    try {
        function Visit-Dz23JsonElement {
            param([Parameter(Mandatory)][Text.Json.JsonElement]$Element, [Parameter(Mandatory)][string]$Path)
            if ($Element.ValueKind -eq [Text.Json.JsonValueKind]::Object) {
                $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
                foreach ($property in $Element.EnumerateObject()) {
                    if (-not $names.Add($property.Name)) { throw "$Label contém propriedade JSON duplicada em $Path." }
                    Visit-Dz23JsonElement -Element $property.Value -Path "$Path.$($property.Name)"
                }
            } elseif ($Element.ValueKind -eq [Text.Json.JsonValueKind]::Array) {
                $index = 0
                foreach ($item in $Element.EnumerateArray()) {
                    Visit-Dz23JsonElement -Element $item -Path "$Path[$index]"
                    $index++
                }
            }
        }
        Visit-Dz23JsonElement -Element $document.RootElement -Path '$'
    } finally {
        $document.Dispose()
    }
}

function Read-Dz23JsonBytes {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Label)
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "$Label precisa ser um arquivo físico regular."
    }
    $bytes = [IO.File]::ReadAllBytes($item.FullName)
    $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
    Assert-Dz23NoDuplicateJsonProperties -Text $text -Label $Label
    try { $json = $text | ConvertFrom-Json -Depth 20 -DateKind String }
    catch { throw "$Label não contém JSON válido." }
    [pscustomobject]@{
        Item = $item
        Bytes = $bytes
        Json = $json
        Sha256 = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes))
    }
}

function Assert-Dz23CommitValue {
    param([Parameter(Mandatory)][string]$Actual, [Parameter(Mandatory)][string]$Expected, [Parameter(Mandatory)][string]$Label)
    if ($Expected -cnotmatch '^[0-9a-f]{40}$') { throw "O commit esperado de $Label precisa ser SHA-1 completo em minúsculas." }
    if ($Actual -cnotmatch '^[0-9a-f]{40}$' -or $Actual -cne $Expected) { throw "O commit de $Label não corresponde ao pin esperado." }
}

function Assert-Dz23Timestamp {
    param([Parameter(Mandatory)][string]$Value, [Parameter(Mandatory)][string]$Label)
    $parsed = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParseExact($Value, 'O', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$parsed)) {
        throw "$Label precisa ser um timestamp UTC/offset no formato round-trip."
    }
}

function Assert-Dz23RealPathChain {
    param([Parameter(Mandatory)][IO.DirectoryInfo]$Directory)
    $cursor = $Directory
    while ($null -ne $cursor) {
        if ($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw 'EvidenceDirectory e seus pais não podem atravessar links ou reparse points.'
        }
        $cursor = $cursor.Parent
    }
}

function Assert-Dz23Snapshot {
    param([Parameter(Mandatory)]$Snapshot, [Parameter(Mandatory)][string]$Label)
    Assert-Dz23ExactProperties $Snapshot @('schema_version', 'captured_at_utc', 'host', 'windows', 'wsl', 'safety') $Label
    if ($Snapshot.schema_version -ne 1) { throw "$Label usa versão de schema não suportada." }
    Assert-Dz23Timestamp ([string]$Snapshot.captured_at_utc) "$Label.captured_at_utc"
    Assert-Dz23ExactProperties $Snapshot.host @('platform', 'os_version', 'powershell_version') "$Label.host"
    if ($Snapshot.host.platform -cne 'windows' -or [string]::IsNullOrWhiteSpace($Snapshot.host.os_version) -or [string]::IsNullOrWhiteSpace($Snapshot.host.powershell_version)) {
        throw "$Label não identifica uma coleta Windows válida."
    }
    Assert-Dz23ExactProperties $Snapshot.safety @('read_only', 'trust_store_modified', 'network_contacted', 'elevated') "$Label.safety"
    if ($Snapshot.safety.read_only -ne $true -or $Snapshot.safety.trust_store_modified -ne $false -or $Snapshot.safety.network_contacted -ne $false -or $Snapshot.safety.elevated -isnot [bool]) {
        throw "$Label não comprova coleta local somente leitura."
    }
    Assert-Dz23ExactProperties $Snapshot.windows @('stores', 'certificates') "$Label.windows"
    $expectedStores = @('CurrentUser/CA', 'CurrentUser/Root', 'LocalMachine/CA', 'LocalMachine/Root')
    if ((@($Snapshot.windows.stores | Sort-Object) -join "`n") -cne ($expectedStores -join "`n")) { throw "$Label não cobre os quatro stores Windows exigidos." }
    $certificateKeys = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($certificate in @($Snapshot.windows.certificates)) {
        Assert-Dz23ExactProperties $certificate @('location', 'store', 'thumbprint_sha1', 'certificate_sha256') "$Label.windows.certificates[]"
        if ($certificate.location -cnotin @('CurrentUser', 'LocalMachine') -or $certificate.store -cnotin @('Root', 'CA') -or
            $certificate.thumbprint_sha1 -cnotmatch '^[0-9a-f]{40}$' -or $certificate.certificate_sha256 -cnotmatch '^[0-9a-f]{64}$') {
            throw "$Label contém certificado com metadados inválidos."
        }
        $key = "$($certificate.location)|$($certificate.store)|$($certificate.thumbprint_sha1)|$($certificate.certificate_sha256)"
        if (-not $certificateKeys.Add($key)) { throw "$Label contém certificado duplicado." }
    }
    Assert-Dz23ExactProperties $Snapshot.wsl @('distro', 'roots', 'entries') "$Label.wsl"
    if ($Snapshot.wsl.distro -cnotmatch '^[A-Za-z0-9._-]{1,64}$') { throw "$Label contém distribuição WSL inválida." }
    $expectedRoots = @('/etc/ssl/certs', '/usr/local/share/ca-certificates', '/usr/share/ca-certificates')
    $rootPaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($root in @($Snapshot.wsl.roots)) {
        Assert-Dz23ExactProperties $root @('path', 'kind') "$Label.wsl.roots[]"
        if ($root.path -cnotin $expectedRoots -or $root.kind -cnotin @('absent', 'directory', 'other') -or -not $rootPaths.Add([string]$root.path)) {
            throw "$Label contém raiz WSL inválida ou duplicada."
        }
    }
    if ($rootPaths.Count -ne 3) { throw "$Label não cobre as três raízes WSL exigidas." }
    $entryKeys = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($entry in @($Snapshot.wsl.entries)) {
        Assert-Dz23ExactProperties $entry @('path', 'kind', 'sha256', 'size', 'target') "$Label.wsl.entries[]"
        if (-not ($expectedRoots | Where-Object { $entry.path -ceq $_ -or $entry.path.StartsWith("$_/", [StringComparison]::Ordinal) })) {
            throw "$Label contém entrada fora das raízes de certificados WSL."
        }
        if ($entry.kind -ceq 'file') {
            if ($entry.sha256 -cnotmatch '^[0-9a-f]{64}$' -or $entry.size -isnot [long] -or $entry.size -lt 0 -or $null -ne $entry.target) { throw "$Label contém arquivo WSL inválido." }
        } elseif ($entry.kind -ceq 'symlink') {
            if ($null -ne $entry.sha256 -or $null -ne $entry.size -or $entry.target -isnot [string]) { throw "$Label contém link WSL inválido." }
        } else { throw "$Label contém tipo de entrada WSL desconhecido." }
        $key = "$($entry.path)|$($entry.kind)|$($entry.sha256)|$($entry.size)|$($entry.target)"
        if (-not $entryKeys.Add($key)) { throw "$Label contém entrada WSL duplicada." }
    }
}

function ConvertTo-Dz23SnapshotInventory {
    param([Parameter(Mandatory)]$Snapshot)
    [ordered]@{
        stores = @($Snapshot.windows.stores | Sort-Object)
        certificates = @($Snapshot.windows.certificates | ForEach-Object {
            "$($_.location)|$($_.store)|$($_.thumbprint_sha1)|$($_.certificate_sha256)"
        } | Sort-Object)
        roots = @($Snapshot.wsl.roots | ForEach-Object { "$($_.path)|$($_.kind)" } | Sort-Object)
        entries = @($Snapshot.wsl.entries | ForEach-Object {
            "$($_.path)|$($_.kind)|$($_.sha256)|$($_.size)|$($_.target)"
        } | Sort-Object)
    } | ConvertTo-Json -Depth 5 -Compress
}

$evidenceInput = [IO.Path]::GetFullPath($EvidenceDirectory)
$evidence = Get-Item -LiteralPath $evidenceInput -Force -ErrorAction Stop
if (-not $evidence.PSIsContainer) { throw 'EvidenceDirectory precisa ser uma pasta existente.' }
Assert-Dz23RealPathChain $evidence

$expectedReportPath = Join-Path $evidence.FullName 'lifecycle-report.json'
$reportInput = [IO.Path]::GetFullPath($ReportPath)
if ($reportInput -cne $expectedReportPath) { throw 'ReportPath precisa ser lifecycle-report.json diretamente dentro de EvidenceDirectory.' }
$reportFile = Read-Dz23JsonBytes -Path $reportInput -Label 'lifecycle-report.json'
$report = $reportFile.Json
Assert-Dz23ExactProperties $report @(
    'schema_version', 'state', 'initial_commit', 'upgrade_commit', 'failure_commit',
    'execution_mode', 'final_state', 'source_and_images', 'docker_desktop_started_by_runner',
    'docker_containers', 'phases', 'artifacts', 'updated_at'
) 'lifecycle-report.json'
if ($report.state -ceq 'SIMULATED_PASS' -or $report.execution_mode -ceq 'SIMULATED') {
    throw 'SIMULATED_PASS nunca é evidência de release; execute o lifecycle M77 real.'
}
if ($report.schema_version -ne 1 -or $report.state -cne 'PASS' -or $report.execution_mode -cne 'REAL' -or
    $report.final_state -cne 'UNINSTALLED_DATA_PRESERVED' -or $report.source_and_images -cne 'VERIFIED_BY_LIFECYCLE_SCRIPTS' -or
    $report.docker_desktop_started_by_runner -ne $false -or $report.docker_containers -cne 'STARTED_AND_STOPPED_DURING_PROOF') {
    throw 'O relatório não representa uma execução real M77 concluída com sucesso.'
}
Assert-Dz23CommitValue ([string]$report.initial_commit) $ExpectedInitialCommit 'instalação inicial'
Assert-Dz23CommitValue ([string]$report.upgrade_commit) $ExpectedUpgradeCommit 'atualização'
Assert-Dz23CommitValue ([string]$report.failure_commit) $ExpectedFailureCommit 'falha controlada'
if ((@($ExpectedInitialCommit, $ExpectedUpgradeCommit, $ExpectedFailureCommit) | Select-Object -Unique).Count -ne 3) { throw 'Os três commits esperados precisam ser distintos.' }
Assert-Dz23Timestamp ([string]$report.updated_at) 'lifecycle-report.json.updated_at'

$expectedPhases = @(
    'trust-before', 'isolation-preflight', 'install-initial', 'doctor-initial', 'sentinel-create',
    'update-success', 'doctor-upgrade', 'update-failure-rollback', 'doctor-after-rollback',
    'uninstall-preserve', 'reinstall-preserve', 'doctor-reinstall', 'sentinel-verify',
    'uninstall-final-preserve', 'trust-after', 'trust-compare', 'evidence-finalize'
)
$phases = @($report.phases)
if ($phases.Count -ne $expectedPhases.Count) { throw 'O relatório precisa conter exatamente as 17 fases do lifecycle M77.' }
for ($index = 0; $index -lt $expectedPhases.Count; $index++) {
    $phase = $phases[$index]
    Assert-Dz23ExactProperties $phase @('name', 'status', 'duration_ms') "phases[$index]"
    if ($phase.name -cne $expectedPhases[$index]) { throw "A fase $index está fora de ordem ou duplicada." }
    $expectedStatus = if ($phase.name -ceq 'update-failure-rollback') { 'EXPECTED_FAILURE_ROLLBACK_CONFIRMED' } else { 'PASS' }
    if ($phase.status -cne $expectedStatus) { throw "A fase '$($phase.name)' não possui o estado obrigatório." }
    if ($phase.duration_ms -isnot [long] -or $phase.duration_ms -lt 0) { throw "A fase '$($phase.name)' contém duração inválida." }
}

Assert-Dz23ExactProperties $report.artifacts @('trust_before', 'trust_after', 'trust_comparison') 'artifacts'
$artifactFiles = @{}
foreach ($artifactKey in @('trust_before', 'trust_after', 'trust_comparison')) {
    $entry = $report.artifacts.$artifactKey
    Assert-Dz23ExactProperties $entry @('file', 'sha256') "artifacts.$artifactKey"
    $name = [string]$entry.file
    if ($name -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]{2,100}$' -or [IO.Path]::GetFileName($name) -cne $name -or $name.Contains('/') -or $name.Contains('\')) {
        throw "artifacts.$artifactKey contém nome de arquivo inseguro."
    }
    if ($entry.sha256 -cnotmatch '^[0-9A-Fa-f]{64}$') { throw "artifacts.$artifactKey contém SHA-256 inválido." }
    $path = Join-Path $evidence.FullName $name
    $artifact = Read-Dz23JsonBytes -Path $path -Label $name
    if ($artifact.Item.DirectoryName -cne $evidence.FullName -or $artifact.Sha256 -cne ([string]$entry.sha256).ToUpperInvariant()) {
        throw "artifacts.$artifactKey não corresponde ao arquivo e hash declarados."
    }
    $artifactFiles[$artifactKey] = $artifact
}
if ((@($artifactFiles.Values | ForEach-Object Item | ForEach-Object FullName | Select-Object -Unique)).Count -ne 3) {
    throw 'Cada evidência de trust store precisa apontar para um arquivo físico distinto.'
}

$before = $artifactFiles.trust_before.Json
$after = $artifactFiles.trust_after.Json
$comparison = $artifactFiles.trust_comparison.Json
Assert-Dz23Snapshot $before 'trust-before.json'
Assert-Dz23Snapshot $after 'trust-after.json'
if ($before.host.platform -cne $after.host.platform -or $before.host.os_version -cne $after.host.os_version -or
    $before.host.powershell_version -cne $after.host.powershell_version -or $before.wsl.distro -cne $after.wsl.distro -or
    $before.safety.elevated -ne $after.safety.elevated) {
    throw 'Os snapshots antes/depois não pertencem ao mesmo ambiente e nível de elevação.'
}
if ((ConvertTo-Dz23SnapshotInventory $before) -cne (ConvertTo-Dz23SnapshotInventory $after)) {
    throw 'A comparação independente detectou alteração no trust store.'
}

Assert-Dz23ExactProperties $comparison @('schema_version', 'compared_at_utc', 'state', 'before_path', 'after_path', 'distro', 'changes', 'invariant') 'trust-comparison.json'
if ($comparison.schema_version -ne 1 -or $comparison.state -cne 'PASS' -or $comparison.distro -cne $before.wsl.distro -or @($comparison.changes).Count -ne 0) {
    throw 'O relatório de comparação não confirma trust store inalterado.'
}
Assert-Dz23Timestamp ([string]$comparison.compared_at_utc) 'trust-comparison.json.compared_at_utc'
Assert-Dz23ExactProperties $comparison.invariant @('trust_store_unchanged', 'comparison_read_only') 'trust-comparison.json.invariant'
if ($comparison.invariant.trust_store_unchanged -ne $true -or $comparison.invariant.comparison_read_only -ne $true) {
    throw 'O relatório de comparação não declara invariantes somente leitura.'
}
if ([IO.Path]::GetFullPath([string]$comparison.before_path) -cne $artifactFiles.trust_before.Item.FullName -or
    [IO.Path]::GetFullPath([string]$comparison.after_path) -cne $artifactFiles.trust_after.Item.FullName) {
    throw 'O relatório de comparação referencia snapshots diferentes dos artefatos verificados.'
}

Write-Output 'DZ23_M78_RELEASE_EVIDENCE=PASS'

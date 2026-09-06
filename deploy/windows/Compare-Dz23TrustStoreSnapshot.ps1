[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$BeforePath,
    [Parameter(Mandatory)][string]$AfterPath,
    [string]$ReportPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Read-Dz23Snapshot {
    param([Parameter(Mandatory)][string]$Path)
    $resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
    $snapshot = Get-Content -LiteralPath $resolved -Raw | ConvertFrom-Json -Depth 12
    if ($snapshot.schema_version -ne 1) { throw 'Versão de snapshot de certificados não suportada.' }
    if ($snapshot.host.platform -ne 'windows') { throw 'O snapshot não foi produzido pelo coletor Windows esperado.' }
    if ($snapshot.safety.read_only -ne $true -or $snapshot.safety.trust_store_modified -ne $false) {
        throw 'O snapshot não declara uma coleta somente leitura.'
    }
    if ($snapshot.wsl.distro -notmatch '^[A-Za-z0-9._-]{1,64}$') { throw 'Distribuição WSL inválida no snapshot.' }
    $snapshot
}

function ConvertTo-CanonicalInventory {
    param([Parameter(Mandatory)]$Snapshot)
    [pscustomobject][ordered]@{
        windows = [pscustomobject][ordered]@{
            stores = @($Snapshot.windows.stores | Sort-Object)
            certificates = @($Snapshot.windows.certificates | Sort-Object location, store, thumbprint_sha1, certificate_sha256)
        }
        wsl = [pscustomobject][ordered]@{
            distro = $Snapshot.wsl.distro
            roots = @($Snapshot.wsl.roots | Sort-Object path)
            entries = @($Snapshot.wsl.entries | Sort-Object path, kind, sha256, target)
        }
    }
}

function Get-InventoryKeys {
    param([Parameter(Mandatory)]$Snapshot)
    $windows = @($Snapshot.windows.certificates | ForEach-Object {
        "windows|$($_.location)|$($_.store)|$($_.thumbprint_sha1)|$($_.certificate_sha256)"
    })
    $roots = @($Snapshot.wsl.roots | ForEach-Object { "wsl-root|$($_.path)|$($_.kind)" })
    $entries = @($Snapshot.wsl.entries | ForEach-Object {
        "wsl-entry|$($_.path)|$($_.kind)|$($_.sha256)|$($_.size)|$($_.target)"
    })
    @($windows + $roots + $entries | Sort-Object)
}

$before = Read-Dz23Snapshot -Path $BeforePath
$after = Read-Dz23Snapshot -Path $AfterPath
if ($before.wsl.distro -cne $after.wsl.distro) {
    throw 'Os snapshots pertencem a distribuições WSL diferentes.'
}

$beforeCanonical = ConvertTo-CanonicalInventory $before
$afterCanonical = ConvertTo-CanonicalInventory $after
$beforeKeys = @(Get-InventoryKeys $beforeCanonical)
$afterKeys = @(Get-InventoryKeys $afterCanonical)
$changes = @(Compare-Object -ReferenceObject $beforeKeys -DifferenceObject $afterKeys -CaseSensitive | ForEach-Object {
    [pscustomobject][ordered]@{
        change = if ($_.SideIndicator -eq '=>') { 'added_or_changed' } else { 'removed_or_changed' }
        entry = $_.InputObject
    }
})

$report = [pscustomobject][ordered]@{
    schema_version = 1
    compared_at_utc = [DateTimeOffset]::UtcNow.ToString('o')
    state = if ($changes.Count -eq 0) { 'PASS' } else { 'CHANGED' }
    before_path = [IO.Path]::GetFullPath($BeforePath)
    after_path = [IO.Path]::GetFullPath($AfterPath)
    distro = $before.wsl.distro
    changes = $changes
    invariant = [pscustomobject][ordered]@{
        trust_store_unchanged = ($changes.Count -eq 0)
        comparison_read_only = $true
    }
}

if (-not [string]::IsNullOrWhiteSpace($ReportPath)) {
    $fullReportPath = [IO.Path]::GetFullPath($ReportPath)
    if (Test-Path -LiteralPath $fullReportPath) {
        throw 'O relatório já existe; a comparação não sobrescreve evidência anterior.'
    }
    [IO.Directory]::CreateDirectory((Split-Path -Parent $fullReportPath)) | Out-Null
    [IO.File]::WriteAllText($fullReportPath, ($report | ConvertTo-Json -Depth 8) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
}

Write-Output ($report | ConvertTo-Json -Depth 8 -Compress)
if ($changes.Count -ne 0) { exit 3 }

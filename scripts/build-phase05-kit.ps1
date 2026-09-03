[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$OmniSeekRoot,

  [Parameter(Mandatory = $true)]
  [string]$DestinationDirectory,

  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$expectedOmniSeekCommit = 'd9a8109528839a9f6c691cab9d71f3fce7e91e02'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$sourceRoot = (Resolve-Path -LiteralPath $OmniSeekRoot).Path

$observedCommit = (& git -C $sourceRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $observedCommit -ne $expectedOmniSeekCommit) {
  throw "Checkout P40 incorreto. Esperado $expectedOmniSeekCommit; encontrado $observedCommit."
}

$dirty = (& git -C $sourceRoot status --porcelain) -join "`n"
if ($LASTEXITCODE -ne 0 -or $dirty) {
  throw 'O checkout P40 precisa estar limpo antes de gerar o kit.'
}

$requiredP40Files = @(
  'docs/P40_RESEARCH_MODE.md',
  'omniseek/research_mode.py',
  'tests/test_research_mode.py'
)
foreach ($relative in $requiredP40Files) {
  if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot $relative) -PathType Leaf)) {
    throw "Arquivo obrigatório do P40 ausente: $relative"
  }
}

$destination = [System.IO.Path]::GetFullPath($DestinationDirectory)
New-Item -ItemType Directory -Path $destination -Force | Out-Null
$zipPath = Join-Path $destination 'DZ23-STUDIO-Fase-0.5-Kit.zip'
$shaPath = "$zipPath.sha256"
if (((Test-Path -LiteralPath $zipPath) -or (Test-Path -LiteralPath $shaPath)) -and -not $Force) {
  throw "O artefato ou seu hash já existem em $destination. Use -Force para substituí-los."
}

$staging = Join-Path ([System.IO.Path]::GetTempPath()) ("dz23-phase05-kit-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $staging | Out-Null

try {
  $forms = Join-Path $staging 'formularios'
  $launchers = Join-Path $staging 'iniciar'
  New-Item -ItemType Directory -Path $forms | Out-Null
  New-Item -ItemType Directory -Path $launchers | Out-Null

  Copy-Item -LiteralPath (Join-Path $repoRoot 'docs/research/phase-0.5/README.md') -Destination (Join-Path $staging 'LEIA-ME-PRIMEIRO.md')
  Copy-Item -LiteralPath (Join-Path $repoRoot 'docs/research/phase-0.5/participant-card.md') -Destination $forms
  Copy-Item -LiteralPath (Join-Path $repoRoot 'docs/research/phase-0.5/facilitator-protocol.md') -Destination $forms
  Copy-Item -LiteralPath (Join-Path $repoRoot 'docs/research/phase-0.5/observation-form.md') -Destination $forms
  Copy-Item -LiteralPath (Join-Path $repoRoot 'docs/research/phase-0.5/gate-scorecard.md') -Destination $forms
  Copy-Item -LiteralPath (Join-Path $repoRoot 'docs/research/phase-0.5/recording-consent.md') -Destination $forms
  Copy-Item -LiteralPath (Join-Path $repoRoot 'docs/research/phase-0.5/preparation-proof.md') -Destination $forms
  Copy-Item -LiteralPath (Join-Path $repoRoot 'research/phase-0.5/launchers/Start-DZ23-Research.ps1') -Destination $launchers
  Copy-Item -LiteralPath (Join-Path $repoRoot 'research/phase-0.5/launchers/start-wsl.sh') -Destination $launchers
  Copy-Item -LiteralPath (Join-Path $repoRoot 'research/phase-0.5/launchers/README.txt') -Destination $launchers

  $studioCommit = (& git -C $repoRoot rev-parse HEAD).Trim()
  $fileEntries = Get-ChildItem -LiteralPath $staging -Recurse -File | ForEach-Object {
    [ordered]@{
      path = [System.IO.Path]::GetRelativePath($staging, $_.FullName).Replace('\', '/')
      sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
      bytes = $_.Length
    }
  }

  $manifest = [ordered]@{
    schemaVersion = 1
    product = 'DZ23 STUDIO'
    phase = '0.5'
    status = 'PREPARED_NOT_EXECUTED'
    studioCommit = $studioCommit
    omniseekExpectedCommit = $expectedOmniSeekCommit
    omniseekObservedCommit = $observedCommit
    omniseekBundled = $false
    sourcePolicy = 'P40 remains a separate supervised UX prototype under P39 quarantine.'
    files = @($fileEntries)
  }
  $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $staging 'SOURCE-MANIFEST.json') -Encoding utf8NoBOM

  if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
  }
  if (Test-Path -LiteralPath $shaPath) {
    Remove-Item -LiteralPath $shaPath -Force
  }
  Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zipPath -CompressionLevel Optimal

  $zipHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
  "$zipHash *$([System.IO.Path]::GetFileName($zipPath))" |
    Set-Content -LiteralPath $shaPath -Encoding ascii

  $result = [ordered]@{
    status = 'PASS'
    artifact = $zipPath
    sha256 = $zipHash
    sha256File = $shaPath
    omniseekBundled = $false
    omniseekCommit = $observedCommit
  }
  $result | ConvertTo-Json
}
finally {
  $resolvedStaging = [System.IO.Path]::GetFullPath($staging)
  $tempPrefix = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
  if ($resolvedStaging.StartsWith($tempPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and
      [System.IO.Path]::GetFileName($resolvedStaging).StartsWith('dz23-phase05-kit-', [System.StringComparison]::Ordinal)) {
    Remove-Item -LiteralPath $resolvedStaging -Recurse -Force
  }
  else {
    Write-Warning "Diretório temporário não removido por segurança: $resolvedStaging"
  }
}

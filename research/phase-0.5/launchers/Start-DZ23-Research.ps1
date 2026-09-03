[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$OmniSeekRoot,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^P0[1-5](-R[1-9])?$')]
  [string]$ParticipantId,

  [ValidateRange(1024, 65535)]
  [int]$Port = 18080,

  [string]$Distribution = 'Ubuntu',

  [string]$WslPython = '',

  [switch]$Resume,

  [switch]$PreflightOnly
)

$ErrorActionPreference = 'Stop'

$source = (Resolve-Path -LiteralPath $OmniSeekRoot).Path
$launcher = Join-Path $PSScriptRoot 'start-wsl.sh'
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
  throw "Lançador WSL2 ausente: $launcher"
}

$sourceForWsl = $source.Replace('\', '/')
$wslSource = (& wsl.exe -d $Distribution -- wslpath -a -u $sourceForWsl)
$wslSource = if ($null -eq $wslSource) { '' } else { $wslSource.Trim() }
if ($LASTEXITCODE -ne 0 -or -not $wslSource) {
  throw 'Não foi possível converter o caminho do checkout para o WSL2.'
}

$launcherForWsl = $launcher.Replace('\', '/')
$wslLauncher = (& wsl.exe -d $Distribution -- wslpath -a -u $launcherForWsl)
$wslLauncher = if ($null -eq $wslLauncher) { '' } else { $wslLauncher.Trim() }
if ($LASTEXITCODE -ne 0 -or -not $wslLauncher) {
  throw 'Não foi possível converter o caminho do lançador para o WSL2.'
}

$resumeMode = if ($PreflightOnly) { 'preflight' } elseif ($Resume) { 'resume' } else { 'fresh' }
& wsl.exe -d $Distribution -- bash $wslLauncher $wslSource $ParticipantId $Port $resumeMode $WslPython
exit $LASTEXITCODE

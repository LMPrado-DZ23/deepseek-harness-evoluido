[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [string]$Distro = 'Ubuntu',
    [string]$InstallRoot = '',
    [string]$SecretsFile,
    [switch]$PurgeData,
    [string]$PurgeConfirmation,
    [scriptblock]$CommandInvoker
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'Dz23.Windows.psm1') -Force

$InstallRoot = Resolve-Dz23InstallRoot -Distro $Distro -InstallRoot $InstallRoot -CommandInvoker $CommandInvoker
if ($SecretsFile) { Assert-Dz23LinuxPath $SecretsFile 'arquivo de segredos' }
if ($PurgeData -and $PurgeConfirmation -cne 'APAGAR DADOS DO DZ23 STUDIO') {
    throw 'Para apagar dados, informe -PurgeConfirmation exatamente como documentado. Sem isso, nada é apagado.'
}
if ($CommandInvoker -and ($env:DZ23_M6_TEST_MODE -ne '1' -or -not $WhatIfPreference)) {
    throw 'O executor simulado só pode ser usado pelos testes, com DZ23_M6_TEST_MODE=1 e -WhatIf.'
}
Test-Dz23Prerequisites -Distro $Distro -CommandInvoker $CommandInvoker

$uninstallScript = @'
set -euo pipefail
root="$1"; secrets="${2:-}"; purge="${3:-false}"
case "$root" in /mnt/*|'/'|'/home'|'') echo 'Destino inseguro' >&2; exit 20;; esac
test -d "$root"; test ! -L "$root"
root_real="$(readlink -f "$root")"
case "$root_real" in /home/*/*|/root/*) ;; *) exit 22;; esac
test "$(stat -f -c %T "$root_real")" != '9p'
if [ -L "$root/current" ]; then
  current="$(readlink -f "$root/current")"
  case "$current" in "$root_real"/releases/*) ;; *) echo 'Link atual fora da instalação' >&2; exit 21;; esac
  if [ -f "$current/docker-compose.yml" ]; then
    test -n "$secrets"; test -f "$secrets"; test ! -L "$secrets"
    secrets_real="$(readlink -f "$secrets")"
    case "$secrets_real" in /home/*/*|/root/*) ;; *) exit 23;; esac
    test "$(stat -f -c %T "$secrets_real")" != '9p'
    cd "$current"
    if [ "$purge" = true ]; then
      docker compose --project-name dz23-studio --env-file release.env --env-file "$secrets" -f docker-compose.yml down --remove-orphans --volumes
    else
      docker compose --project-name dz23-studio --env-file release.env --env-file "$secrets" -f docker-compose.yml down --remove-orphans
    fi
  fi
fi
rm -f -- "$root/current"
if [ "$purge" = true ]; then
  test "$root" != '/'; test "$root" != '/home'
  rm -rf -- "$root/releases" "$root/state"
fi
'@

$action = if ($PurgeData) { 'Parar o serviço e apagar releases e dados locais' } else { 'Parar o serviço e preservar dados e releases' }
if ($PSCmdlet.ShouldProcess("$Distro`:$InstallRoot", $action)) {
    Invoke-Dz23WslScript -Distro $Distro -Script $uninstallScript `
        -Arguments @($InstallRoot, $SecretsFile, $PurgeData.IsPresent.ToString().ToLowerInvariant()) `
        -CommandInvoker $CommandInvoker -FailureMessage 'A desinstalação não pôde ser concluída com segurança' | Out-Null
    if ($PurgeData) { Write-Host 'DZ23 STUDIO removido junto com os dados locais solicitados.' }
    else { Write-Host 'Serviço removido. Seus dados e releases foram preservados.' }
} else { Write-Host 'Plano de desinstalação validado. Nenhuma alteração foi feita.' }

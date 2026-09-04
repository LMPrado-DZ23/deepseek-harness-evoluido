[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ExpectedCommit,
    [Parameter(Mandatory)][string]$Image,
    [string]$Distro = 'Ubuntu',
    [string]$InstallRoot = '',
    [string]$SecretsFile,
    [scriptblock]$CommandInvoker
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'Dz23.Windows.psm1') -Force

Assert-Dz23Commit $ExpectedCommit
Assert-Dz23ImageDigest $Image
$InstallRoot = Resolve-Dz23InstallRoot -Distro $Distro -InstallRoot $InstallRoot -CommandInvoker $CommandInvoker
if ($SecretsFile) { Assert-Dz23LinuxPath $SecretsFile 'arquivo de segredos' }
if ($CommandInvoker -and $env:DZ23_M6_TEST_MODE -ne '1') { throw 'O executor simulado é exclusivo dos testes.' }
Test-Dz23Prerequisites -Distro $Distro -CommandInvoker $CommandInvoker
Test-Dz23Image -Image $Image -Distro $Distro -CommandInvoker $CommandInvoker

$doctorScript = @'
set -euo pipefail
root="$1"; expected="$2"; image="$3"; secrets="${4:-}"
case "$root" in /mnt/*|'') exit 20;; esac
test -d "$root"; test ! -L "$root"
root_real="$(readlink -f "$root")"
case "$root_real" in /home/*/*|/root/*) ;; *) exit 22;; esac
test "$(stat -f -c %T "$root_real")" != '9p'
test -L "$root/current"; current="$(readlink -f "$root/current")"
case "$current" in "$root_real"/releases/*) ;; *) exit 23;; esac
test -d "$current/.git"
test "$(git -C "$current" rev-parse HEAD)" = "$expected"
test -z "$(git -C "$current" status --porcelain=v1 --untracked-files=no)"
grep -Fqx "DZ23_STUDIO_IMAGE=$image" "$current/release.env"
grep -Fqx "DZ23_STUDIO_COMMIT=$expected" "$current/release.env"
if [ -n "$secrets" ]; then
  test -f "$secrets"; test ! -L "$secrets"
  secrets_real="$(readlink -f "$secrets")"
  case "$secrets_real" in /home/*/*|/root/*) ;; *) exit 24;; esac
  test "$(stat -f -c %T "$secrets_real")" != '9p'
  mode="$(stat -c %a "$secrets")"; test "$mode" = 600 -o "$mode" = 400
  cd "$current"
  docker compose --project-name dz23-studio --env-file release.env --env-file "$secrets" -f docker-compose.yml config --quiet
fi
'@
Invoke-Dz23WslScript -Distro $Distro -Script $doctorScript -Arguments @($InstallRoot, $ExpectedCommit, $Image, $SecretsFile) `
    -CommandInvoker $CommandInvoker -FailureMessage 'O diagnóstico encontrou uma inconsistência' | Out-Null
Write-Host 'Tudo certo: WSL2, Docker Linux, commit e digest correspondem ao artefato aprovado.'
if ($CommandInvoker) { Write-Host 'SIMULADO: este resultado não comprova uma instalação real.' }
if (-not $SecretsFile) { Write-Host 'Configuração do serviço não verificada: nenhum arquivo de segredos foi informado.' }

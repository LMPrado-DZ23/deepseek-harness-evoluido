[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ExpectedCommit,
    [Parameter(Mandatory)][string]$Image,
    [Parameter(Mandatory)][string]$CaddyImage,
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
Assert-Dz23ImageDigest $CaddyImage
$InstallRoot = Resolve-Dz23InstallRoot -Distro $Distro -InstallRoot $InstallRoot -CommandInvoker $CommandInvoker
if ($SecretsFile) { Assert-Dz23LinuxPath $SecretsFile 'arquivo de segredos' }
if ($CommandInvoker -and $env:DZ23_M6_TEST_MODE -ne '1') { throw 'O executor simulado é exclusivo dos testes.' }
Test-Dz23Prerequisites -Distro $Distro -CommandInvoker $CommandInvoker
Test-Dz23Image -Image $Image -Distro $Distro -CommandInvoker $CommandInvoker
Test-Dz23Image -Image $CaddyImage -Distro $Distro -CommandInvoker $CommandInvoker

$doctorScript = (Get-Dz23WslSafetyPrelude) + "`n" + @'
set -euo pipefail
root="$1"; expected="$2"; image="$3"; caddy_image="$4"; secrets="${5:-}"
root_real="$(secure_root "$root")"
secure_layout "$root_real"
acquire_operation_lock "$root_real"
assert_no_operation_journal "$root_real"
installation_id="$(read_installation_id "$root_real")"
current="$(resolve_current_release "$root_real")"
test "$(basename -- "$current")" = "$expected" || die 'current não corresponde ao commit esperado' 84
assert_release_repository "$root_real" "$current" "$expected"
assert_release_env "$current" "$expected"
assert_installed_commit "$root_real" "$expected"
grep -Fqx "DZ23_STUDIO_IMAGE=$image" "$current/release.env"
grep -Fqx "DZ23_CADDY_IMAGE=$caddy_image" "$current/release.env"
grep -Fqx "DZ23_INSTALLATION_ID=$installation_id" "$current/release.env"
if [ -n "$secrets" ]; then
  validate_secrets "$secrets"
  compose_for_release "$current" "$secrets" config --quiet
  assert_compose_images_pinned "$current" "$secrets"
  assert_compose_ready "$current" "$secrets"
fi
'@
Invoke-Dz23WslScript -Distro $Distro -Script $doctorScript -Arguments @($InstallRoot, $ExpectedCommit, $Image, $CaddyImage, $SecretsFile) `
    -CommandInvoker $CommandInvoker -FailureMessage 'O diagnóstico encontrou uma inconsistência' | Out-Null
Write-Host 'Tudo certo: WSL2, Docker Linux, commit e digest correspondem ao artefato aprovado.'
if ($CommandInvoker) { Write-Host 'SIMULADO: este resultado não comprova uma instalação real.' }
if (-not $SecretsFile) { Write-Host 'Configuração do serviço não verificada: nenhum arquivo de segredos foi informado.' }

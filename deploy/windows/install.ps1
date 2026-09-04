[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][string]$SourcePath,
    [Parameter(Mandatory)][string]$ExpectedCommit,
    [Parameter(Mandatory)][string]$Image,
    [Parameter(Mandatory)][string]$CaddyImage,
    [string]$Distro = 'Ubuntu',
    [string]$InstallRoot = '',
    [string]$SecretsFile,
    [switch]$Start,
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
if ($CommandInvoker -and $env:DZ23_M6_TEST_MODE -ne '1') {
    throw 'O executor simulado só pode ser usado pelos testes, com DZ23_M6_TEST_MODE=1.'
}

Test-Dz23Prerequisites -Distro $Distro -CommandInvoker $CommandInvoker
$source = Test-Dz23Source -SourcePath $SourcePath -ExpectedCommit $ExpectedCommit -CommandInvoker $CommandInvoker
$sourceWsl = ConvertTo-Dz23WslSourcePath -Distro $Distro -WindowsPath $source -CommandInvoker $CommandInvoker
Test-Dz23Image -Image $Image -Distro $Distro -CommandInvoker $CommandInvoker
Test-Dz23Image -Image $CaddyImage -Distro $Distro -CommandInvoker $CommandInvoker

$installScript = (Get-Dz23WslSafetyPrelude) + "`n" + @'
set -euo pipefail
source_path="$1"; root="$2"; commit="$3"; image="$4"; caddy_image="$5"; secrets="${6:-}"; start="${7:-false}"
umask 077
root_real="$(secure_root "$root" true)"
secure_layout "$root_real" true
acquire_operation_lock "$root_real"
source_path="$(realpath -e -- "$source_path")"
assert_upstream_source_pin "$source_path"
installation_id="$(ensure_installation_id "$root_real")"
recover_operation "$root_real" "$source_path" "$secrets" "$installation_id"

if [ -e "$root_real/current" ] || [ -L "$root_real/current" ]; then
  current="$(resolve_current_release "$root_real")"
  assert_release_env "$current" "$(basename -- "$current")"
  assert_installed_commit "$root_real" "$(basename -- "$current")"
  test "$(basename -- "$current")" = "$commit" || die 'Já existe outra versão instalada; use update.ps1' 84
elif [ -e "$root_real/state/installed-commit" ] || [ -L "$root_real/state/installed-commit" ]; then
  die 'installed-commit existe sem um current válido' 85
fi

stage="$root_real/releases/.${commit}.staging"
release="$root_real/releases/$commit"
if [ -e "$release" ] || [ -L "$release" ]; then
  assert_release_repository "$root_real" "$release" "$commit" "$source_path"
else
  if [ -e "$stage" ] || [ -L "$stage" ]; then
    test -d "$stage" && test ! -L "$stage" || die 'Stage existente inseguro' 86
    mountpoint -q -- "$stage" && die 'Stage existente é ponto de montagem' 87
    test "$(realpath -e -- "$stage")" = "$stage" || die 'Stage existente escapou de releases' 88
    rm -rf -- "$stage"
  fi
  git clone --no-local --no-checkout -- "$source_path" "$stage"
  git -C "$stage" checkout --detach "$commit"
  assert_staged_repository "$stage" "$commit" "$source_path"
  mv -- "$stage" "$release"
fi
assert_release_repository "$root_real" "$release" "$commit" "$source_path"
write_release_env "$release" "$image" "$caddy_image" "$commit" "$installation_id"
if [ -n "$secrets" ]; then
  validate_secrets "$secrets"
fi
write_operation_journal "$root_real" PREPARED "$commit" none "$start"
if [ "$start" = true ]; then
  test -n "$secrets" || die 'O arquivo de segredos é obrigatório para iniciar' 89
  assert_release_repository "$root_real" "$release" "$commit" "$source_path"
  compose_for_release "$release" "$secrets" config --quiet
  assert_compose_images_pinned "$release" "$secrets"
  write_operation_journal "$root_real" STARTING "$commit" none true
  start_compose_release "$release" "$secrets"
  write_operation_journal "$root_real" RUNTIME_READY "$commit" none true
fi
switch_current "$root_real" "$release"
write_installed_commit "$root_real" "$commit"
write_operation_journal "$root_real" COMMITTED "$commit" none "$start"
clear_operation_journal "$root_real"
'@

if ($PSCmdlet.ShouldProcess("$Distro`:$InstallRoot", "Instalar o DZ23 STUDIO no commit $ExpectedCommit")) {
    Invoke-Dz23WslScript -Distro $Distro -Script $installScript `
        -Arguments @($sourceWsl, $InstallRoot, $ExpectedCommit, $Image, $CaddyImage, $SecretsFile, $Start.IsPresent.ToString().ToLowerInvariant()) `
        -CommandInvoker $CommandInvoker -FailureMessage 'A instalação segura no WSL2 falhou' | Out-Null
    Write-Host 'Instalação concluída e identidade do artefato confirmada.'
    if (-not $Start) { Write-Host 'O serviço não foi iniciado. Configure o arquivo de segredos e execute novamente com -Start.' }
} else {
    Write-Host 'Plano validado. Nenhuma alteração foi feita.'
}

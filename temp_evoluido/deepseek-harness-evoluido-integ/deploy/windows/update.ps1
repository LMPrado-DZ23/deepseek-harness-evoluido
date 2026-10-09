[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][string]$SourcePath,
    [Parameter(Mandatory)][string]$ExpectedCommit,
    [Parameter(Mandatory)][string]$Image,
    [Parameter(Mandatory)][string]$CaddyImage,
    [Parameter(Mandatory)][string]$SecretsFile,
    [string]$Distro = 'Ubuntu',
    [string]$InstallRoot = '',
    [scriptblock]$CommandInvoker
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'Dz23.Windows.psm1') -Force

Assert-Dz23Commit $ExpectedCommit
Assert-Dz23ImageDigest $Image
Assert-Dz23ImageDigest $CaddyImage
$InstallRoot = Resolve-Dz23InstallRoot -Distro $Distro -InstallRoot $InstallRoot -CommandInvoker $CommandInvoker
Assert-Dz23LinuxPath $SecretsFile 'arquivo de segredos'
if ($CommandInvoker -and $env:DZ23_M6_TEST_MODE -ne '1') {
    throw 'O executor simulado só pode ser usado pelos testes, com DZ23_M6_TEST_MODE=1.'
}
Test-Dz23Prerequisites -Distro $Distro -CommandInvoker $CommandInvoker
$source = Test-Dz23Source -SourcePath $SourcePath -ExpectedCommit $ExpectedCommit -CommandInvoker $CommandInvoker
$sourceWsl = ConvertTo-Dz23WslSourcePath -Distro $Distro -WindowsPath $source -CommandInvoker $CommandInvoker
Test-Dz23Image -Image $Image -Distro $Distro -CommandInvoker $CommandInvoker
Test-Dz23Image -Image $CaddyImage -Distro $Distro -CommandInvoker $CommandInvoker

$updateScript = (Get-Dz23WslSafetyPrelude) + "`n" + @'
set -euo pipefail
source_path="$1"; root="$2"; commit="$3"; image="$4"; caddy_image="$5"; secrets="$6"
umask 077
root_real="$(secure_root "$root")"
secure_layout "$root_real"
acquire_operation_lock "$root_real"
source_path="$(realpath -e -- "$source_path")"
assert_upstream_source_pin "$source_path"
validate_secrets "$secrets"
installation_id="$(ensure_installation_id "$root_real")"
recover_operation "$root_real" "$source_path" "$secrets" "$installation_id"

previous="$(resolve_current_release "$root_real")"
previous_commit="$(basename -- "$previous")"
assert_release_repository "$root_real" "$previous" "$previous_commit" "$source_path"
assert_release_env "$previous" "$previous_commit"
assert_installed_commit "$root_real" "$previous_commit"
test "$previous_commit" != "$commit" || die 'O commit solicitado já está instalado' 84

stage="$root_real/releases/.${commit}.staging"
release="$root_real/releases/$commit"
if [ -e "$release" ] || [ -L "$release" ]; then
  assert_release_repository "$root_real" "$release" "$commit" "$source_path"
else
  if [ -e "$stage" ] || [ -L "$stage" ]; then
    test -d "$stage" && test ! -L "$stage" || die 'Stage existente inseguro' 85
    mountpoint -q -- "$stage" && die 'Stage existente é ponto de montagem' 86
    test "$(realpath -e -- "$stage")" = "$stage" || die 'Stage existente escapou de releases' 87
    rm -rf -- "$stage"
  fi
  git clone --no-local --no-checkout -- "$source_path" "$stage"
  git -C "$stage" checkout --detach "$commit"
  assert_staged_repository "$stage" "$commit" "$source_path"
  mv -- "$stage" "$release"
fi
assert_release_repository "$root_real" "$release" "$commit" "$source_path"
write_release_env "$release" "$image" "$caddy_image" "$commit" "$installation_id"
compose_for_release "$release" "$secrets" config --quiet
assert_compose_images_pinned "$release" "$secrets"

write_operation_journal "$root_real" PREPARED "$commit" "$previous_commit" true
write_operation_journal "$root_real" STARTING "$commit" "$previous_commit" true
if ( start_compose_release "$release" "$secrets" ); then
  write_operation_journal "$root_real" RUNTIME_READY "$commit" "$previous_commit" true
  switch_current "$root_real" "$release"
  write_installed_commit "$root_real" "$commit"
  write_operation_journal "$root_real" COMMITTED "$commit" "$previous_commit" true
  clear_operation_journal "$root_real"
  exit 0
fi

write_operation_journal "$root_real" ROLLING_BACK "$commit" "$previous_commit" true
if ( assert_release_repository "$root_real" "$previous" "$previous_commit" "$source_path" &&
     assert_release_env "$previous" "$previous_commit" &&
     compose_for_release "$previous" "$secrets" config --quiet &&
     assert_compose_images_pinned "$previous" "$secrets" &&
     start_compose_release "$previous" "$secrets" ); then
  switch_current "$root_real" "$previous"
  write_installed_commit "$root_real" "$previous_commit"
  clear_operation_journal "$root_real"
  echo 'Atualização falhou; rollback executado e readiness da versão anterior confirmado' >&2
  exit 30
fi

echo 'Atualização falhou e o rollback não comprovou readiness; intervenção manual obrigatória' >&2
exit 31
'@

if ($PSCmdlet.ShouldProcess("$Distro`:$InstallRoot", "Atualizar o DZ23 STUDIO para $ExpectedCommit com rollback automático")) {
    Invoke-Dz23WslScript -Distro $Distro -Script $updateScript `
        -Arguments @($sourceWsl, $InstallRoot, $ExpectedCommit, $Image, $CaddyImage, $SecretsFile) `
        -CommandInvoker $CommandInvoker -FailureMessage 'A atualização segura falhou' | Out-Null
    Write-Host 'Atualização concluída; commit e digest confirmados.'
} else { Write-Host 'Plano de atualização validado. Nenhuma alteração foi feita.' }

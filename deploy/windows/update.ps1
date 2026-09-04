[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][string]$SourcePath,
    [Parameter(Mandatory)][string]$ExpectedCommit,
    [Parameter(Mandatory)][string]$Image,
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
$InstallRoot = Resolve-Dz23InstallRoot -Distro $Distro -InstallRoot $InstallRoot -CommandInvoker $CommandInvoker
Assert-Dz23LinuxPath $SecretsFile 'arquivo de segredos'
if ($CommandInvoker -and ($env:DZ23_M6_TEST_MODE -ne '1' -or -not $WhatIfPreference)) {
    throw 'O executor simulado só pode ser usado pelos testes, com DZ23_M6_TEST_MODE=1 e -WhatIf.'
}
Test-Dz23Prerequisites -Distro $Distro -CommandInvoker $CommandInvoker
$source = Test-Dz23Source -SourcePath $SourcePath -ExpectedCommit $ExpectedCommit -CommandInvoker $CommandInvoker
Test-Dz23Image -Image $Image -Distro $Distro -CommandInvoker $CommandInvoker

$updateScript = @'
set -euo pipefail
source_path="$1"; root="$2"; commit="$3"; image="$4"; secrets="$5"
case "$root" in /mnt/*|'') exit 20;; esac
test -d "$root"; test ! -L "$root"
root_real="$(readlink -f "$root")"
case "$root_real" in /home/*/*|/root/*) ;; *) exit 22;; esac
test "$(stat -f -c %T "$root_real")" != '9p'
test -L "$root/current"; previous="$(readlink -f "$root/current")"
test -f "$secrets"; test ! -L "$secrets"
secrets_real="$(readlink -f "$secrets")"
case "$secrets_real" in /home/*/*|/root/*) ;; *) exit 23;; esac
test "$(stat -f -c %T "$secrets_real")" != '9p'
mode="$(stat -c %a "$secrets")"; test "$mode" = 600 -o "$mode" = 400
umask 077; stage="$root/releases/.${commit}.staging"; release="$root/releases/$commit"
if [ ! -d "$release/.git" ]; then
  rm -rf -- "$stage"
  git clone --no-local --no-checkout -- "$source_path" "$stage"
  git -C "$stage" checkout --detach "$commit"
  test "$(git -C "$stage" rev-parse HEAD)" = "$commit"
  test -z "$(git -C "$stage" status --porcelain=v1 --untracked-files=no)"
  mv -- "$stage" "$release"
fi
test "$(git -C "$release" rev-parse HEAD)" = "$commit"
test -z "$(git -C "$release" status --porcelain=v1 --untracked-files=no)"
printf 'DZ23_STUDIO_IMAGE=%s\nDZ23_STUDIO_COMMIT=%s\n' "$image" "$commit" > "$release/release.env"
chmod 600 "$release/release.env"
cd "$release"
docker compose --project-name dz23-studio --env-file release.env --env-file "$secrets" -f docker-compose.yml config --quiet
ln -sfn "$release" "$root/.current.new"; mv -Tf "$root/.current.new" "$root/current"
if ! docker compose --project-name dz23-studio --env-file release.env --env-file "$secrets" -f docker-compose.yml up -d --build; then
  ln -sfn "$previous" "$root/.current.rollback"; mv -Tf "$root/.current.rollback" "$root/current"
  cd "$previous"
  docker compose --project-name dz23-studio --env-file release.env --env-file "$secrets" -f docker-compose.yml up -d --build || true
  echo 'Atualização falhou; versão anterior restaurada' >&2; exit 30
fi
printf '%s\n' "$commit" > "$root/state/installed-commit"
chmod 600 "$root/state/installed-commit"
'@

if ($PSCmdlet.ShouldProcess("$Distro`:$InstallRoot", "Atualizar o DZ23 STUDIO para $ExpectedCommit com rollback automático")) {
    $sourceWsl = if ($CommandInvoker) { $source } else {
        (Invoke-Dz23Checked -FilePath 'wsl.exe' -ArgumentList @('-d', $Distro, '--exec', 'wslpath', '-a', $source) `
            -FailureMessage 'Não foi possível converter o caminho da origem para o WSL2').StdOut.Trim()
    }
    Invoke-Dz23WslScript -Distro $Distro -Script $updateScript `
        -Arguments @($sourceWsl, $InstallRoot, $ExpectedCommit, $Image, $SecretsFile) `
        -CommandInvoker $CommandInvoker -FailureMessage 'A atualização segura falhou' | Out-Null
    Write-Host 'Atualização concluída; commit e digest confirmados.'
} else { Write-Host 'Plano de atualização validado. Nenhuma alteração foi feita.' }

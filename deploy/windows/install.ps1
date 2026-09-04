[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][string]$SourcePath,
    [Parameter(Mandatory)][string]$ExpectedCommit,
    [Parameter(Mandatory)][string]$Image,
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
$InstallRoot = Resolve-Dz23InstallRoot -Distro $Distro -InstallRoot $InstallRoot -CommandInvoker $CommandInvoker
if ($SecretsFile) { Assert-Dz23LinuxPath $SecretsFile 'arquivo de segredos' }
if ($CommandInvoker -and ($env:DZ23_M6_TEST_MODE -ne '1' -or -not $WhatIfPreference)) {
    throw 'O executor simulado só pode ser usado pelos testes, com DZ23_M6_TEST_MODE=1 e -WhatIf.'
}

Test-Dz23Prerequisites -Distro $Distro -CommandInvoker $CommandInvoker
$source = Test-Dz23Source -SourcePath $SourcePath -ExpectedCommit $ExpectedCommit -CommandInvoker $CommandInvoker
Test-Dz23Image -Image $Image -Distro $Distro -CommandInvoker $CommandInvoker

$installScript = @'
set -euo pipefail
source_path="$1"; root="$2"; commit="$3"; image="$4"; secrets="${5:-}"; start="${6:-false}"
case "$root" in /mnt/*|'') echo 'Destino fora do ext4 do WSL2' >&2; exit 20;; esac
umask 077
if [ -e "$root" ]; then test -d "$root"; test ! -L "$root"; fi
root_real="$(realpath -m "$root")"
case "$root_real" in /home/*/*|/root/*) ;; *) echo 'Destino físico fora do ext4 permitido' >&2; exit 22;; esac
probe="$root_real"; while [ ! -e "$probe" ]; do probe="$(dirname "$probe")"; done
test "$(stat -f -c %T "$probe")" != '9p'
mkdir -p "$root/releases" "$root/state"
stage="$root/releases/.${commit}.staging"
release="$root/releases/$commit"
if [ ! -d "$release/.git" ]; then
  rm -rf -- "$stage"
  git clone --no-local --no-checkout -- "$source_path" "$stage"
  git -C "$stage" checkout --detach "$commit"
  test "$(git -C "$stage" rev-parse HEAD)" = "$commit"
  test -z "$(git -C "$stage" status --porcelain=v1 --untracked-files=no)"
  mv -- "$stage" "$release"
fi
test "$(git -C "$release" rev-parse HEAD)" = "$commit"
printf 'DZ23_STUDIO_IMAGE=%s\nDZ23_STUDIO_COMMIT=%s\n' "$image" "$commit" > "$release/release.env"
chmod 600 "$release/release.env"
if [ -n "$secrets" ]; then
  case "$secrets" in /mnt/*|'') echo 'Segredos precisam ficar no ext4 do WSL2' >&2; exit 21;; esac
  test -f "$secrets"; test ! -L "$secrets"
  secrets_real="$(readlink -f "$secrets")"
  case "$secrets_real" in /home/*/*|/root/*) ;; *) echo 'Segredos fora do ext4 permitido' >&2; exit 23;; esac
  test "$(stat -f -c %T "$secrets_real")" != '9p'
  mode="$(stat -c %a "$secrets")"; test "$mode" = 600 -o "$mode" = 400
fi
ln -sfn "$release" "$root/.current.new"
mv -Tf "$root/.current.new" "$root/current"
printf '%s\n' "$commit" > "$root/state/installed-commit"
chmod 600 "$root/state/installed-commit"
if [ "$start" = true ]; then
  test -n "$secrets"
  cd "$release"
  docker compose --project-name dz23-studio --env-file release.env --env-file "$secrets" -f docker-compose.yml config --quiet
  docker compose --project-name dz23-studio --env-file release.env --env-file "$secrets" -f docker-compose.yml up -d --build
fi
'@

if ($PSCmdlet.ShouldProcess("$Distro`:$InstallRoot", "Instalar o DZ23 STUDIO no commit $ExpectedCommit")) {
    $sourceWsl = if ($CommandInvoker) { $source } else {
        (Invoke-Dz23Checked -FilePath 'wsl.exe' -ArgumentList @('-d', $Distro, '--exec', 'wslpath', '-a', $source) `
            -FailureMessage 'Não foi possível converter o caminho da origem para o WSL2').StdOut.Trim()
    }
    Invoke-Dz23WslScript -Distro $Distro -Script $installScript `
        -Arguments @($sourceWsl, $InstallRoot, $ExpectedCommit, $Image, $SecretsFile, $Start.IsPresent.ToString().ToLowerInvariant()) `
        -CommandInvoker $CommandInvoker -FailureMessage 'A instalação segura no WSL2 falhou' | Out-Null
    Write-Host 'Instalação concluída e identidade do artefato confirmada.'
    if (-not $Start) { Write-Host 'O serviço não foi iniciado. Configure o arquivo de segredos e execute novamente com -Start.' }
} else {
    Write-Host 'Plano validado. Nenhuma alteração foi feita.'
}

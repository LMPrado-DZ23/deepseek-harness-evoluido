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
if ($CommandInvoker -and $env:DZ23_M6_TEST_MODE -ne '1') {
    throw 'O executor simulado só pode ser usado pelos testes, com DZ23_M6_TEST_MODE=1.'
}
Test-Dz23Prerequisites -Distro $Distro -CommandInvoker $CommandInvoker

$uninstallScript = (Get-Dz23WslSafetyPrelude) + "`n" + @'
set -euo pipefail
root="$1"; purge="${3:-false}"
root_real="$(secure_root "$root")"
secure_layout "$root_real"
acquire_operation_lock "$root_real"
assert_no_operation_journal "$root_real"
installation_id="$(read_installation_id "$root_real")"

uninstall_containers() {
  local by_label by_name
  by_label="$(docker ps -aq --filter 'label=com.docker.compose.project=dz23-studio')" || return $?
  by_name="$(docker ps -aq --filter 'name=^/dz23-studio-')" || return $?
  printf '%s\n%s\n' "$by_label" "$by_name" | sed '/^$/d' | sort -u
}
uninstall_volumes() {
  local by_label by_name
  by_label="$(docker volume ls -q --filter 'label=com.docker.compose.project=dz23-studio')" || return $?
  by_name="$(docker volume ls -q --filter 'name=^dz23-studio_')" || return $?
  printf '%s\n%s\n' "$by_label" "$by_name" | sed '/^$/d' | sort -u
}
uninstall_networks() {
  local by_label by_name
  by_label="$(docker network ls -q --filter 'label=com.docker.compose.project=dz23-studio')" || return $?
  by_name="$(docker network ls -q --filter 'name=^dz23-studio_')" || return $?
  printf '%s\n%s\n' "$by_label" "$by_name" | sed '/^$/d' | sort -u
}

containers="$(uninstall_containers)" || die 'Falha ao inventariar contêineres; nada foi removido' 145
volumes="$(uninstall_volumes)" || die 'Falha ao inventariar volumes; nada foi removido' 146
networks="$(uninstall_networks)" || die 'Falha ao inventariar redes; nada foi removido' 147

# Valide todos os alvos antes da primeira remoção; um homônimo torna a operação inteira ambígua.
if [ -n "$containers" ]; then
  while IFS= read -r container; do
    case "$container" in *[!0-9a-f]*|'') die 'Docker retornou identificador de contêiner inválido' 84;; esac
    test "${#container}" -ge 12 || die 'Docker retornou identificador de contêiner curto' 85
    test "$(docker inspect --format '{{index .Config.Labels "com.dz23.studio.installation-id"}}' "$container")" = "$installation_id" ||
      die 'Existe um projeto homônimo que não pertence a esta instalação; nada foi removido' 143
  done <<< "$containers"
fi
if [ -n "$volumes" ]; then
  while IFS= read -r volume; do
    case "$volume" in *[!A-Za-z0-9_.-]*|'') die 'Docker retornou nome de volume inválido' 88;; esac
    test "$(docker volume inspect --format '{{index .Labels "com.dz23.studio.installation-id"}}' "$volume")" = "$installation_id" ||
      die 'Existe um volume homônimo que não pertence a esta instalação; nada foi removido' 144
  done <<< "$volumes"
fi
if [ -n "$networks" ]; then
  while IFS= read -r network; do
    case "$network" in *[!A-Za-z0-9_.-]*|'') die 'Docker retornou nome de rede inválido' 148;; esac
    test "$(docker network inspect --format '{{index .Labels "com.dz23.studio.installation-id"}}' "$network")" = "$installation_id" ||
      die 'Existe uma rede homônima que não pertence a esta instalação; nada foi removido' 149
  done <<< "$networks"
fi

if [ -n "$containers" ]; then
  while IFS= read -r container; do
    docker stop -- "$container" >/dev/null
    docker rm -- "$container" >/dev/null
  done <<< "$containers"
fi
remaining="$(uninstall_containers)" || die 'Falha ao confirmar a parada do projeto dz23-studio' 150
test -z "$remaining" || die 'Não foi possível comprovar a parada do projeto dz23-studio' 86

if [ -n "$networks" ]; then
  while IFS= read -r network; do
    docker network rm -- "$network" >/dev/null
  done <<< "$networks"
fi
remaining_networks="$(uninstall_networks)" || die 'Falha ao confirmar a remoção das redes do projeto' 151
test -z "$remaining_networks" || die 'Não foi possível comprovar a remoção das redes do projeto' 151

if [ -e "$root_real/current" ] && [ ! -L "$root_real/current" ]; then
  die 'current danificado: recusado remover objeto que não é link simbólico' 87
fi
if [ -L "$root_real/current" ]; then rm -f -- "$root_real/current"; fi

if [ "$purge" = true ]; then
  if [ -n "$volumes" ]; then
    while IFS= read -r volume; do
      case "$volume" in *[!A-Za-z0-9_.-]*|'') die 'Docker retornou nome de volume inválido' 88;; esac
      docker volume rm -- "$volume" >/dev/null
    done <<< "$volumes"
  fi
  remaining_volumes="$(uninstall_volumes)" || die 'Falha ao confirmar a remoção dos volumes do projeto' 89
  test -z "$remaining_volumes" || die 'Não foi possível comprovar a remoção dos volumes do projeto' 89
  rm -rf -- "$root_real/releases" "$root_real/state"
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

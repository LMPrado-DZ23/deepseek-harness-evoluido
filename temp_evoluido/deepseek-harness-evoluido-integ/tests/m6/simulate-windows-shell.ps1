Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$env:DZ23_M6_TEST_MODE = '1'

$modulePath = Join-Path $PSScriptRoot '../../deploy/windows/Dz23.Windows.psm1'
$installPath = Join-Path $PSScriptRoot '../../deploy/windows/install.ps1'
$updatePath = Join-Path $PSScriptRoot '../../deploy/windows/update.ps1'
$doctorPath = Join-Path $PSScriptRoot '../../deploy/windows/doctor.ps1'
$uninstallPath = Join-Path $PSScriptRoot '../../deploy/windows/uninstall.ps1'
Import-Module $modulePath -Force

$distro = if ($env:DZ23_M6_TEST_DISTRO) { $env:DZ23_M6_TEST_DISTRO } else { 'Ubuntu' }
$digest = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
$image = "registry.example/dz23-studio@sha256:$digest"
$caddyImage = "registry.example/dz23-caddy@sha256:$digest"
$runtimeImage = "registry.example/dz23-runtime@sha256:$digest"

function Invoke-FixtureNative {
    param([Parameter(Mandatory)][string]$FilePath, [string[]]$ArgumentList = @())
    $result = Invoke-Dz23Native -FilePath $FilePath -ArgumentList $ArgumentList -TimeoutSeconds 120
    if ($result.ExitCode -ne 0) { throw "$FilePath falhou no fixture: $($result.StdErr)" }
    $result.StdOut.Trim()
}

function Invoke-TestWsl {
    param(
        [Parameter(Mandatory)][string]$Script,
        [string[]]$Arguments = @(),
        [ValidateRange(1, 300)][int]$TimeoutSeconds = 60
    )
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Script.Replace("`r`n", "`n")))
    $shell = "printf %s $(ConvertTo-Dz23ShellLiteral $encoded) | base64 -d | bash -s --"
    foreach ($argument in $Arguments) { $shell += ' ' + (ConvertTo-Dz23ShellLiteral $argument) }
    $result = Invoke-Dz23Native -FilePath 'wsl.exe' -ArgumentList @('-d', $distro, '--exec', 'bash', '-lc', $shell) `
        -TimeoutSeconds $TimeoutSeconds
    if ($result.ExitCode -ne 0) { throw "Falha no sandbox WSL: $($result.StdErr)" }
    $result.StdOut.Trim()
}

$fakeDocker = @'
#!/usr/bin/env bash
set -euo pipefail
printf '%q ' "$@" >> "$DZ23_FAKE_LOG"; printf '\n' >> "$DZ23_FAKE_LOG"
case "${1:-}" in
  info)
    printf 'linux\n'
    ;;
  image)
    printf '["%s"]\n' "${!#}"
    ;;
  compose)
    shift
    release_env=''; compose_file=''
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --project-name|--env-file|-f)
          option="$1"; value="$2"; shift 2
          if [ "$option" = --env-file ] && [[ "$value" == */release.env ]]; then release_env="$value"; fi
          if [ "$option" = -f ]; then compose_file="$value"; fi
          ;;
        *) break;;
      esac
    done
    test -n "$release_env"; test -f "$release_env"; test -n "$compose_file"; test -f "$compose_file"
    action="${1:-}"; shift || true
    commit="$(sed -n 's/^DZ23_STUDIO_COMMIT=//p' "$release_env")"
    installation_id="$(sed -n 's/^DZ23_INSTALLATION_ID=//p' "$release_env")"
    compose_sha="$(sed -n 's/^DZ23_COMPOSE_SHA256=//p' "$release_env")"
    studio_image="$(sed -n 's/^DZ23_STUDIO_IMAGE=//p' "$release_env")"
    caddy_image="$(sed -n 's/^DZ23_CADDY_IMAGE=//p' "$release_env")"
    case "$action" in
      config)
        if [ "${1:-}" = --services ]; then printf 'app\n'; fi
        if [ "${1:-}" = --images ]; then printf '%s\n%s\n' "$studio_image" "$caddy_image"; fi
        if [ "${1:-}" = --volumes ]; then printf 'data\n'; fi
        if [ "${1:-}" = --networks ]; then printf 'default\n'; fi
        ;;
      up)
        if [ -f "$DZ23_FAKE_STATE/fail-all-up" ]; then exit 17; fi
        if [ -f "$DZ23_FAKE_STATE/fail-commit" ] && [ "$(cat "$DZ23_FAKE_STATE/fail-commit")" = "$commit" ]; then
          rm -f "$DZ23_FAKE_STATE/fail-commit"
          exit 18
        fi
        printf '%064d\n' 0 | tr '0' c > "$DZ23_FAKE_STATE/containers"
        printf '%s|%s|%s|%s\n' "$installation_id" "$commit" "$compose_sha" "$studio_image" > "$DZ23_FAKE_STATE/runtime"
        printf 'dz23-studio_data\n' > "$DZ23_FAKE_STATE/volumes"
        printf 'dz23-studio_default\n' > "$DZ23_FAKE_STATE/networks"
        printf 'up\n' >> "$DZ23_FAKE_STATE/data-mutations"
        ;;
      ps)
        if [ "${1:-}" = --status ] && [ -s "$DZ23_FAKE_STATE/containers" ]; then printf 'app\n'; fi
        if [ "${1:-}" = -q ] && [ -s "$DZ23_FAKE_STATE/containers" ]; then cat "$DZ23_FAKE_STATE/containers"; fi
        ;;
      *) exit 19;;
    esac
    ;;
  ps)
    [ -f "$DZ23_FAKE_STATE/fail-inventory" ] && exit 23
    if [ -s "$DZ23_FAKE_STATE/containers" ]; then
      if [ -f "$DZ23_FAKE_STATE/unlabeled-container" ] && [[ "$*" == *label=com.docker.compose.project* ]]; then :; else cat "$DZ23_FAKE_STATE/containers"; fi
    fi
    ;;
  inspect)
    format="$3"; id="$4"
    IFS='|' read -r installation_id commit compose_sha runtime_image < "$DZ23_FAKE_STATE/runtime"
    if [ -f "$DZ23_FAKE_STATE/homonym-id" ]; then installation_id="$(cat "$DZ23_FAKE_STATE/homonym-id")"; fi
    if [[ "$format" == *release-commit* ]]; then
      health=healthy
      [ -f "$DZ23_FAKE_STATE/no-health" ] && health=none
      [ -f "$DZ23_FAKE_STATE/unhealthy" ] && health=unhealthy
      printf '%s|%s|%s|%s|%s|running\n' "$installation_id" "$commit" "$compose_sha" "$runtime_image" "$health"
    else
      printf '%s\n' "$installation_id"
    fi
    ;;
  stop)
    test -s "$DZ23_FAKE_STATE/containers"
    ;;
  rm)
    : > "$DZ23_FAKE_STATE/containers"
    ;;
  volume)
    shift
    case "${1:-}" in
      ls)
        [ -f "$DZ23_FAKE_STATE/fail-inventory" ] && exit 23
        if [ -s "$DZ23_FAKE_STATE/volumes" ]; then
          if [ -f "$DZ23_FAKE_STATE/unlabeled-volume" ] && [[ "$*" == *label=com.docker.compose.project* ]]; then :; else cat "$DZ23_FAKE_STATE/volumes"; fi
        fi
        ;;
      inspect)
        installation_id="$(cut -d'|' -f1 "$DZ23_FAKE_STATE/runtime")"
        [ -f "$DZ23_FAKE_STATE/homonym-volume-id" ] && installation_id="$(cat "$DZ23_FAKE_STATE/homonym-volume-id")"
        printf '%s\n' "$installation_id"
        ;;
      rm) : > "$DZ23_FAKE_STATE/volumes";;
      *) exit 20;;
    esac
    ;;
  network)
    shift
    case "${1:-}" in
      ls)
        [ -f "$DZ23_FAKE_STATE/fail-inventory" ] && exit 23
        if [ -s "$DZ23_FAKE_STATE/networks" ]; then
          if [ -f "$DZ23_FAKE_STATE/unlabeled-network" ] && [[ "$*" == *label=com.docker.compose.project* ]]; then :; else cat "$DZ23_FAKE_STATE/networks"; fi
        fi
        ;;
      inspect)
        installation_id="$(cut -d'|' -f1 "$DZ23_FAKE_STATE/runtime")"
        [ -f "$DZ23_FAKE_STATE/homonym-network-id" ] && installation_id="$(cat "$DZ23_FAKE_STATE/homonym-network-id")"
        printf '%s\n' "$installation_id"
        ;;
      rm) : > "$DZ23_FAKE_STATE/networks";;
      *) exit 22;;
    esac
    ;;
  *) exit 21;;
esac
'@

$fixtureScript = @'
set -euo pipefail
sandbox="$(mktemp -d "$HOME/dz23-m6.XXXXXX")"
mkdir -p "$sandbox/bin" "$sandbox/fake-state" "$sandbox/config"
printf '%s' "$1" | base64 -d > "$sandbox/bin/docker"
chmod 700 "$sandbox/bin/docker"
printf 'SECRET=value\nDZ23_STUDIO_IMAGE=registry.evil/studio@sha256:%064d\nDZ23_CADDY_IMAGE=registry.evil/caddy@sha256:%064d\nDZ23_STUDIO_COMMIT=%040d\nDZ23_INSTALLATION_ID=%064d\nDZ23_COMPOSE_SHA256=%064d\n' 0 0 0 0 0 | tr '0' e > "$sandbox/config/secrets.env"
chmod 600 "$sandbox/config/secrets.env"
printf '%s\n' "$sandbox"
'@

$fakeDockerEncoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($fakeDocker))
$sandbox = Invoke-TestWsl -Script $fixtureScript -Arguments @($fakeDockerEncoded)
$windowsFixtureBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$windowsFixtureRoot = Join-Path $windowsFixtureBase "dz23-m6 caminho espaço-ação-$([Guid]::NewGuid().ToString('N'))"
$source = Join-Path $windowsFixtureRoot 'origem Studio ü'
$upstream = Join-Path $windowsFixtureRoot 'upstream origem'
[IO.Directory]::CreateDirectory($source) | Out-Null
[IO.Directory]::CreateDirectory($upstream) | Out-Null
$utf8 = [Text.UTF8Encoding]::new($false)
$repositoryUrl = 'https://example.invalid/deepseek-harness.git'

Invoke-FixtureNative git.exe @('-C', $upstream, 'init', '-q') | Out-Null
Invoke-FixtureNative git.exe @('-C', $upstream, 'config', 'user.email', 'm6@example.invalid') | Out-Null
Invoke-FixtureNative git.exe @('-C', $upstream, 'config', 'user.name', 'M6 Test') | Out-Null
[IO.File]::WriteAllText((Join-Path $upstream 'upstream.txt'), "pinned`n", $utf8)
Invoke-FixtureNative git.exe @('-C', $upstream, 'add', 'upstream.txt') | Out-Null
Invoke-FixtureNative git.exe @('-C', $upstream, 'commit', '-qm', 'upstream') | Out-Null
$upstreamCommit = Invoke-FixtureNative git.exe @('-C', $upstream, 'rev-parse', 'HEAD')
$upstreamTree = Invoke-FixtureNative git.exe @('-C', $upstream, 'rev-parse', 'HEAD^{tree}')
$manifestScript = "const{createHash}=require('node:crypto');const{spawnSync}=require('node:child_process');const r=spawnSync('git',['ls-tree','-r','-z','--full-tree','HEAD'],{cwd:process.argv[1],timeout:30000,maxBuffer:1048576});if(r.status)process.exit(r.status);process.stdout.write(createHash('sha256').update(r.stdout).digest('hex'))"
$upstreamManifest = Invoke-FixtureNative node.exe @('-e', $manifestScript, $upstream)

Invoke-FixtureNative git.exe @('-C', $source, 'init', '-q') | Out-Null
Invoke-FixtureNative git.exe @('-C', $source, 'config', 'user.email', 'm6@example.invalid') | Out-Null
Invoke-FixtureNative git.exe @('-C', $source, 'config', 'user.name', 'M6 Test') | Out-Null
[IO.File]::WriteAllText((Join-Path $source 'docker-compose.yml'), "services:`n  app:`n    image: `$`{DZ23_STUDIO_IMAGE}`n    labels:`n      com.dz23.studio.installation-id: `$`{DZ23_INSTALLATION_ID}`n      com.dz23.studio.release-commit: `$`{DZ23_STUDIO_COMMIT}`n      com.dz23.studio.compose-sha256: `$`{DZ23_COMPOSE_SHA256}`n", $utf8)
[IO.File]::WriteAllText((Join-Path $source 'prova espaço-ação.txt'), "one`n", $utf8)
Invoke-FixtureNative git.exe @('-C', $source, '-c', 'protocol.file.allow=always', 'submodule', 'add', '--name', 'deepseek-harness', $upstream, 'third_party/deepseek-harness') | Out-Null
Invoke-FixtureNative git.exe @('-C', $source, 'config', '--file', '.gitmodules', 'submodule.deepseek-harness.url', $repositoryUrl) | Out-Null
Invoke-FixtureNative git.exe @('-C', (Join-Path $source 'third_party/deepseek-harness'), 'remote', 'set-url', 'origin', $repositoryUrl) | Out-Null
Invoke-FixtureNative git.exe @('-C', (Join-Path $source 'third_party/deepseek-harness'), 'config', 'core.filemode', 'false') | Out-Null
Invoke-FixtureNative git.exe @('-C', (Join-Path $source 'third_party/deepseek-harness'), 'config', 'core.autocrlf', 'false') | Out-Null
Invoke-FixtureNative git.exe @('-C', (Join-Path $source 'third_party/deepseek-harness'), 'checkout', '-f', 'HEAD') | Out-Null
$lock = "repository=$repositoryUrl`npath=third_party/deepseek-harness`ncommit=$upstreamCommit`ntree=$upstreamTree`nmanifest_sha256=$upstreamManifest`n"
[IO.File]::WriteAllText((Join-Path $source 'UPSTREAM.lock'), $lock, $utf8)
Invoke-FixtureNative git.exe @('-C', $source, 'add', '.gitmodules', 'UPSTREAM.lock', 'docker-compose.yml', 'prova espaço-ação.txt', 'third_party/deepseek-harness') | Out-Null
Invoke-FixtureNative git.exe @('-C', $source, 'commit', '-qm', 'one') | Out-Null
$commitOne = Invoke-FixtureNative git.exe @('-C', $source, 'rev-parse', 'HEAD')
[IO.File]::WriteAllText((Join-Path $source 'prova espaço-ação.txt'), "two`n", $utf8)
Invoke-FixtureNative git.exe @('-C', $source, 'commit', '-qam', 'two') | Out-Null
$commitTwo = Invoke-FixtureNative git.exe @('-C', $source, 'rev-parse', 'HEAD')
Invoke-FixtureNative git.exe @('-C', $source, 'checkout', '--detach', $commitOne) | Out-Null

$installRoot = "$sandbox/install"
$secrets = "$sandbox/config/secrets.env"
$fakeBin = "$sandbox/bin"
$fakeState = "$sandbox/fake-state"
$fakeLog = "$sandbox/docker.log"
$calls = [Collections.Generic.List[string]]::new()

$invoker = {
    param([string]$FilePath, [string[]]$ArgumentList)
    $calls.Add("$FilePath $($ArgumentList -join ' ')")
    if ($FilePath -eq 'docker.exe' -and $ArgumentList[0] -eq 'info') {
        return [pscustomobject]@{ ExitCode = 0; StdOut = 'linux'; StdErr = '' }
    }
    if ($FilePath -eq 'docker.exe' -and $ArgumentList[0] -eq 'image') {
        return [pscustomobject]@{ ExitCode = 0; StdOut = "[`"$($ArgumentList[-1])`"]"; StdErr = '' }
    }
    if ($FilePath -eq 'git.exe') {
        return Invoke-Dz23Native -FilePath 'git.exe' -ArgumentList $ArgumentList -TimeoutSeconds 120
    }
    if ($FilePath -eq 'wsl.exe') {
        $realArguments = @($ArgumentList)
        if ($realArguments -contains 'bash') {
            $prefix = "export PATH=$(ConvertTo-Dz23ShellLiteral $fakeBin):`$PATH; " +
                "export DZ23_FAKE_STATE=$(ConvertTo-Dz23ShellLiteral $fakeState); " +
                "export DZ23_FAKE_LOG=$(ConvertTo-Dz23ShellLiteral $fakeLog); " +
                "export DZ23_FAKE_IMAGE=$(ConvertTo-Dz23ShellLiteral $image); " +
                "export DZ23_FAKE_RUNTIME_IMAGE=$(ConvertTo-Dz23ShellLiteral $runtimeImage); "
            $realArguments[$realArguments.Count - 1] = $prefix + $realArguments[$realArguments.Count - 1]
        }
        return Invoke-Dz23Native -FilePath 'wsl.exe' -ArgumentList $realArguments -TimeoutSeconds 60
    }
    return [pscustomobject]@{ ExitCode = 91; StdOut = ''; StdErr = "Comando simulado inesperado: $FilePath" }
}

try {
    Invoke-TestWsl -Script @'
set -euo pipefail
printf '%064d\n' 0 | tr 0 a > "$1/containers"
printf 'dz23-studio_data\n' > "$1/volumes"
printf 'dz23-studio_default\n' > "$1/networks"
printf '%064d|%040d|%064d|registry.example/homonym@sha256:%064d\n' 0 0 0 0 | tr 0 e > "$1/runtime"
printf 'dados-homônimos-intactos\n' > "$1/payload"
touch "$1/unlabeled-container" "$1/unlabeled-volume" "$1/unlabeled-network"
: > "$2"
'@ -Arguments @($fakeState, $fakeLog) | Out-Null
    $homonymInstallRejected = $false
    try {
        & $installPath -SourcePath $source -ExpectedCommit $commitOne -Image $image -CaddyImage $caddyImage -SecretsFile $secrets `
            -Start -InstallRoot $installRoot -Distro $distro -CommandInvoker $invoker -Confirm:$false
    } catch { $homonymInstallRejected = $_.Exception.Message -match 'homônimo' }
    $homonymInstallPreserved = Invoke-TestWsl -Script @'
set -euo pipefail
test "$(cat "$1/payload")" = 'dados-homônimos-intactos'
! grep -Eq 'compose .* up( |$)' "$2"
: > "$1/containers"
: > "$1/volumes"
: > "$1/networks"
rm -f "$1/runtime" "$1/unlabeled-container" "$1/unlabeled-volume" "$1/unlabeled-network" "$3/state/operation.journal"
printf preserved
'@ -Arguments @($fakeState, $fakeLog, $installRoot)
    if (-not $homonymInstallRejected -or $homonymInstallPreserved -ne 'preserved') {
        throw 'Instalação adotou ou alterou recursos Docker de projeto homônimo.'
    }

    & $installPath -SourcePath $source -ExpectedCommit $commitOne -Image $image -CaddyImage $caddyImage -SecretsFile $secrets `
        -Start -InstallRoot $installRoot -Distro $distro -CommandInvoker $invoker -Confirm:$false
    $lockProofScript = (Get-Dz23WslSafetyPrelude) + @'

set -euo pipefail
root_real="$(secure_root "$1")"; secure_layout "$root_real"; acquire_operation_lock "$root_real"
if ( exec 8>"$root_real/state/operation.lock"; flock -n 8 ); then exit 91; fi
printf locked
'@
    $lockProof = Invoke-Dz23WslScript -Distro $distro -Script $lockProofScript -Arguments @($installRoot) `
        -TimeoutSeconds 30
    if ($lockProof.StdOut.Trim() -ne 'locked') {
        throw 'A trava não recusou uma segunda operação concorrente.'
    }
    & $doctorPath -ExpectedCommit $commitOne -Image $image -CaddyImage $caddyImage -SecretsFile $secrets `
        -InstallRoot $installRoot -Distro $distro -CommandInvoker $invoker

    Invoke-FixtureNative git.exe @('-C', (Join-Path $source 'third_party/deepseek-harness'), 'remote', 'set-url', 'origin', 'https://example.invalid/tampered.git') | Out-Null
    $upstreamTamperRejected = $false
    try {
        & $installPath -SourcePath $source -ExpectedCommit $commitOne -Image $image -CaddyImage $caddyImage -SecretsFile $secrets `
            -InstallRoot $installRoot -Distro $distro -CommandInvoker $invoker -Confirm:$false
    } catch { $upstreamTamperRejected = $_.Exception.Message -match 'upstream diverge do lock' }
    Invoke-FixtureNative git.exe @('-C', (Join-Path $source 'third_party/deepseek-harness'), 'remote', 'set-url', 'origin', $repositoryUrl) | Out-Null
    if (-not $upstreamTamperRejected) { throw 'Origem adulterada do submodule não falhou fechada.' }

    $windowsPathProof = Invoke-TestWsl -Script @'
set -euo pipefail
release="$(readlink -f "$1/current")"
test "$(cat "$release/prova espaço-ação.txt")" = one
origin="$(git -C "$release" remote get-url origin)"
case "$origin" in /mnt/*) ;;
  *) exit 91;;
esac
printf 'windows-path-ok\n'
'@ -Arguments @($installRoot)
    if ($windowsPathProof -ne 'windows-path-ok') { throw 'O caminho Windows não chegou canonicamente ao Bash.' }
    $wslpathCall = $calls | Where-Object { $_ -like "wsl.exe *wslpath*-a*$source*" }
    if (-not $wslpathCall) { throw 'A chamada explícita a wslpath não recebeu o caminho Windows com espaço/Unicode.' }

    Invoke-FixtureNative git.exe @('-C', $source, 'checkout', '--detach', $commitTwo) | Out-Null
    Invoke-TestWsl -Script 'printf "%064d\n" 0 | tr 0 e > "$1/homonym-network-id"; touch "$1/unlabeled-network"; cp "$1/data-mutations" "$1/data-mutations.before"' `
        -Arguments @($fakeState) | Out-Null
    $homonymUpdateRejected = $false
    try {
        & $updatePath -SourcePath $source -ExpectedCommit $commitTwo -Image $image -CaddyImage $caddyImage -SecretsFile $secrets `
            -InstallRoot $installRoot -Distro $distro -CommandInvoker $invoker -Confirm:$false
    } catch { $homonymUpdateRejected = $_.Exception.Message -match 'homônima|homônimo' }
    $homonymUpdatePreserved = Invoke-TestWsl -Script @'
set -euo pipefail
cmp "$1/data-mutations.before" "$1/data-mutations"
test "$(cat "$1/payload")" = 'dados-homônimos-intactos'
rm -f "$1/homonym-network-id" "$1/unlabeled-network" "$1/data-mutations.before" "$2/state/operation.journal"
printf preserved
'@ -Arguments @($fakeState, $installRoot)
    if (-not $homonymUpdateRejected -or $homonymUpdatePreserved -ne 'preserved') {
        throw 'Atualização adotou ou alterou recursos Docker de projeto homônimo.'
    }

    Invoke-TestWsl -Script 'touch "$1/fail-inventory"; cp "$1/data-mutations" "$1/data-mutations.before"' `
        -Arguments @($fakeState) | Out-Null
    $inventoryFailureRejected = $false
    try {
        & $updatePath -SourcePath $source -ExpectedCommit $commitTwo -Image $image -CaddyImage $caddyImage -SecretsFile $secrets `
            -InstallRoot $installRoot -Distro $distro -CommandInvoker $invoker -Confirm:$false
    } catch { $inventoryFailureRejected = $_.Exception.Message -match 'inventariar contêineres' }
    $inventoryFailurePreserved = Invoke-TestWsl -Script @'
set -euo pipefail
cmp "$1/data-mutations.before" "$1/data-mutations"
rm -f "$1/fail-inventory" "$1/data-mutations.before" "$2/state/operation.journal"
printf preserved
'@ -Arguments @($fakeState, $installRoot)
    if (-not $inventoryFailureRejected -or $inventoryFailurePreserved -ne 'preserved') {
        throw 'Falha de inventário foi mascarada e alcançou mutação de runtime.'
    }

    Invoke-TestWsl -Script 'printf "%s\n" "$1" > "$2/fail-commit"' -Arguments @($commitTwo, $fakeState) | Out-Null
    $rollbackConfirmed = $false
    $rollbackError = 'update retornou sem falhar'
    try {
        & $updatePath -SourcePath $source -ExpectedCommit $commitTwo -Image $image -CaddyImage $caddyImage -SecretsFile $secrets `
            -InstallRoot $installRoot -Distro $distro -CommandInvoker $invoker -Confirm:$false
    } catch {
        $rollbackError = $_.Exception.Message
        $rollbackConfirmed = $_.Exception.Message -match 'rollback executado e readiness da versão anterior confirmado'
    }
    if (-not $rollbackConfirmed) { throw "A simulação não comprovou o rollback saudável: $rollbackError" }

    $stateAfterRollback = Invoke-TestWsl -Script @'
set -euo pipefail
test "$(basename "$(readlink -f "$1/current")")" = "$2"
test "$(cat "$1/state/installed-commit")" = "$2"
grep -F -- '--wait' "$3" >/dev/null
printf 'rollback-ok\n'
'@ -Arguments @($installRoot, $commitOne, $fakeLog)
    if ($stateAfterRollback -ne 'rollback-ok') { throw 'Estado inconsistente após rollback.' }

    Invoke-TestWsl -Script 'touch "$1/fail-all-up"' -Arguments @($fakeState) | Out-Null
    $rollbackRejected = $false
    $rollbackFailure = 'update retornou sem falhar'
    try {
        & $updatePath -SourcePath $source -ExpectedCommit $commitTwo -Image $image -CaddyImage $caddyImage -SecretsFile $secrets `
            -InstallRoot $installRoot -Distro $distro -CommandInvoker $invoker -Confirm:$false
    } catch {
        $rollbackFailure = $_.Exception.Message
        $rollbackRejected = $_.Exception.Message -match 'rollback não comprovou readiness'
    }
    if (-not $rollbackRejected) { throw "Falha de rollback foi declarada como sucesso: $rollbackFailure" }
    $journalRetained = Invoke-TestWsl -Script 'test -f "$1/state/operation.journal"; grep -Fqx "phase=ROLLING_BACK" "$1/state/operation.journal"; printf retained' `
        -Arguments @($installRoot)
    if ($journalRetained -ne 'retained') { throw 'Rollback impossível não preservou journal recuperável.' }
    Invoke-TestWsl -Script 'rm -f "$1/fail-all-up"' -Arguments @($fakeState) | Out-Null
    $recoveryReported = $true
    try {
        & $updatePath -SourcePath $source -ExpectedCommit $commitTwo -Image $image -CaddyImage $caddyImage -SecretsFile $secrets `
            -InstallRoot $installRoot -Distro $distro -CommandInvoker $invoker -Confirm:$false
    } catch {
        $recoveryReported = $false
    }
    if (-not $recoveryReported) { throw 'A retomada não convergiu o journal interrompido.' }
    $recovered = Invoke-TestWsl -Script @'
set -euo pipefail
test ! -e "$1/state/operation.journal"
test "$(basename "$(readlink -f "$1/current")")" = "$2"
test "$(cat "$1/state/installed-commit")" = "$2"
printf recovered
'@ -Arguments @($installRoot, $commitTwo)
    if ($recovered -ne 'recovered') { throw 'Journal recuperado deixou metadados divergentes.' }

    Invoke-TestWsl -Script 'touch "$1/no-health"' -Arguments @($fakeState) | Out-Null
    $missingHealthRejected = $false
    try {
        & $doctorPath -ExpectedCommit $commitTwo -Image $image -CaddyImage $caddyImage -SecretsFile $secrets `
            -InstallRoot $installRoot -Distro $distro -CommandInvoker $invoker
    } catch { $missingHealthRejected = $_.Exception.Message -match 'Serviço sem saúde' }
    Invoke-TestWsl -Script 'rm -f "$1/no-health"' -Arguments @($fakeState) | Out-Null
    if (-not $missingHealthRejected) { throw 'Doctor aceitou contêiner sem healthcheck.' }

    Invoke-TestWsl -Script 'touch "$1/unhealthy"' -Arguments @($fakeState) | Out-Null
    $unhealthyRejected = $false
    try {
        & $doctorPath -ExpectedCommit $commitTwo -Image $image -CaddyImage $caddyImage -SecretsFile $secrets `
            -InstallRoot $installRoot -Distro $distro -CommandInvoker $invoker
    } catch { $unhealthyRejected = $_.Exception.Message -match 'Serviço sem saúde' }
    Invoke-TestWsl -Script 'rm -f "$1/unhealthy"' -Arguments @($fakeState) | Out-Null
    if (-not $unhealthyRejected) { throw 'Doctor aceitou contêiner unhealthy.' }

    Invoke-TestWsl -Script 'printf "%064d\n" 0 | tr 0 e > "$1/homonym-volume-id"' -Arguments @($fakeState) | Out-Null
    $volumeIdentityRejected = $false
    try {
        & $doctorPath -ExpectedCommit $commitTwo -Image $image -CaddyImage $caddyImage -SecretsFile $secrets `
            -InstallRoot $installRoot -Distro $distro -CommandInvoker $invoker
    } catch { $volumeIdentityRejected = $_.Exception.Message -match 'volume de projeto homônimo' }
    Invoke-TestWsl -Script 'rm -f "$1/homonym-volume-id"' -Arguments @($fakeState) | Out-Null
    if (-not $volumeIdentityRejected) { throw 'Doctor aceitou volume com identidade divergente.' }

    Invoke-TestWsl -Script 'printf "%064d\n" 0 | tr 0 e > "$1/homonym-network-id"' -Arguments @($fakeState) | Out-Null
    $networkIdentityRejected = $false
    try {
        & $doctorPath -ExpectedCommit $commitTwo -Image $image -CaddyImage $caddyImage -SecretsFile $secrets `
            -InstallRoot $installRoot -Distro $distro -CommandInvoker $invoker
    } catch { $networkIdentityRejected = $_.Exception.Message -match 'rede de projeto homônima' }
    Invoke-TestWsl -Script 'rm -f "$1/homonym-network-id"' -Arguments @($fakeState) | Out-Null
    if (-not $networkIdentityRejected) { throw 'Doctor aceitou rede com identidade divergente.' }

    $pointerSentinel = "$sandbox/pointer-sentinel"
    Invoke-TestWsl -Script @'
set -euo pipefail
mv -- "$1/state/installed-commit" "$1/state/installed-commit.safe"
printf 'safe\n' > "$2"
ln -s -- "$2" "$1/state/installed-commit"
'@ -Arguments @($installRoot, $pointerSentinel) | Out-Null
    $unsafePointerRejected = $false
    try { & $uninstallPath -InstallRoot $installRoot -Distro $distro -CommandInvoker $invoker -Confirm:$false }
    catch { $unsafePointerRejected = $_.Exception.Message -match 'installed-commit inseguro' }
    $unsafePointerPreserved = Invoke-TestWsl -Script @'
set -euo pipefail
test -s "$3/containers"
test "$(cat "$2")" = safe
rm -f -- "$1/state/installed-commit" "$2"
mv -- "$1/state/installed-commit.safe" "$1/state/installed-commit"
printf preserved
'@ -Arguments @($installRoot, $pointerSentinel, $fakeState)
    if (-not $unsafePointerRejected -or $unsafePointerPreserved -ne 'preserved') { throw 'Uninstall removeu recursos antes de validar installed-commit.' }

    Invoke-TestWsl -Script 'printf "%s\n" "$2" > "$1/state/installed-commit"' -Arguments @($installRoot, $commitOne) | Out-Null
    $divergentPointerRejected = $false
    try { & $uninstallPath -InstallRoot $installRoot -Distro $distro -CommandInvoker $invoker -Confirm:$false }
    catch { $divergentPointerRejected = $_.Exception.Message -match 'current e installed-commit divergem' }
    $divergentPointerPreserved = Invoke-TestWsl -Script @'
set -euo pipefail
test -s "$1/containers"
printf '%s\n' "$2" > "$3/state/installed-commit"
printf preserved
'@ -Arguments @($fakeState, $commitTwo, $installRoot)
    if (-not $divergentPointerRejected -or $divergentPointerPreserved -ne 'preserved') { throw 'Uninstall removeu recursos com ponteiros divergentes.' }

    Invoke-TestWsl -Script 'printf "%064d\n" 0 | tr 0 e > "$1/homonym-volume-id"; touch "$1/unlabeled-volume"' -Arguments @($fakeState) | Out-Null
    $uninstallVolumeRejected = $false
    try { & $uninstallPath -InstallRoot $installRoot -Distro $distro -CommandInvoker $invoker -Confirm:$false }
    catch { $uninstallVolumeRejected = $_.Exception.Message -match 'volume homônimo' }
    $uninstallVolumePreserved = Invoke-TestWsl -Script 'rm -f "$1/homonym-volume-id" "$1/unlabeled-volume"; test -s "$1/containers"; printf preserved' -Arguments @($fakeState)
    if (-not $uninstallVolumeRejected -or $uninstallVolumePreserved -ne 'preserved') { throw 'Uninstall adotou volume físico homônimo sem rótulo.' }

    Invoke-TestWsl -Script 'printf "%064d\n" 0 | tr 0 e > "$1/homonym-network-id"; touch "$1/unlabeled-network"' -Arguments @($fakeState) | Out-Null
    $uninstallNetworkRejected = $false
    try { & $uninstallPath -InstallRoot $installRoot -Distro $distro -CommandInvoker $invoker -Confirm:$false }
    catch { $uninstallNetworkRejected = $_.Exception.Message -match 'rede homônima' }
    $uninstallNetworkPreserved = Invoke-TestWsl -Script 'rm -f "$1/homonym-network-id" "$1/unlabeled-network"; test -s "$1/containers"; printf preserved' -Arguments @($fakeState)
    if (-not $uninstallNetworkRejected -or $uninstallNetworkPreserved -ne 'preserved') { throw 'Uninstall adotou rede física homônima sem rótulo.' }

    Invoke-TestWsl -Script 'printf "%064d\n" 0 | tr 0 e > "$1/homonym-id"' -Arguments @($fakeState) | Out-Null
    $homonymRejected = $false
    try { & $uninstallPath -InstallRoot $installRoot -Distro $distro -CommandInvoker $invoker -Confirm:$false }
    catch { $homonymRejected = $_.Exception.Message -match 'homônimo' }
    $homonymPreserved = Invoke-TestWsl -Script 'rm -f "$1/homonym-id"; test -s "$1/containers"; printf preserved' -Arguments @($fakeState)
    if (-not $homonymRejected -or $homonymPreserved -ne 'preserved') { throw 'Projeto homônimo não falhou fechado.' }

    & $uninstallPath -InstallRoot $installRoot -Distro $distro -CommandInvoker $invoker -Confirm:$false
    $preserved = Invoke-TestWsl -Script @'
set -euo pipefail
test ! -e "$1/current"; test ! -L "$1/current"
test -d "$1/releases"; test -d "$1/state"
test ! -e "$1/state/installed-commit"; test ! -L "$1/state/installed-commit"
test ! -s "$2/containers"; test -s "$2/volumes"; test ! -s "$2/networks"
printf 'preserved\n'
'@ -Arguments @($installRoot, $fakeState)
    if ($preserved -ne 'preserved') { throw 'A desinstalação padrão não preservou os dados.' }

    $sentinel = "$sandbox/sentinel"
    Invoke-TestWsl -Script 'rm -f "$2/state/installed-commit"; printf "safe\n" > "$1"; ln -s "$1" "$2/state/installed-commit"' `
        -Arguments @($sentinel, $installRoot) | Out-Null
    $symlinkRejected = $false
    try {
        Invoke-FixtureNative git.exe @('-C', $source, 'checkout', '--detach', $commitOne) | Out-Null
        & $installPath -SourcePath $source -ExpectedCommit $commitOne -Image $image -CaddyImage $caddyImage -SecretsFile $secrets `
            -Start -InstallRoot $installRoot -Distro $distro -CommandInvoker $invoker -Confirm:$false
    } catch {
        $symlinkRejected = $_.Exception.Message -match 'installed-commit'
    }
    $sentinelValue = Invoke-TestWsl -Script 'cat "$1"; rm -f "$2/state/installed-commit"' -Arguments @($sentinel, $installRoot)
    if (-not $symlinkRejected -or $sentinelValue -ne 'safe') { throw 'Proteção contra symlink não foi comprovada.' }

    & $installPath -SourcePath $source -ExpectedCommit $commitOne -Image $image -CaddyImage $caddyImage -SecretsFile $secrets `
        -Start -InstallRoot $installRoot -Distro $distro -CommandInvoker $invoker -Confirm:$false
    $reinstalled = Invoke-TestWsl -Script @'
set -euo pipefail
test "$(basename "$(readlink -f "$1/current")")" = "$2"
test "$(cat "$1/state/installed-commit")" = "$2"
test -s "$3/volumes"
printf reinstalled
'@ -Arguments @($installRoot, $commitOne, $fakeState)
    if ($reinstalled -ne 'reinstalled') { throw 'A reinstalação não reutilizou com segurança os dados preservados.' }
    & $uninstallPath -InstallRoot $installRoot -Distro $distro -PurgeData `
        -PurgeConfirmation 'APAGAR DADOS DO DZ23 STUDIO' -CommandInvoker $invoker -Confirm:$false
    $purged = Invoke-TestWsl -Script @'
set -euo pipefail
test ! -e "$1/releases"; test ! -L "$1/releases"
test ! -e "$1/state"; test ! -L "$1/state"
test ! -s "$2/containers"; test ! -s "$2/volumes"; test ! -s "$2/networks"
printf 'purged\n'
'@ -Arguments @($installRoot, $fakeState)
    if ($purged -ne 'purged') { throw 'O purge isolado não foi comprovado.' }

    if (-not ($calls | Where-Object { $_ -like 'wsl.exe *bash*' })) { throw 'O Bash real não foi executado.' }
    Write-Output "M6_COMMAND_SIMULATION=PASS bash=real windows-path=space-unicode upstream-tamper=fail-closed journal=recovered concurrency=locked health=missing-and-unhealthy inventory-error=fail-closed homonym=install-update-uninstall-fail-closed rollback=healthy-and-failed reinstall=preserved-data purge=verified calls=$($calls.Count)"
}
finally {
    if ($sandbox) {
        try {
            Invoke-TestWsl -Script @'
set -euo pipefail
case "$1" in "$HOME"/dz23-m6.*) ;; *) exit 90;; esac
test -d "$1"; test ! -L "$1"
rm -rf -- "$1"
'@ -Arguments @($sandbox) | Out-Null
        } catch { Write-Warning $_ }
    }
    if ($windowsFixtureRoot) {
        try {
            $resolvedFixture = [IO.Path]::GetFullPath($windowsFixtureRoot)
            $relativeFixture = [IO.Path]::GetRelativePath($windowsFixtureBase, $resolvedFixture)
            if ($relativeFixture -match '^\.\.' -or [IO.Path]::IsPathRooted($relativeFixture) -or
                -not ([IO.Path]::GetFileName($resolvedFixture).StartsWith('dz23-m6 caminho espaço-ação-'))) {
                throw 'Fixture Windows fora do diretório temporário esperado.'
            }
            Remove-Item -LiteralPath $resolvedFixture -Recurse -Force
        } catch { Write-Warning $_ }
    }
}

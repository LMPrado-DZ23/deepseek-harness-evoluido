Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function New-Dz23Result {
    param([int]$ExitCode, [string]$StdOut = '', [string]$StdErr = '')
    [pscustomobject]@{ ExitCode = $ExitCode; StdOut = $StdOut; StdErr = $StdErr }
}

function Get-Dz23DefaultTimeoutSeconds {
    param([Parameter(Mandatory)][string]$FilePath)
    switch ([IO.Path]::GetFileName($FilePath).ToLowerInvariant()) {
        'wsl.exe' { 120; break }
        'docker.exe' { 120; break }
        'docker' { 120; break }
        'git.exe' { 120; break }
        'git' { 120; break }
        default { 60 }
    }
}

function Limit-Dz23Output {
    param([AllowNull()][string]$Value, [Parameter(Mandatory)][int]$Limit)
    if ([string]::IsNullOrEmpty($Value)) { return '' }
    if ($Value.Length -le $Limit) { return $Value }
    $Value.Substring(0, $Limit) + "`n[saída truncada]"
}

function Invoke-Dz23Native {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [scriptblock]$CommandInvoker,
        [ValidateRange(0, 3600)][int]$TimeoutSeconds = 0,
        [ValidateRange(1024, 1048576)][int]$OutputLimit = 16384
    )
    if ($TimeoutSeconds -eq 0) { $TimeoutSeconds = Get-Dz23DefaultTimeoutSeconds -FilePath $FilePath }
    if ($CommandInvoker) {
        $result = & $CommandInvoker $FilePath $ArgumentList
        return New-Dz23Result -ExitCode $result.ExitCode `
            -StdOut (Limit-Dz23Output -Value $result.StdOut -Limit $OutputLimit) `
            -StdErr (Limit-Dz23Output -Value $result.StdErr -Limit $OutputLimit)
    }
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $FilePath
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    $start.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    foreach ($argument in $ArgumentList) { [void]$start.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    try {
        if (-not $process.Start()) { throw "Não foi possível iniciar $FilePath." }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            try {
                $process.Kill($true)
                if (-not $process.WaitForExit(5000)) { throw 'A árvore do processo não encerrou dentro do limite de segurança.' }
            }
            catch {
                throw "O comando $([IO.Path]::GetFileName($FilePath)) excedeu o tempo limite e sua árvore não pôde ser encerrada com segurança."
            }
            # Não propague a saída de um processo expirado: ela pode conter
            # argumentos, ambiente ou segredos escritos pelo subprocesso.
            try { [void][Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($stdout, $stderr), 5000) } catch {}
            return New-Dz23Result -ExitCode 124 -StdErr "O comando $([IO.Path]::GetFileName($FilePath)) excedeu o tempo limite de ${TimeoutSeconds}s."
        }
        New-Dz23Result -ExitCode $process.ExitCode `
            -StdOut (Limit-Dz23Output -Value $stdout.GetAwaiter().GetResult() -Limit $OutputLimit) `
            -StdErr (Limit-Dz23Output -Value $stderr.GetAwaiter().GetResult() -Limit $OutputLimit)
    }
    finally {
        $process.Dispose()
    }
}

function Invoke-Dz23Checked {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [Parameter(Mandatory)][string]$FailureMessage,
        [scriptblock]$CommandInvoker,
        [ValidateRange(0, 3600)][int]$TimeoutSeconds = 0
    )
    $result = Invoke-Dz23Native -FilePath $FilePath -ArgumentList $ArgumentList -CommandInvoker $CommandInvoker -TimeoutSeconds $TimeoutSeconds
    if ($result.ExitCode -ne 0) {
        $detail = $result.StdErr.Trim()
        if ($detail.Length -gt 300) { $detail = $detail.Substring(0, 300) }
        if ([string]::IsNullOrWhiteSpace($detail)) { throw $FailureMessage }
        throw "${FailureMessage}: $detail"
    }
    $result
}

function Assert-Dz23Commit {
    param([Parameter(Mandatory)][string]$Commit)
    if ($Commit -cnotmatch '^[0-9a-f]{40}$') {
        throw 'O commit esperado precisa ter exatamente 40 caracteres hexadecimais minúsculos.'
    }
}

function Assert-Dz23ImageDigest {
    param([Parameter(Mandatory)][string]$Image)
    if ($Image -cnotmatch '^[a-z0-9][a-z0-9._/-]*(?::[a-z0-9][a-z0-9._-]*)?@sha256:[0-9a-f]{64}$') {
        throw 'A imagem precisa estar fixada por digest completo, no formato repositorio@sha256:64_hex.'
    }
}

function Assert-Dz23LinuxPath {
    param([Parameter(Mandatory)][string]$Path, [string]$Label = 'caminho')
    if ($Path -cnotmatch '^/(home/[^/]+|root)/[^/].*' -or $Path.Contains("`0") -or $Path -match '(^|/)\.\.?(/|$)' -or $Path.Contains('//')) {
        throw "O $Label precisa ficar numa subpasta específica de /home/usuario ou /root no disco Linux do WSL2, nunca em /mnt/c ou numa pasta ampla."
    }
    if ($Path -match "[\r\n]" -or $Path.Contains("'")) {
        throw "O $Label contém caracteres não permitidos."
    }
}

function Resolve-Dz23InstallRoot {
    param(
        [Parameter(Mandatory)][string]$Distro,
        [string]$InstallRoot,
        [scriptblock]$CommandInvoker
    )
    if (-not [string]::IsNullOrWhiteSpace($InstallRoot)) {
        Assert-Dz23LinuxPath $InstallRoot 'diretório de instalação'
        return $InstallRoot
    }
    $home = Invoke-Dz23Checked -FilePath 'wsl.exe' `
        -ArgumentList @('-d', $Distro, '--exec', 'sh', '-lc', 'printf %s "$HOME"') `
        -FailureMessage 'Não foi possível descobrir a pasta pessoal da distribuição WSL2' `
        -CommandInvoker $CommandInvoker -TimeoutSeconds 30
    $resolved = $home.StdOut.Trim()
    if ($resolved -cnotmatch '^(/home/[A-Za-z0-9._-]+|/root)$') {
        throw 'A pasta pessoal informada pelo WSL2 não é segura para a instalação.'
    }
    $result = "$resolved/.local/share/dz23-studio"
    Assert-Dz23LinuxPath $result 'diretório de instalação'
    $result
}

function Assert-Dz23NotElevated {
    if (-not $IsWindows) { throw 'Esta ferramenta deve ser executada no Windows 11.' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Feche esta janela de administrador e execute novamente como usuário comum. O DZ23 STUDIO não pede elevação.'
    }
}

function ConvertTo-Dz23ShellLiteral {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)
    if ($Value.Contains("`0")) { throw 'Valor inválido para o comando Linux.' }
    $escapedQuote = "'" + [char]34 + "'" + [char]34 + "'"
    "'" + $Value.Replace("'", $escapedQuote) + "'"
}

function Invoke-Dz23WslScript {
    param(
        [Parameter(Mandatory)][string]$Distro,
        [Parameter(Mandatory)][string]$Script,
        [string[]]$Arguments = @(),
        [scriptblock]$CommandInvoker,
        [string]$FailureMessage = 'O comando no WSL2 falhou',
        [ValidateRange(1, 3600)][int]$TimeoutSeconds = 900
    )
    if ($Distro -notmatch '^[A-Za-z0-9._-]{1,80}$') { throw 'Nome de distribuição WSL inválido.' }
    $normalizedScript = $Script.Replace("`r`n", "`n").Replace("`r", "`n")
    $sourceBytes = [Text.Encoding]::UTF8.GetBytes($normalizedScript)
    $compressed = [IO.MemoryStream]::new()
    $gzip = [IO.Compression.GZipStream]::new($compressed, [IO.Compression.CompressionLevel]::SmallestSize, $true)
    try { $gzip.Write($sourceBytes, 0, $sourceBytes.Length) } finally { $gzip.Dispose() }
    $encoded = [Convert]::ToBase64String($compressed.ToArray())
    $compressed.Dispose()
    $shell = "printf %s $(ConvertTo-Dz23ShellLiteral $encoded) | base64 -d | gzip -d | bash -s --"
    foreach ($argument in $Arguments) { $shell += ' ' + (ConvertTo-Dz23ShellLiteral $argument) }
    Invoke-Dz23Checked -FilePath 'wsl.exe' -ArgumentList @('-d', $Distro, '--exec', 'bash', '-lc', $shell) `
        -FailureMessage $FailureMessage -CommandInvoker $CommandInvoker -TimeoutSeconds $TimeoutSeconds
}

function Test-Dz23Prerequisites {
    param([Parameter(Mandatory)][string]$Distro, [scriptblock]$CommandInvoker)
    if (-not $CommandInvoker) {
        Assert-Dz23NotElevated
        if ([Environment]::OSVersion.Version.Build -lt 22000) { throw 'É necessário Windows 11 (build 22000 ou mais recente).' }
    }
    foreach ($command in 'wsl.exe', 'docker.exe', 'git.exe') {
        if (-not $CommandInvoker -and -not (Get-Command $command -ErrorAction SilentlyContinue)) {
            throw "Pré-requisito ausente: $command. Instale/configure-o fora deste script e tente novamente."
        }
    }
    $wslProbe = @'
set -eu
grep -qi 'microsoft-standard-wsl2' /proc/version
case "$(stat -f -c %T /home)" in ext2/ext3|ext2|ext3|ext4) ;; *) exit 41;; esac
command -v git >/dev/null
command -v docker >/dev/null
command -v realpath >/dev/null
command -v mountpoint >/dev/null
command -v findmnt >/dev/null
command -v sha256sum >/dev/null
command -v gzip >/dev/null
command -v flock >/dev/null
command -v od >/dev/null
test "$(docker info --format '{{.OSType}}')" = 'linux'
'@
    Invoke-Dz23WslScript -Distro $Distro -Script $wslProbe -CommandInvoker $CommandInvoker `
        -FailureMessage 'A distribuição escolhida não está pronta como WSL2 com /home em disco Linux, Git e Docker' `
        -TimeoutSeconds 120 | Out-Null
    $docker = Invoke-Dz23Checked -FilePath 'docker.exe' -ArgumentList @('info', '--format', '{{.OSType}}') `
        -FailureMessage 'O Docker Desktop não está disponível' -CommandInvoker $CommandInvoker -TimeoutSeconds 60
    if ($docker.StdOut.Trim() -ne 'linux') { throw 'O Docker Desktop precisa estar usando contêineres Linux.' }
}

function Test-Dz23Source {
    param(
        [Parameter(Mandatory)][string]$SourcePath,
        [Parameter(Mandatory)][string]$ExpectedCommit,
        [scriptblock]$CommandInvoker
    )
    if (-not $CommandInvoker) {
        $resolved = (Resolve-Path -LiteralPath $SourcePath -ErrorAction Stop).Path
        if (-not (Test-Path -LiteralPath $resolved -PathType Container)) { throw 'A origem precisa ser uma pasta Git.' }
    } else { $resolved = $SourcePath }
    $head = Invoke-Dz23Checked -FilePath 'git.exe' -ArgumentList @('-C', $resolved, 'rev-parse', 'HEAD') `
        -FailureMessage 'Não foi possível confirmar o commit da origem' -CommandInvoker $CommandInvoker -TimeoutSeconds 120
    if ($head.StdOut.Trim() -cne $ExpectedCommit) { throw 'O commit da origem não corresponde ao commit esperado. Instalação interrompida.' }
    $dirty = Invoke-Dz23Checked -FilePath 'git.exe' -ArgumentList @('-C', $resolved, 'status', '--porcelain=v1', '--untracked-files=all') `
        -FailureMessage 'Não foi possível confirmar a integridade da origem' -CommandInvoker $CommandInvoker -TimeoutSeconds 120
    if (-not [string]::IsNullOrWhiteSpace($dirty.StdOut)) { throw 'A origem possui alterações rastreadas ou arquivos não rastreados relevantes. Use um checkout limpo e auditado.' }
    $resolved
}

function ConvertTo-Dz23WslSourcePath {
    param(
        [Parameter(Mandatory)][string]$Distro,
        [Parameter(Mandatory)][string]$WindowsPath,
        [scriptblock]$CommandInvoker
    )
    $converted = Invoke-Dz23Checked -FilePath 'wsl.exe' `
        -ArgumentList @('-d', $Distro, '--exec', 'wslpath', '-a', $WindowsPath) `
        -FailureMessage 'Não foi possível converter a origem Windows para a distribuição WSL2' `
        -CommandInvoker $CommandInvoker -TimeoutSeconds 30
    $wslPath = $converted.StdOut.TrimEnd("`r", "`n")
    if ([string]::IsNullOrWhiteSpace($wslPath) -or $wslPath -notmatch '^/' -or $wslPath -match "[`r`n`0]") {
        throw 'O wslpath retornou um caminho Linux inválido para a origem.'
    }
    $probe = @'
set -euo pipefail
source_path="$1"
test -d "$source_path"
test ! -L "$source_path"
realpath -e -- "$source_path"
'@
    $canonical = Invoke-Dz23WslScript -Distro $Distro -Script $probe -Arguments @($wslPath) `
        -CommandInvoker $CommandInvoker -FailureMessage 'A origem convertida não existe como diretório real dentro do WSL2' `
        -TimeoutSeconds 30
    $canonicalPath = $canonical.StdOut.TrimEnd("`r", "`n")
    if ([string]::IsNullOrWhiteSpace($canonicalPath) -or $canonicalPath -notmatch '^/' -or $canonicalPath -match "[`r`n`0]") {
        throw 'A origem canônica retornada pelo WSL2 é inválida.'
    }
    $canonicalPath
}

function Get-Dz23WslSafetyPrelude {
    @'
die() { printf '%s\n' "$1" >&2; exit "${2:-1}"; }

require_linux_filesystem() {
  local target="$1" label="$2" fs
  fs="$(stat -f -c %T -- "$target")"
  case "$fs" in
    ext2/ext3|ext2|ext3|ext4) ;;
    *) die "$label precisa estar em ext2/ext3/ext4; encontrado: $fs" 40 ;;
  esac
}

assert_managed_directory() {
  local target="$1" expected="$2" label="$3" actual
  test -d "$target" || die "$label não é um diretório" 41
  test ! -L "$target" || die "$label não pode ser link simbólico" 42
  mountpoint -q -- "$target" && die "$label não pode ser junction, bind mount ou ponto de montagem" 43
  actual="$(realpath -e -- "$target")"
  test "$actual" = "$expected" || die "$label escapou da raiz gerenciada" 44
  require_linux_filesystem "$actual" "$label"
}

assert_regular_file() {
  local target="$1" label="$2"
  test -f "$target" || die "$label não é um arquivo regular" 45
  test ! -L "$target" || die "$label não pode ser link simbólico" 46
  mountpoint -q -- "$target" && die "$label não pode ser junction, bind mount ou ponto de montagem" 47
  return 0
}

assert_no_nested_mounts() {
  local target="$1" mounted
  while IFS= read -r mounted; do
    case "$mounted" in
      "$target"|"$target"/*) die "$target contém junction, bind mount ou ponto de montagem" 48;;
    esac
  done < <(findmnt -rn --raw -o TARGET)
}

secure_root() {
  local requested="$1" allow_create="${2:-false}" root_real
  case "$requested" in /mnt/*|'/'|'/home'|'') die 'Destino inseguro' 20;; esac
  if [ ! -e "$requested" ] && [ ! -L "$requested" ]; then
    test "$allow_create" = true || die 'A instalação ainda não existe' 21
    mkdir -p -- "$requested"
  fi
  test -d "$requested" || die 'A raiz da instalação não é um diretório' 22
  test ! -L "$requested" || die 'A raiz da instalação não pode ser link simbólico' 23
  root_real="$(realpath -e -- "$requested")"
  case "$root_real" in /home/*/*|/root/*) ;; *) die 'Destino físico fora da área permitida' 24;; esac
  mountpoint -q -- "$root_real" && die 'A raiz não pode ser junction, bind mount ou ponto de montagem' 25
  require_linux_filesystem "$root_real" 'A raiz da instalação'
  printf '%s\n' "$root_real"
}

secure_layout() {
  local root_real="$1" allow_create="${2:-false}"
  if [ "$allow_create" = true ]; then
    mkdir -p -- "$root_real/releases" "$root_real/state"
  fi
  assert_managed_directory "$root_real/releases" "$root_real/releases" 'O diretório releases'
  assert_managed_directory "$root_real/state" "$root_real/state" 'O diretório state'
  assert_no_nested_mounts "$root_real/releases"
  assert_no_nested_mounts "$root_real/state"
}

assert_release_repository() {
  local root_real="$1" release="$2" expected_commit="${3:-}" expected_source="${4:-}"
  local name actual head dirty origin source_real origin_real
  name="$(basename -- "$release")"
  case "$name" in *[!0-9a-f]*|'') die 'Nome de release inválido' 50;; esac
  test "${#name}" -eq 40 || die 'Nome de release inválido' 50
  actual="$(realpath -e -- "$release")"
  test "$actual" = "$root_real/releases/$name" || die 'Release fora de releases' 51
  assert_managed_directory "$release" "$root_real/releases/$name" 'O release'
  assert_managed_directory "$release/.git" "$root_real/releases/$name/.git" 'Os metadados Git do release'
  assert_regular_file "$release/docker-compose.yml" 'O docker-compose.yml do release'
  head="$(git -C "$release" rev-parse --verify HEAD)"
  test "$head" = "$name" || die 'HEAD do release não corresponde ao diretório' 52
  if [ -n "$expected_commit" ]; then test "$head" = "$expected_commit" || die 'HEAD do release não corresponde ao commit esperado' 53; fi
  dirty="$(git -C "$release" status --porcelain=v1 --untracked-files=all -- . ':(exclude)release.env')"
  test -z "$dirty" || die 'Release possui alterações rastreadas ou arquivos não rastreados relevantes' 54
  origin="$(git -C "$release" remote get-url origin)"
  test -n "$origin" || die 'Release sem origem Git comprovável' 55
  case "$origin" in /*) ;; *) die 'A origem Git do release não é um caminho absoluto fixado' 56;; esac
  if [ -n "$expected_source" ]; then
    source_real="$(realpath -e -- "$expected_source")"
    origin_real="$(realpath -e -- "$origin")"
    test "$origin_real" = "$source_real" || die 'A origem Git do release diverge da origem auditada' 57
  fi
  assert_upstream_declaration "$release" >/dev/null
}

assert_staged_repository() {
  local stage="$1" expected_commit="$2" expected_source="$3" head dirty origin source_real origin_real
  test -d "$stage" || die 'Stage do release ausente' 77
  test ! -L "$stage" || die 'Stage do release não pode ser link simbólico' 78
  mountpoint -q -- "$stage" && die 'Stage do release não pode ser ponto de montagem' 79
  assert_managed_directory "$stage/.git" "$(realpath -e -- "$stage")/.git" 'Os metadados Git do stage'
  assert_regular_file "$stage/docker-compose.yml" 'O docker-compose.yml do stage'
  head="$(git -C "$stage" rev-parse --verify HEAD)"
  test "$head" = "$expected_commit" || die 'HEAD do stage não corresponde ao commit esperado' 80
  dirty="$(git -C "$stage" status --porcelain=v1 --untracked-files=all)"
  test -z "$dirty" || die 'Stage possui alterações rastreadas ou não rastreadas' 81
  origin="$(git -C "$stage" remote get-url origin)"
  case "$origin" in /*) ;; *) die 'A origem Git do stage não é absoluta' 82;; esac
  source_real="$(realpath -e -- "$expected_source")"
  origin_real="$(realpath -e -- "$origin")"
  test "$origin_real" = "$source_real" || die 'A origem Git do stage diverge da origem auditada' 83
  assert_upstream_declaration "$stage" >/dev/null
}

lock_value() {
  local lock="$1" key="$2" count value
  count="$(awk -v key="$key" 'index($0, key "=") == 1 { count++ } END { print count + 0 }' "$lock")"
  test "$count" -eq 1 || die "UPSTREAM.lock precisa conter exatamente uma chave $key" 92
  value="$(awk -v key="$key" 'index($0, key "=") == 1 { sub(/^[^=]*=/, ""); print }' "$lock")"
  test -n "$value" || die "UPSTREAM.lock contém valor vazio para $key" 93
  printf '%s\n' "$value"
}

assert_upstream_declaration() {
  local repository_root="$1" lock modules repository path commit tree manifest module_keys module_key module_url gitlink
  lock="$repository_root/UPSTREAM.lock"
  modules="$repository_root/.gitmodules"
  assert_regular_file "$lock" 'O UPSTREAM.lock'
  assert_regular_file "$modules" 'O .gitmodules'
  repository="$(lock_value "$lock" repository)"
  path="$(lock_value "$lock" path)"
  commit="$(lock_value "$lock" commit)"
  tree="$(lock_value "$lock" tree)"
  manifest="$(lock_value "$lock" manifest_sha256)"
  case "$commit" in *[!0-9a-f]*|'') die 'Commit inválido em UPSTREAM.lock' 94;; esac
  case "$tree" in *[!0-9a-f]*|'') die 'Tree inválida em UPSTREAM.lock' 95;; esac
  case "$manifest" in *[!0-9a-f]*|'') die 'Manifesto inválido em UPSTREAM.lock' 96;; esac
  test "${#commit}" -eq 40 && test "${#tree}" -eq 40 && test "${#manifest}" -eq 64 || die 'Hashes inválidos em UPSTREAM.lock' 97
  case "$path" in /*|../*|*/../*|*/..|.|*\\*|'') die 'Path inseguro em UPSTREAM.lock' 98;; esac
  case "$path" in *[!A-Za-z0-9._/-]*) die 'Path não portável em UPSTREAM.lock' 99;; esac
  module_keys="$(git -C "$repository_root" config --file .gitmodules --get-regexp '^submodule\..*\.path$' | awk -v path="$path" '$2 == path { print $1 }')"
  test "$(printf '%s\n' "$module_keys" | sed '/^$/d' | wc -l)" -eq 1 || die 'Submodule pin não é único em .gitmodules' 100
  module_key="${module_keys%.path}"
  module_url="$(git -C "$repository_root" config --file .gitmodules --get "${module_key}.url")"
  test "$module_url" = "$repository" || die "URL do submodule diverge de UPSTREAM.lock ($module_url != $repository)" 101
  gitlink="$(git -C "$repository_root" ls-files --stage -- "$path")"
  test "$gitlink" = "160000 $commit 0"$'\t'"$path" || die 'Gitlink diverge de UPSTREAM.lock' 102
  printf '%s\n%s\n%s\n%s\n%s\n' "$repository" "$path" "$commit" "$tree" "$manifest"
}

assert_upstream_source_pin() {
  local repository_root="$1" declaration repository path commit tree manifest upstream upstream_real origin actual_commit actual_tree actual_manifest dirty
  declaration="$(assert_upstream_declaration "$repository_root")"
  repository="$(printf '%s\n' "$declaration" | sed -n '1p')"
  path="$(printf '%s\n' "$declaration" | sed -n '2p')"
  commit="$(printf '%s\n' "$declaration" | sed -n '3p')"
  tree="$(printf '%s\n' "$declaration" | sed -n '4p')"
  manifest="$(printf '%s\n' "$declaration" | sed -n '5p')"
  upstream="$repository_root/$path"
  test -d "$upstream" || die 'Submodule upstream não está materializado na origem auditada' 103
  test ! -L "$upstream" || die 'Submodule upstream não pode ser link simbólico' 104
  upstream_real="$(realpath -e -- "$upstream")"
  test "$upstream_real" = "$upstream" || die 'Submodule upstream escapou da origem auditada' 105
  origin="$(git -C "$upstream" remote get-url origin)"
  actual_commit="$(git -C "$upstream" rev-parse --verify HEAD)"
  actual_tree="$(git -C "$upstream" rev-parse 'HEAD^{tree}')"
  dirty="$(git -C "$upstream" status --porcelain=v1 --untracked-files=all)"
  actual_manifest="$(git -C "$upstream" ls-tree -r -z --full-tree HEAD | sha256sum | awk '{ print $1 }')"
  test "$origin" = "$repository" || die 'Origin materializada do upstream diverge do lock' 106
  test "$actual_commit" = "$commit" || die 'Commit materializado do upstream diverge do lock' 107
  test "$actual_tree" = "$tree" || die 'Tree materializada do upstream diverge do lock' 108
  test -z "$dirty" || die "Submodule upstream possui alterações ou untracked: $dirty" 109
  test "$actual_manifest" = "$manifest" || die 'Manifesto materializado do upstream diverge do lock' 110
}

assert_release_env() {
  local release="$1" expected_commit="${2:-}" env_file env_commit mode
  env_file="$release/release.env"
  assert_regular_file "$env_file" 'O release.env'
  test "$(realpath -e -- "$env_file")" = "$release/release.env" || die 'release.env fora do release' 58
  test "$(grep -c '^DZ23_STUDIO_IMAGE=[a-z0-9][a-z0-9._/-]*\(:[a-z0-9][a-z0-9._-]*\)\?@sha256:[0-9a-f]\{64\}$' "$env_file")" -eq 1 || die 'Imagem inválida em release.env' 59
  test "$(grep -c '^DZ23_CADDY_IMAGE=[a-z0-9][a-z0-9._/-]*\(:[a-z0-9][a-z0-9._-]*\)\?@sha256:[0-9a-f]\{64\}$' "$env_file")" -eq 1 || die 'Imagem Caddy inválida em release.env' 113
  test "$(grep -c '^DZ23_STUDIO_COMMIT=[0-9a-f]\{40\}$' "$env_file")" -eq 1 || die 'Commit inválido em release.env' 60
  test "$(grep -c '^DZ23_INSTALLATION_ID=[0-9a-f]\{64\}$' "$env_file")" -eq 1 || die 'Identidade inválida em release.env' 114
  test "$(grep -c '^DZ23_COMPOSE_SHA256=[0-9a-f]\{64\}$' "$env_file")" -eq 1 || die 'Hash do Compose inválido em release.env' 115
  test "$(wc -l < "$env_file")" -eq 5 || die 'release.env contém campos inesperados' 61
  mode="$(stat -c %a -- "$env_file")"
  test "$mode" = 600 || die 'release.env precisa ter modo 600' 90
  env_commit="$(sed -n 's/^DZ23_STUDIO_COMMIT=//p' "$env_file")"
  if [ -n "$expected_commit" ]; then test "$env_commit" = "$expected_commit" || die 'Commit de release.env divergente' 62; fi
}

resolve_current_release() {
  local root_real="$1" current_link current name
  current_link="$root_real/current"
  test -L "$current_link" || die 'O ponteiro current não é um link simbólico' 63
  current="$(readlink -f -- "$current_link")"
  name="$(basename -- "$current")"
  test "$current" = "$root_real/releases/$name" || die 'current aponta para fora de releases' 64
  assert_release_repository "$root_real" "$current"
  printf '%s\n' "$current"
}

assert_installed_commit() {
  local root_real="$1" expected="$2" file mode
  file="$root_real/state/installed-commit"
  assert_regular_file "$file" 'O installed-commit'
  test "$(realpath -e -- "$file")" = "$root_real/state/installed-commit" || die 'installed-commit fora de state' 65
  test "$(wc -l < "$file")" -eq 1 || die 'installed-commit inválido' 66
  mode="$(stat -c %a -- "$file")"
  test "$mode" = 600 || die 'installed-commit precisa ter modo 600' 91
  test "$(cat -- "$file")" = "$expected" || die 'installed-commit divergente' 67
}

write_release_env() {
  local release="$1" image="$2" caddy_image="$3" commit="$4" installation_id="$5" target temp compose_sha
  target="$release/release.env"
  if [ -e "$target" ] || [ -L "$target" ]; then
    assert_regular_file "$target" 'O release.env existente'
    test "$(realpath -e -- "$target")" = "$target" || die 'release.env fora do release' 68
  fi
  git -C "$release" ls-files --error-unmatch -- release.env >/dev/null 2>&1 && die 'release.env não pode sobrescrever arquivo rastreado' 69
  compose_sha="$(sha256sum -- "$release/docker-compose.yml" | awk '{ print $1 }')"
  temp="$(mktemp "$release/.release.env.XXXXXX")"
  printf 'DZ23_STUDIO_IMAGE=%s\nDZ23_CADDY_IMAGE=%s\nDZ23_STUDIO_COMMIT=%s\nDZ23_INSTALLATION_ID=%s\nDZ23_COMPOSE_SHA256=%s\n' \
    "$image" "$caddy_image" "$commit" "$installation_id" "$compose_sha" > "$temp"
  chmod 600 "$temp"
  mv -Tf -- "$temp" "$target"
  assert_release_env "$release" "$commit"
}

acquire_operation_lock() {
  local root_real="$1"
  exec 9>"$root_real/state/operation.lock"
  chmod 600 "$root_real/state/operation.lock"
  flock -n 9 || die 'Outra instalação, atualização, diagnóstico ou remoção já está em andamento' 116
}

read_installation_id() {
  local root_real="$1" file id mode
  file="$root_real/state/installation-id"
  assert_regular_file "$file" 'A identidade da instalação'
  test "$(realpath -e -- "$file")" = "$file" || die 'Identidade da instalação fora de state' 117
  mode="$(stat -c %a -- "$file")"; test "$mode" = 600 || die 'Identidade da instalação precisa ter modo 600' 118
  test "$(wc -l < "$file")" -eq 1 || die 'Identidade da instalação inválida' 119
  id="$(cat -- "$file")"
  case "$id" in *[!0-9a-f]*|'') die 'Identidade da instalação inválida' 119;; esac
  test "${#id}" -eq 64 || die 'Identidade da instalação inválida' 119
  printf '%s\n' "$id"
}

ensure_installation_id() {
  local root_real="$1" file temp id
  file="$root_real/state/installation-id"
  if [ -e "$file" ] || [ -L "$file" ]; then read_installation_id "$root_real"; return; fi
  id="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
  test "${#id}" -eq 64 || die 'Não foi possível criar a identidade da instalação' 120
  temp="$(mktemp "$root_real/state/.installation-id.XXXXXX")"
  printf '%s\n' "$id" > "$temp"; chmod 600 "$temp"; mv -Tf -- "$temp" "$file"
  read_installation_id "$root_real"
}

assert_no_operation_journal() {
  local root_real="$1" file="$1/state/operation.journal"
  test ! -e "$file" && test ! -L "$file" || die 'Há uma operação interrompida; execute install/update para recuperá-la antes do diagnóstico ou remoção' 121
}

write_operation_journal() {
  local root_real="$1" phase="$2" target="$3" previous="$4" start="$5" file temp
  case "$phase" in PREPARED|STARTING|RUNTIME_READY|ROLLING_BACK|COMMITTED) ;; *) die 'Fase de journal inválida' 122;; esac
  case "$target" in *[!0-9a-f]*|'') die 'Target inválido no journal' 123;; esac
  test "${#target}" -eq 40 || die 'Target inválido no journal' 123
  if [ "$previous" != none ]; then case "$previous" in *[!0-9a-f]*|'') die 'Previous inválido no journal' 124;; esac; test "${#previous}" -eq 40 || die 'Previous inválido no journal' 124; fi
  case "$start" in true|false) ;; *) die 'Start inválido no journal' 125;; esac
  file="$root_real/state/operation.journal"; temp="$(mktemp "$root_real/state/.operation.journal.XXXXXX")"
  printf 'phase=%s\ntarget_commit=%s\nprevious_commit=%s\nstart=%s\n' "$phase" "$target" "$previous" "$start" > "$temp"
  chmod 600 "$temp"; mv -Tf -- "$temp" "$file"
}

read_journal_value() {
  local file="$1" key="$2" count value
  count="$(grep -c "^${key}=" "$file")"; test "$count" -eq 1 || die "Journal inválido: $key" 126
  value="$(sed -n "s/^${key}=//p" "$file")"; test -n "$value" || die "Journal inválido: $key" 126
  printf '%s\n' "$value"
}

clear_operation_journal() {
  local file="$1/state/operation.journal"
  if [ -e "$file" ] || [ -L "$file" ]; then assert_regular_file "$file" 'O journal de operação'; rm -f -- "$file"; fi
}

recover_operation() {
  local root_real="$1" source="$2" secrets="$3" installation_id="$4" file phase target previous start target_release previous_release
  file="$root_real/state/operation.journal"
  if [ ! -e "$file" ] && [ ! -L "$file" ]; then return; fi
  assert_regular_file "$file" 'O journal de operação'; test "$(realpath -e -- "$file")" = "$file" || die 'Journal fora de state' 127
  test "$(stat -c %a -- "$file")" = 600 && test "$(wc -l < "$file")" -eq 4 || die 'Journal inválido' 128
  phase="$(read_journal_value "$file" phase)"; target="$(read_journal_value "$file" target_commit)"
  previous="$(read_journal_value "$file" previous_commit)"; start="$(read_journal_value "$file" start)"
  case "$phase" in PREPARED|STARTING|RUNTIME_READY|ROLLING_BACK|COMMITTED) ;; *) die 'Fase desconhecida no journal' 129;; esac
  case "$target" in *[!0-9a-f]*|'') die 'Target inválido no journal' 130;; esac; test "${#target}" -eq 40 || die 'Target inválido no journal' 130
  if [ "$previous" != none ]; then case "$previous" in *[!0-9a-f]*|'') die 'Previous inválido no journal' 124;; esac; test "${#previous}" -eq 40 || die 'Previous inválido no journal' 124; fi
  case "$start" in true|false) ;; *) die 'Start inválido no journal' 131;; esac
  target_release="$root_real/releases/$target"
  assert_release_repository "$root_real" "$target_release" "$target" "$source"
  assert_release_env "$target_release" "$target"
  grep -Fqx "DZ23_INSTALLATION_ID=$installation_id" "$target_release/release.env" || die 'Identidade da release divergente durante recuperação' 132
  if [ "$start" = true ]; then
    validate_secrets "$secrets"
    if [ "$phase" = ROLLING_BACK ] && [ "$previous" != none ]; then
      previous_release="$root_real/releases/$previous"
      if assert_release_repository "$root_real" "$previous_release" "$previous" "$source" && assert_release_env "$previous_release" "$previous" &&
         start_compose_release "$previous_release" "$secrets"; then
        switch_current "$root_real" "$previous_release"; write_installed_commit "$root_real" "$previous"; clear_operation_journal "$root_real"; return
      fi
    fi
    if compose_for_release "$target_release" "$secrets" config --quiet && assert_compose_images_pinned "$target_release" "$secrets" &&
       start_compose_release "$target_release" "$secrets"; then
      switch_current "$root_real" "$target_release"; write_installed_commit "$root_real" "$target"; clear_operation_journal "$root_real"; return
    fi
    if [ "$previous" != none ]; then
      previous_release="$root_real/releases/$previous"
      if assert_release_repository "$root_real" "$previous_release" "$previous" "$source" && assert_release_env "$previous_release" "$previous" &&
         start_compose_release "$previous_release" "$secrets"; then
        switch_current "$root_real" "$previous_release"; write_installed_commit "$root_real" "$previous"; clear_operation_journal "$root_real"; return
      fi
    fi
    die 'Não foi possível recuperar nem o target nem a release anterior' 133
  fi
  switch_current "$root_real" "$target_release"; write_installed_commit "$root_real" "$target"; clear_operation_journal "$root_real"
}

write_installed_commit() {
  local root_real="$1" commit="$2" target temp
  target="$root_real/state/installed-commit"
  if [ -e "$target" ] || [ -L "$target" ]; then assert_regular_file "$target" 'O installed-commit existente'; fi
  temp="$(mktemp "$root_real/state/.installed-commit.XXXXXX")"
  printf '%s\n' "$commit" > "$temp"
  chmod 600 "$temp"
  mv -Tf -- "$temp" "$target"
  assert_installed_commit "$root_real" "$commit"
}

switch_current() {
  local root_real="$1" release="$2" temp
  temp="$root_real/.current.$$.new"
  if [ -e "$root_real/current" ] && [ ! -L "$root_real/current" ]; then die 'current existente não é um link simbólico' 70; fi
  test ! -e "$temp" && test ! -L "$temp" || die 'Ponteiro temporário já existe' 71
  ln -s -- "$release" "$temp"
  mv -Tf -- "$temp" "$root_real/current"
  test "$(readlink -f -- "$root_real/current")" = "$release" || die 'Falha ao fixar current' 72
}

validate_secrets() {
  local secrets="$1" secrets_real mode
  assert_regular_file "$secrets" 'O arquivo de segredos'
  secrets_real="$(realpath -e -- "$secrets")"
  case "$secrets_real" in /home/*/*|/root/*) ;; *) die 'Segredos fora da área permitida' 73;; esac
  require_linux_filesystem "$secrets_real" 'O arquivo de segredos'
  mode="$(stat -c %a -- "$secrets_real")"
  test "$mode" = 600 -o "$mode" = 400 || die 'O arquivo de segredos precisa ter modo 600 ou 400' 74
}

compose_for_release() {
  local release="$1" secrets="$2" action="$3"
  shift 3
  assert_release_env "$release" "$(basename -- "$release")"
  assert_regular_file "$release/docker-compose.yml" 'O docker-compose.yml do release'
  env -i PATH="$PATH" HOME="$HOME" LANG="${LANG:-C.UTF-8}" \
    DZ23_FAKE_STATE="${DZ23_FAKE_STATE:-}" DZ23_FAKE_LOG="${DZ23_FAKE_LOG:-}" \
    docker compose --project-name dz23-studio \
    --env-file "$secrets" --env-file "$release/release.env" -f "$release/docker-compose.yml" "$action" "$@"
}

project_containers() {
  local by_label by_name
  by_label="$(docker ps -aq --filter 'label=com.docker.compose.project=dz23-studio')" || return $?
  by_name="$(docker ps -aq --filter 'name=^/dz23-studio-')" || return $?
  printf '%s\n%s\n' "$by_label" "$by_name" | sed '/^$/d' | sort -u
}

project_volumes() {
  local release="$1" secrets="$2" resource expected by_label by_name combined=''
  expected="$(compose_for_release "$release" "$secrets" config --volumes)" || return $?
  by_label="$(docker volume ls -q --filter 'label=com.docker.compose.project=dz23-studio')" || return $?
  while IFS= read -r resource; do
    test -n "$resource" || continue
    by_name="$(docker volume ls -q --filter "name=^dz23-studio_${resource}$")" || return $?
    combined="${combined}${by_name}"$'\n'
  done <<< "$expected"
  printf '%s\n%s' "$by_label" "$combined" | sed '/^$/d' | sort -u
}

project_networks() {
  local release="$1" secrets="$2" resource expected by_label by_name combined=''
  expected="$(compose_for_release "$release" "$secrets" config --networks)" || return $?
  by_label="$(docker network ls -q --filter 'label=com.docker.compose.project=dz23-studio')" || return $?
  while IFS= read -r resource; do
    test -n "$resource" || continue
    by_name="$(docker network ls -q --filter "name=^dz23-studio_${resource}$")" || return $?
    combined="${combined}${by_name}"$'\n'
  done <<< "$expected"
  printf '%s\n%s' "$by_label" "$combined" | sed '/^$/d' | sort -u
}

assert_project_resources_owned() {
  local release="$1" secrets="$2" installation_id containers volumes networks id name actual
  installation_id="$(sed -n 's/^DZ23_INSTALLATION_ID=//p' "$release/release.env")"
  containers="$(project_containers)" || die 'Falha ao inventariar contêineres antes da mutação' 151
  volumes="$(project_volumes "$release" "$secrets")" || die 'Falha ao inventariar volumes antes da mutação' 152
  networks="$(project_networks "$release" "$secrets")" || die 'Falha ao inventariar redes antes da mutação' 153
  while IFS= read -r id; do
    test -n "$id" || continue
    case "$id" in *[!0-9a-f]*) die 'Docker retornou ID de contêiner inválido ao inventariar o projeto' 143;; esac
    test "${#id}" -ge 12 || die 'Docker retornou ID curto ao inventariar o projeto' 143
    actual="$(docker inspect --format '{{index .Config.Labels "com.dz23.studio.installation-id"}}' "$id")" || die 'Falha ao inspecionar contêiner candidato' 154
    test "$actual" = "$installation_id" || die 'Existe um contêiner de projeto homônimo; nenhum runtime foi alterado' 144
  done <<< "$containers"
  while IFS= read -r name; do
    test -n "$name" || continue
    case "$name" in *[!A-Za-z0-9_.-]*) die 'Docker retornou nome de volume inválido ao inventariar o projeto' 145;; esac
    actual="$(docker volume inspect --format '{{index .Labels "com.dz23.studio.installation-id"}}' "$name")" || die 'Falha ao inspecionar volume candidato' 155
    test "$actual" = "$installation_id" || die 'Existe um volume de projeto homônimo; nenhum runtime foi alterado' 146
  done <<< "$volumes"
  while IFS= read -r name; do
    test -n "$name" || continue
    case "$name" in *[!A-Za-z0-9_.-]*) die 'Docker retornou nome de rede inválido ao inventariar o projeto' 147;; esac
    actual="$(docker network inspect --format '{{index .Labels "com.dz23.studio.installation-id"}}' "$name")" || die 'Falha ao inspecionar rede candidata' 156
    test "$actual" = "$installation_id" || die 'Existe uma rede de projeto homônima; nenhum runtime foi alterado' 148
  done <<< "$networks"
}

start_compose_release() {
  local release="$1" secrets="$2"
  assert_project_resources_owned "$release" "$secrets"
  compose_for_release "$release" "$secrets" up -d --no-build --wait --wait-timeout 180 || return $?
  assert_compose_ready "$release" "$secrets"
}

assert_compose_ready() {
  local release="$1" secrets="$2" expected running service installation_id commit compose_sha ids id identity image health state images actual_installation actual_commit actual_compose expected_volumes expected_networks actual_volumes actual_networks resource
  installation_id="$(sed -n 's/^DZ23_INSTALLATION_ID=//p' "$release/release.env")"
  commit="$(sed -n 's/^DZ23_STUDIO_COMMIT=//p' "$release/release.env")"
  compose_sha="$(sed -n 's/^DZ23_COMPOSE_SHA256=//p' "$release/release.env")"
  test "$(sha256sum -- "$release/docker-compose.yml" | awk '{ print $1 }')" = "$compose_sha" || die 'O Compose mudou depois da criação da release' 134
  assert_project_resources_owned "$release" "$secrets"
  expected="$(compose_for_release "$release" "$secrets" config --services)" || die 'Falha ao listar serviços esperados' 157
  test -n "$expected" || die 'O Compose não declarou serviços' 75
  running="$(compose_for_release "$release" "$secrets" ps --status running --services)" || die 'Falha ao listar serviços em execução' 158
  images="$(compose_for_release "$release" "$secrets" config --images)" || die 'Falha ao listar imagens esperadas' 159
  while IFS= read -r service; do
    test -n "$service" || continue
    printf '%s\n' "$running" | grep -Fqx -- "$service" || die "Serviço sem readiness: $service" 76
    ids="$(compose_for_release "$release" "$secrets" ps -q "$service")" || die "Falha ao localizar contêiner de $service" 160
    test "$(printf '%s\n' "$ids" | sed '/^$/d' | wc -l)" -eq 1 || die "Quantidade inesperada de contêineres para $service" 135
    id="$(printf '%s\n' "$ids" | sed -n '1p')"
    case "$id" in *[!0-9a-f]*|'') die "ID inválido para $service" 136;; esac
    test "${#id}" -ge 12 || die "ID curto para $service" 136
    identity="$(docker inspect --format '{{index .Config.Labels "com.dz23.studio.installation-id"}}|{{index .Config.Labels "com.dz23.studio.release-commit"}}|{{index .Config.Labels "com.dz23.studio.compose-sha256"}}|{{.Config.Image}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.State.Status}}' "$id")" || die "Falha ao inspecionar saúde de $service" 161
    IFS='|' read -r actual_installation actual_commit actual_compose image health state <<< "$identity"
    test "$actual_installation" = "$installation_id" || die "Identidade de instalação divergente em $service" 137
    test "$actual_commit" = "$commit" || die "Commit divergente em $service" 138
    test "$actual_compose" = "$compose_sha" || die "Configuração divergente em $service" 139
    printf '%s\n' "$images" | grep -Fqx -- "$image" || die "Imagem divergente em $service: $image" 140
    test "$state" = running || die "Estado inválido em $service: $state" 141
    test "$health" = healthy || die "Serviço sem saúde: $service ($health)" 142
  done <<< "$expected"
  expected_volumes="$(compose_for_release "$release" "$secrets" config --volumes)" || die 'Falha ao listar volumes esperados' 162
  expected_networks="$(compose_for_release "$release" "$secrets" config --networks)" || die 'Falha ao listar redes esperadas' 163
  actual_volumes="$(project_volumes "$release" "$secrets")" || die 'Falha ao confirmar volumes criados' 164
  actual_networks="$(project_networks "$release" "$secrets")" || die 'Falha ao confirmar redes criadas' 165
  while IFS= read -r resource; do
    test -n "$resource" || continue
    printf '%s\n' "$actual_volumes" | grep -Fqx -- "dz23-studio_$resource" || die "Volume obrigatório ausente: $resource" 149
  done <<< "$expected_volumes"
  while IFS= read -r resource; do
    test -n "$resource" || continue
    printf '%s\n' "$actual_networks" | grep -Fqx -- "dz23-studio_$resource" || die "Rede obrigatória ausente: $resource" 150
  done <<< "$expected_networks"
}

assert_compose_images_pinned() {
  local release="$1" secrets="$2" images runtime_image
  images="$(compose_for_release "$release" "$secrets" config --images)"
  test -n "$images" || die 'O Compose não declarou imagens de runtime' 111
  while IFS= read -r runtime_image; do
    test -n "$runtime_image" || continue
    printf '%s\n' "$runtime_image" | grep -Eq '^[a-z0-9][a-z0-9._/-]*(:[a-z0-9][a-z0-9._-]*)?@sha256:[0-9a-f]{64}$' ||
      die "Imagem de runtime não fixada por digest: $runtime_image" 112
  done <<< "$images"
}
'@
}

function Test-Dz23Image {
    param([Parameter(Mandatory)][string]$Image, [Parameter(Mandatory)][string]$Distro, [scriptblock]$CommandInvoker)
    $inspect = Invoke-Dz23Checked -FilePath 'docker.exe' -ArgumentList @('image', 'inspect', '--format', '{{json .RepoDigests}}', $Image) `
        -FailureMessage 'A imagem fixada não está disponível localmente. Baixe-a pelo procedimento auditado antes de instalar' `
        -CommandInvoker $CommandInvoker -TimeoutSeconds 60
    $digest = $Image.Substring($Image.LastIndexOf('@') + 1)
    if ($inspect.StdOut -notmatch [regex]::Escape("@$digest")) {
        throw 'O digest confirmado pelo Docker não corresponde ao digest aprovado.'
    }
    $wslInspect = @'
set -euo pipefail
image="$1"; digest="$2"
docker image inspect --format '{{json .RepoDigests}}' "$image" | grep -Fq "@$digest"
'@
    Invoke-Dz23WslScript -Distro $Distro -Script $wslInspect -Arguments @($Image, $digest) `
        -CommandInvoker $CommandInvoker -FailureMessage 'O Docker usado dentro do WSL2 não confirmou o digest aprovado' `
        -TimeoutSeconds 60 | Out-Null
}

Export-ModuleMember -Function Assert-Dz23Commit, Assert-Dz23ImageDigest, Assert-Dz23LinuxPath, `
    ConvertTo-Dz23ShellLiteral, Invoke-Dz23Native, Invoke-Dz23Checked, Invoke-Dz23WslScript, `
    ConvertTo-Dz23WslSourcePath, Resolve-Dz23InstallRoot, Test-Dz23Prerequisites, Test-Dz23Source, Test-Dz23Image, `
    Get-Dz23WslSafetyPrelude, New-Dz23Result

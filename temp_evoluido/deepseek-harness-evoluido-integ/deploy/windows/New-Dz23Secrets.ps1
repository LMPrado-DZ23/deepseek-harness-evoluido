[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidateSet('local', 'tailscale', 'public')]
    [string]$Profile,
    [string]$Distro = 'Ubuntu',
    [string]$Destination = '',
    [string]$BootstrapOwnerEmail,
    [string]$Hostname,
    [string]$AcmeEmail,
    [switch]$SmtpConfigured,
    [string]$SmtpHost,
    [ValidateRange(1, 65535)]
    [int]$SmtpPort = 465,
    [ValidateSet('implicit-tls')]
    [string]$SmtpTlsMode = 'implicit-tls',
    [string]$SmtpUser,
    [Security.SecureString]$SmtpPassword,
    [string]$SmtpFrom,
    [switch]$ReadSmtpPasswordFromStdin,
    [switch]$AcknowledgeExternalPrerequisites,
    [switch]$Overwrite,
    [switch]$DryRun,
    [switch]$NonInteractive,
    [switch]$TestFailBeforeCommit,
    [ValidateRange(0, 10000)]
    [int]$TestPauseAfterLockMilliseconds = 0,
    [ValidateSet('', 'tmpfs', 'overlay', 'ntfs')]
    [string]$TestFilesystemType = '',
    [string]$TestHomeDirectory = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-ControlFree {
    param([Parameter(Mandatory)][string]$Value, [Parameter(Mandatory)][string]$Name)
    if ($Value.IndexOf([char]0) -ge 0 -or $Value -match '[\x00-\x1f\x7f]') {
        throw "$Name contém caractere de controle."
    }
}

function Assert-RealValue {
    param([Parameter(Mandatory)][string]$Value, [Parameter(Mandatory)][string]$Name)
    Assert-ControlFree -Value $Value -Name $Name
    if ([string]::IsNullOrWhiteSpace($Value)) { throw "$Name é obrigatório." }
    if ($Value -match '(?i)(?:^|[._@/-])(example|exemplo|fake|placeholder|changeme|invalid|teste?|seu-dominio|seu-provedor)(?:$|[._@/-])') {
        throw "$Name contém valor de exemplo ou teste e foi recusado."
    }
}

function Normalize-Email {
    param([Parameter(Mandatory)][string]$Value, [Parameter(Mandatory)][string]$Name)
    Assert-RealValue -Value $Value -Name $Name
    if ($Value -ne $Value.Trim()) { throw "$Name não pode começar ou terminar com espaço." }
    try { $address = [Net.Mail.MailAddress]::new($Value) } catch { throw "$Name não é um e-mail válido." }
    if ($address.Address -cne $Value -or $Value -notmatch '^[^@\s]+@[^@\s]+$') { throw "$Name deve conter somente o endereço de e-mail." }
    $domain = $Value.Substring($Value.LastIndexOf('@') + 1)
    Assert-Hostname -Value $domain -Name "domínio de $Name" -AllowTsNet
    return $Value.ToLowerInvariant()
}

function Assert-Hostname {
    param(
        [Parameter(Mandatory)][string]$Value,
        [Parameter(Mandatory)][string]$Name,
        [switch]$AllowTsNet
    )
    Assert-RealValue -Value $Value -Name $Name
    if ($Value -cne $Value.ToLowerInvariant() -or $Value -ne $Value.TrimEnd('.')) {
        throw "$Name deve estar em minúsculas e sem ponto final."
    }
    if ($Value.Contains('://') -or $Value.Contains('/') -or $Value.Contains(':') -or $Value.Contains('@')) {
        throw "$Name deve ser somente um nome DNS, sem protocolo, porta ou caminho."
    }
    $parsedIp = $null
    if ([Net.IPAddress]::TryParse($Value, [ref]$parsedIp)) { throw "$Name não pode ser um endereço IP." }
    if ($Value.Length -gt 253 -or $Value -notmatch '^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])$') {
        throw "$Name não é um nome DNS completo válido."
    }
    if ($Value -match '(?i)(?:^|\.)(localhost|local|internal|invalid|example|test)$') {
        throw "$Name usa um domínio reservado ou de teste."
    }
    if (-not $AllowTsNet -and $Value.EndsWith('.ts.net', [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Name termina em .ts.net; escolha o perfil tailscale."
    }
}

function Read-RequiredValue {
    param([string]$Current, [string]$Prompt, [string]$ParameterName)
    if (-not [string]::IsNullOrWhiteSpace($Current)) { return $Current }
    if ($NonInteractive) { throw "$ParameterName é obrigatório no modo não interativo." }
    return Read-Host $Prompt
}

function ConvertFrom-SecureValue {
    param([Parameter(Mandatory)][Security.SecureString]$Value)
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

function ConvertTo-Base64Line {
    param([AllowEmptyString()][string]$Value)
    return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Value))
}

function Invoke-WslFirstRun {
    param(
        [Parameter(Mandatory)][string]$LinuxScript,
        [Parameter(Mandatory)][AllowEmptyCollection()][AllowEmptyString()][string[]]$Payload,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Target,
        [Parameter(Mandatory)][bool]$UseDefaultTarget,
        [Parameter(Mandatory)][bool]$Replace,
        [Parameter(Mandatory)][bool]$ValidateOnly,
        [Parameter(Mandatory)][bool]$FailBeforeCommit,
        [Parameter(Mandatory)][int]$PauseAfterLockMilliseconds,
        [Parameter(Mandatory)][AllowEmptyString()][string]$FilesystemTypeOverride,
        [Parameter(Mandatory)][AllowEmptyString()][string]$HomeDirectoryOverride
    )
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = 'wsl.exe'
    $start.UseShellExecute = $false
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($argument in @(
        '--distribution', $Distro, '--exec', '/usr/bin/env', '-i',
        'PATH=/usr/bin:/bin', 'LANG=C.UTF-8',
        '/bin/bash', '--noprofile', '--norc', '-c', $LinuxScript, '--',
        $Target,
        $UseDefaultTarget.ToString().ToLowerInvariant(),
        $Replace.ToString().ToLowerInvariant(),
        $ValidateOnly.ToString().ToLowerInvariant(),
        $FailBeforeCommit.ToString().ToLowerInvariant(),
        $PauseAfterLockMilliseconds.ToString([Globalization.CultureInfo]::InvariantCulture),
        $FilesystemTypeOverride,
        $HomeDirectoryOverride
    )) { [void]$start.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    try {
        if (-not $process.Start()) { throw 'Não foi possível iniciar o WSL2.' }
        $process.StandardInput.NewLine = "`n"
        foreach ($line in $Payload) { $process.StandardInput.WriteLine($line) }
        $process.StandardInput.Close()
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(120000)) {
            try { $process.Kill($true) } catch {}
            throw 'O WSL2 não respondeu dentro de 120 segundos.'
        }
        $stdout = $stdoutTask.GetAwaiter().GetResult()
        $stderr = $stderrTask.GetAwaiter().GetResult()
        if ($stdout.Length -gt 8192 -or $stderr.Length -gt 8192) { throw 'O WSL2 retornou saída maior que o limite seguro.' }
        if ($process.ExitCode -ne 0) {
            $safeError = ($stderr -split "`r?`n" | Where-Object { $_ -match '^M64B_ERROR:' } | Select-Object -First 1)
            if (-not $safeError) { $safeError = 'M64B_ERROR: o WSL2 recusou a operação sem expor detalhes.' }
            throw $safeError
        }
        $resultPath = ($stdout -split "`r?`n" | Where-Object { $_ -match '^M64B_PATH=' } | Select-Object -First 1)
        if (-not $resultPath) { throw 'O WSL2 não confirmou o caminho final.' }
        $confirmedPath = $resultPath.Substring('M64B_PATH='.Length)
        Assert-ControlFree -Value $confirmedPath -Name 'caminho confirmado pelo WSL2'
        if (-not $confirmedPath.StartsWith('/') -or $confirmedPath -match '^/mnt(?:/|$)' -or $confirmedPath -match '(^|/)\.\.(/|$)') {
            throw 'O WSL2 retornou um caminho final inseguro.'
        }
        return $confirmedPath
    }
    finally {
        try { if (-not $process.HasExited) { $process.Kill($true) } } catch {}
        $process.Dispose()
    }
}

if (($TestFailBeforeCommit -or $TestPauseAfterLockMilliseconds -gt 0 -or $TestFilesystemType -or $TestHomeDirectory) -and $env:DZ23_M64B_TEST_MODE -ne '1') {
    throw 'A injeção de falha é exclusiva dos testes.'
}
Assert-ControlFree -Value $Distro -Name 'Distro'
if ($Distro -notmatch '^[A-Za-z0-9._-]{1,80}$') { throw 'Distro possui formato inválido.' }
if ($Destination) {
    Assert-ControlFree -Value $Destination -Name 'Destination'
    if (-not $Destination.StartsWith('/') -or $Destination -match '(^|/)\.\.(/|$)' -or $Destination -match '^/mnt(?:/|$)') {
        throw 'Destination deve ser um caminho Linux absoluto, sem travessia e fora de /mnt/*.'
    }
}
if ($TestHomeDirectory) {
    Assert-ControlFree -Value $TestHomeDirectory -Name 'TestHomeDirectory'
    if (($TestHomeDirectory -notmatch '^/(?:home/[^/]+|root)/[^/]+$') -or $TestHomeDirectory -match '(^|/)\.\.(/|$)') {
        throw 'TestHomeDirectory de teste deve ser um filho direto de /home/<usuário> ou /root e não pode conter travessia.'
    }
}

$Profile = Read-RequiredValue -Current $Profile -Prompt 'Perfil de acesso (local, tailscale ou public)' -ParameterName 'Profile'
if ($Profile -notin @('local', 'tailscale', 'public')) { throw 'Profile deve ser local, tailscale ou public.' }
$BootstrapOwnerEmail = Normalize-Email -Value (Read-RequiredValue -Current $BootstrapOwnerEmail -Prompt 'E-mail da primeira pessoa proprietária' -ParameterName 'BootstrapOwnerEmail') -Name 'BootstrapOwnerEmail'

if ($Profile -eq 'local') {
    if ($Hostname) { throw 'Hostname não deve ser informado no perfil local; o endereço fixo é studio.dz23.localhost:8080.' }
    if ($AcmeEmail) { throw 'AcmeEmail não é usado no perfil local HTTP de loopback.' }
    $publicHost = 'studio.dz23.localhost:8080'
    $publicOrigin = 'http://studio.dz23.localhost:8080'
    $rpId = 'localhost'
    $siteAddress = ''
    $AcmeEmail = ''
    $accessState = 'LOCAL_LOOPBACK_ONLY'
} else {
    $Hostname = (Read-RequiredValue -Current $Hostname -Prompt 'Nome DNS HTTPS, sem protocolo nem porta' -ParameterName 'Hostname').ToLowerInvariant()
    Assert-Hostname -Value $Hostname -Name 'Hostname' -AllowTsNet:($Profile -eq 'tailscale')
    if ($Profile -eq 'tailscale' -and -not $Hostname.EndsWith('.ts.net', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'O perfil tailscale exige o nome HTTPS completo terminado em .ts.net.'
    }
    if (-not $AcknowledgeExternalPrerequisites) {
        throw 'Confirme -AcknowledgeExternalPrerequisites após entender que DNS/HTTPS e, no Tailscale, identidade/ACL ainda precisam ser configurados fora deste assistente.'
    }
    $AcmeEmail = Normalize-Email -Value (Read-RequiredValue -Current $AcmeEmail -Prompt 'E-mail administrativo para certificados' -ParameterName 'AcmeEmail') -Name 'AcmeEmail'
    $publicHost = $Hostname
    $publicOrigin = "https://$Hostname"
    $rpId = $Hostname
    $siteAddress = $Hostname
    $accessState = if ($Profile -eq 'tailscale') { 'TAILSCALE_EXTERNAL_PROOF_REQUIRED' } else { 'PUBLIC_DNS_ACME_PROOF_REQUIRED' }
}

if (-not $SmtpConfigured -and -not $NonInteractive) {
    $smtpAnswer = Read-Host 'Você já possui servidor, usuário, senha e remetente SMTP reais? (sim/não)'
    if ($smtpAnswer -match '^(?i:sim|s|yes|y)$') { $SmtpConfigured = $true }
}
if (-not $SmtpConfigured) {
    throw 'SMTP real é obrigatório no Compose atual. Configure-o; este assistente não cria credencial falsa nem captura e-mail.'
}
$SmtpHost = (Read-RequiredValue -Current $SmtpHost -Prompt 'Servidor SMTP' -ParameterName 'SmtpHost').ToLowerInvariant()
Assert-Hostname -Value $SmtpHost -Name 'SmtpHost' -AllowTsNet
$SmtpUser = Read-RequiredValue -Current $SmtpUser -Prompt 'Usuário SMTP' -ParameterName 'SmtpUser'
Assert-RealValue -Value $SmtpUser -Name 'SmtpUser'
$SmtpFrom = Read-RequiredValue -Current $SmtpFrom -Prompt 'Remetente SMTP (somente e-mail ou Nome <e-mail>)' -ParameterName 'SmtpFrom'
Assert-RealValue -Value $SmtpFrom -Name 'SmtpFrom'
try { $fromAddress = [Net.Mail.MailAddress]::new($SmtpFrom) } catch { throw 'SmtpFrom não é um remetente válido.' }
$fromDomain = $fromAddress.Address.Substring($fromAddress.Address.LastIndexOf('@') + 1).ToLowerInvariant()
Assert-Hostname -Value $fromDomain -Name 'domínio de SmtpFrom' -AllowTsNet

if ($ReadSmtpPasswordFromStdin) {
    if ($SmtpPassword) { throw 'Use SmtpPassword ou ReadSmtpPasswordFromStdin, nunca ambos.' }
    $stdinPassword = [Console]::In.ReadLine()
    if ($null -eq $stdinPassword) { throw 'A senha SMTP não foi recebida pelo stdin.' }
    $SmtpPassword = ConvertTo-SecureString -String $stdinPassword -AsPlainText -Force
} elseif (-not $SmtpPassword) {
    if ($NonInteractive) { throw 'SmtpPassword é obrigatório no modo não interativo; forneça SecureString ou stdin.' }
    $SmtpPassword = Read-Host 'Senha SMTP (entrada oculta)' -AsSecureString
}

$plainPassword = ConvertFrom-SecureValue -Value $SmtpPassword
try {
    Assert-ControlFree -Value $plainPassword -Name 'SmtpPassword'
    if ($plainPassword.Length -lt 12) { throw 'SmtpPassword precisa ter ao menos 12 caracteres.' }
    if ($plainPassword -match '(?i)(example|exemplo|fake|placeholder|changeme|invalid|password|senha|teste?)') {
        throw 'SmtpPassword contém um valor previsível, de teste ou exemplo.'
    }
    $smtpObject = [ordered]@{
        host = $SmtpHost
        port = $SmtpPort
        secure = $true
        user = $SmtpUser
        pass = $plainPassword
        from = $SmtpFrom
    }
    $smtpJson = $smtpObject | ConvertTo-Json -Compress
} finally {
    $plainPassword = $null
}

$linuxScript = @'
set -euo pipefail
umask 077
die() { printf 'M64B_ERROR:%s\n' "$1" >&2; exit "${2:-1}"; }
for required_tool in id getent cut realpath stat findmnt base64 od tr sed mktemp chmod mv sha256sum awk date cp mkdir rmdir dirname basename sleep rm ln; do
  command -v "$required_tool" >/dev/null 2>&1 || die 'a distribuição WSL2 não possui todos os utilitários locais obrigatórios' 19
done
target="${1:-}"; use_default="${2:-false}"; overwrite="${3:-false}"; dry_run="${4:-false}"
fail_before_commit="${5:-false}"; pause_after_lock_ms="${6:-0}"; test_fstype="${7:-}"; test_home="${8:-}"
uid="$(id -u)"; home="$(getent passwd "$uid" | cut -d: -f6)"
if [ -n "$test_home" ]; then home="$test_home"; fi
test -n "$home" && test -d "$home" && test ! -L "$home" || die 'a pasta pessoal Linux não é um diretório real' 20
home="$(realpath -e -- "$home")"
case "$home" in /home/*|/root) ;; *) die 'a pasta pessoal Linux fica fora de /home ou /root' 21;; esac
test "$(stat -c %u -- "$home")" = "$uid" || die 'a pasta pessoal Linux pertence a outro usuário' 29
filesystem_type() {
  if [ -n "$test_fstype" ]; then printf '%s\n' "$test_fstype"; else findmnt -n -o FSTYPE -T "$1"; fi
}
assert_ext_filesystem() {
  local checked_fstype
  checked_fstype="$(filesystem_type "$1")"
  case "$checked_fstype" in ext2|ext3|ext4) ;; *) die 'o destino não está em filesystem Linux ext2/ext3/ext4' 30;; esac
}
assert_ext_filesystem "$home"
if [ "$use_default" = true ]; then
  test -z "$target" || die 'o destino padrão e um destino explícito não podem ser usados juntos' 22
  target="$home/.config/dz23-studio/secrets.env"
else
  test -n "$target" || die 'o destino explícito está vazio' 22
fi
case "$target" in /*) ;; *) die 'o destino não é absoluto' 22;; esac
case "/$target/" in */../*|*/./*) die 'o destino contém travessia' 23;; esac
case "$target" in /mnt|/mnt/*) die 'o destino não pode ficar em /mnt/* ou NTFS' 24;; esac
case "$target" in "$home"/*) ;; *) die 'o destino precisa ficar dentro da pasta pessoal da distribuição WSL2' 25;; esac
test "$(basename -- "$target")" = 'secrets.env' || die 'o arquivo final precisa se chamar secrets.env' 26
parent="$(dirname -- "$target")"
assert_parent() {
  test -d "$parent" && test ! -L "$parent" || die 'o diretório de configuração não pode ser link ou objeto especial' 31
  test "$(realpath -e -- "$parent")" = "$parent" || die 'o diretório de configuração escapou do caminho esperado' 32
  case "$parent" in "$home"/*) ;; *) die 'o diretório de configuração escapou da pasta pessoal' 32;; esac
  test "$(stat -c %u -- "$parent")" = "$uid" || die 'o diretório de configuração pertence a outro usuário' 33
  test "$(stat -c %a -- "$parent")" = 700 || die 'o diretório de configuração precisa ter modo 0700' 34
  assert_ext_filesystem "$parent"
}
if [ "$use_default" = true ]; then
  config_root="$home/.config"
  if [ -e "$config_root" ] || [ -L "$config_root" ]; then
    test -d "$config_root" && test ! -L "$config_root" || die 'a pasta .config não pode ser link ou objeto especial' 27
    test "$(realpath -e -- "$config_root")" = "$config_root" || die 'a pasta .config escapou da pasta pessoal' 28
    test "$(stat -c %u -- "$config_root")" = "$uid" || die 'a pasta .config pertence a outro usuário' 29
    config_mode="$(stat -c %a -- "$config_root")"
    test $((8#$config_mode & 8#022)) -eq 0 || die 'a pasta .config não pode permitir escrita de grupo ou outros usuários' 34
    assert_ext_filesystem "$config_root"
  elif [ "$dry_run" != true ]; then
    mkdir -m 700 -- "$config_root" || die 'não foi possível criar a pasta .config com segurança' 27
    test -d "$config_root" && test ! -L "$config_root" && test "$(stat -c %u -- "$config_root")" = "$uid" && test "$(stat -c %a -- "$config_root")" = 700 || die 'a pasta .config criada não passou na verificação' 27
    assert_ext_filesystem "$config_root"
  fi
  if [ ! -e "$parent" ] && [ ! -L "$parent" ] && [ "$dry_run" != true ]; then
    mkdir -m 700 -- "$parent" || die 'não foi possível criar o diretório de configuração com segurança' 31
  fi
else
  test -d "$parent" && test ! -L "$parent" || die 'o diretório pai de um Destination personalizado precisa existir e não pode ser link' 31
fi
if [ "$dry_run" = true ] && [ "$use_default" = true ] && [ ! -e "$parent" ] && [ ! -L "$parent" ]; then
  printf 'M64B_PATH=%s\n' "$target"
  exit 0
fi
assert_parent
validate_existing_target() {
  if [ -e "$target" ] || [ -L "$target" ]; then
    test -f "$target" && test ! -L "$target" || die 'o destino existente não pode ser link ou objeto especial' 35
    test "$(realpath -e -- "$target")" = "$target" || die 'o destino existente escapou do diretório seguro' 36
    test "$(stat -c %u -- "$target")" = "$uid" || die 'o destino existente pertence a outro usuário' 37
    test "$(stat -c %h -- "$target")" = 1 || die 'o destino existente não pode ser hardlink' 38
    mode="$(stat -c %a -- "$target")"; test "$mode" = 600 -o "$mode" = 400 || die 'o destino existente precisa ter modo 0600 ou 0400' 39
    test "$overwrite" = true || die 'o destino já existe; use -Overwrite para criar backup e substituir' 40
  fi
}
validate_existing_target
payload=()
for expected in 1 2 3 4 5 6 7 8 9 10 11; do
  IFS= read -r encoded || die 'payload incompleto' 41
  case "$encoded" in *[!A-Za-z0-9+/=]*) die 'payload inválido' 42;; esac
  decoded="$(printf '%s' "$encoded" | base64 -d)" || die 'payload inválido' 42
  case "$decoded" in *$'\n'*|*$'\r'*) die 'payload contém quebra de linha' 43;; esac
  payload+=("$decoded")
done
test "$dry_run" != true || { printf 'M64B_PATH=%s\n' "$target"; exit 0; }
parent_identity="$(stat -c '%d:%i' -- "$parent")"
lock="$parent/.secrets.env.lock"
( set -o noclobber; mkdir -m 700 -- "$lock" ) 2>/dev/null || die 'outra instância oficial já está preparando este destino' 50
lock_identity="$(stat -c '%d:%i' -- "$lock")"
temp=''; backup_temp=''
release_lock() {
  if [ -n "${lock_identity:-}" ] && [ -d "$lock" ] && [ ! -L "$lock" ] && [ "$(stat -c %u -- "$lock")" = "$uid" ] && [ "$(stat -c %a -- "$lock")" = 700 ] && [ "$(stat -c '%d:%i' -- "$lock")" = "$lock_identity" ]; then
    rmdir -- "$lock" 2>/dev/null || true
  fi
  lock_identity=''
}
cleanup() {
  if [ -n "${temp:-}" ]; then rm -f -- "$temp"; fi
  if [ -n "${backup_temp:-}" ]; then rm -f -- "$backup_temp"; fi
  release_lock
}
trap cleanup EXIT HUP INT TERM
assert_parent_identity() {
  assert_parent
  test "$(stat -c '%d:%i' -- "$parent")" = "$parent_identity" || die 'o diretório pai foi trocado durante a operação' 51
  test -d "$lock" && test ! -L "$lock" && test "$(stat -c %u -- "$lock")" = "$uid" && test "$(stat -c %a -- "$lock")" = 700 && test "$(stat -c '%d:%i' -- "$lock")" = "$lock_identity" || die 'o lock da operação foi trocado' 52
}
assert_parent_identity
target_existed=false; target_identity=''; target_digest=''
if [ -e "$target" ] || [ -L "$target" ]; then
  validate_existing_target
  target_existed=true
  target_identity="$(stat -c '%d:%i' -- "$target")"
  target_digest="$(sha256sum -- "$target" | awk '{print $1}')"
fi
assert_target_unchanged() {
  if [ "$target_existed" = true ]; then
    test -f "$target" && test ! -L "$target" && test "$(stat -c %h -- "$target")" = 1 || die 'o destino foi trocado durante a operação' 53
    test "$(stat -c '%d:%i' -- "$target")" = "$target_identity" || die 'o destino foi trocado durante a operação' 53
    test "$(sha256sum -- "$target" | awk '{print $1}')" = "$target_digest" || die 'o conteúdo do destino mudou durante a operação' 54
  else
    test ! -e "$target" && test ! -L "$target" || die 'um destino apareceu durante a operação' 53
  fi
}
if [ "$pause_after_lock_ms" -gt 0 ]; then
  pause_seconds="$((pause_after_lock_ms / 1000)).$(printf '%03d' "$((pause_after_lock_ms % 1000))")"
  sleep "$pause_seconds"
fi
edge_secret="$(od -An -N48 -tx1 /dev/urandom | tr -d ' \n')"
postgres_password="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
test "${#edge_secret}" -eq 96 && case "$edge_secret" in *[!0-9a-f]*) false;; *) true;; esac || die 'falha ao gerar segredo da borda' 44
test "${#postgres_password}" -eq 64 && case "$postgres_password" in *[!0-9a-f]*) false;; *) true;; esac || die 'falha ao gerar senha PostgreSQL' 45
postgres_dsn="postgresql://dz23_studio:${postgres_password}@postgres:5432/dz23_studio"
escape_env() { printf '%s' "$1" | sed "s/'/\\\\'/g"; }
pair() { printf "%s='%s'\n" "$1" "$(escape_env "$2")"; }
assert_parent_identity
assert_target_unchanged
temp="$(mktemp "$parent/.secrets.env.tmp.XXXXXX")"
{
  printf '# Gerado pelo DZ23 STUDIO. Não compartilhe este arquivo.\n'
  pair DZ23_ACCESS_PROFILE "${payload[0]}"
  pair DZ23_EDGE_SECRET "$edge_secret"
  pair DZ23_PUBLIC_HOST "${payload[2]}"
  pair DZ23_PUBLIC_ORIGIN "${payload[3]}"
  pair DZ23_RP_ID "${payload[4]}"
  pair DZ23_BOOTSTRAP_OWNER_EMAIL "${payload[1]}"
  pair DZ23_SMTP_SECRET "${payload[7]}"
  pair DZ23_POSTGRES_PASSWORD "$postgres_password"
  pair DZ23_POSTGRES_DSN "$postgres_dsn"
  if [ -n "${payload[5]}" ]; then pair DZ23_SITE_ADDRESS "${payload[5]}"; fi
  if [ -n "${payload[6]}" ]; then pair DZ23_ACME_EMAIL "${payload[6]}"; fi
  pair DZ23_HTTP_PORT "${payload[8]}"
  pair DZ23_HTTPS_PORT "${payload[9]}"
  pair DZ23_POSTGRES_BACKUP_INTERVAL_MINUTES 60
  pair DZ23_POSTGRES_BACKUP_KEEP 48
} > "$temp"
chmod 600 -- "$temp"
test "$(stat -c %a -- "$temp")" = 600 && test "$(stat -c %h -- "$temp")" = 1 || die 'arquivo temporário inseguro' 46
if [ "$fail_before_commit" = true ]; then die 'falha de teste antes do commit atômico' 99; fi
assert_parent_identity
assert_target_unchanged
if [ "$target_existed" = true ]; then
  backup="$target.backup.$(date -u +%Y%m%dT%H%M%SZ).$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
  backup_temp="$(mktemp "$parent/.secrets.env.backup.tmp.XXXXXX")"
  chmod 600 -- "$backup_temp"
  cp --no-dereference --reflink=never -- "$target" "$backup_temp"
  test "$(sha256sum -- "$backup_temp" | awk '{print $1}')" = "$target_digest" || die 'backup não corresponde à versão travada do arquivo anterior' 48
  ln -- "$backup_temp" "$backup" 2>/dev/null || die 'não foi possível reservar backup exclusivo' 47
  rm -f -- "$backup_temp"
  backup_temp=''
fi
assert_parent_identity
assert_target_unchanged
mv -Tf -- "$temp" "$target"
temp=''
release_lock
trap - EXIT HUP INT TERM
test -f "$target" && test ! -L "$target" && test "$(stat -c %a -- "$target")" = 600 && test "$(stat -c %h -- "$target")" = 1 || die 'arquivo final não passou na verificação' 49
printf 'M64B_PATH=%s\n' "$target"
'@

$payload = @(
    (ConvertTo-Base64Line $Profile),
    (ConvertTo-Base64Line $BootstrapOwnerEmail),
    (ConvertTo-Base64Line $publicHost),
    (ConvertTo-Base64Line $publicOrigin),
    (ConvertTo-Base64Line $rpId),
    (ConvertTo-Base64Line $siteAddress),
    (ConvertTo-Base64Line $AcmeEmail),
    (ConvertTo-Base64Line $smtpJson),
    (ConvertTo-Base64Line $(if ($Profile -eq 'local') { '8080' } else { '80' })),
    (ConvertTo-Base64Line $(if ($Profile -eq 'local') { '8443' } else { '443' })),
    (ConvertTo-Base64Line $accessState)
)

$verb = if ($DryRun) { 'Validar o primeiro acesso sem gerar ou gravar segredos' } else { 'Criar o arquivo seguro de primeiro acesso' }
if ($PSCmdlet.ShouldProcess("$Distro`:$Destination", $verb)) {
    $useDefaultDestination = [string]::IsNullOrEmpty($Destination)
    $finalPath = Invoke-WslFirstRun -LinuxScript $linuxScript -Payload $payload -Target $Destination `
        -UseDefaultTarget $useDefaultDestination -Replace $Overwrite.IsPresent -ValidateOnly $DryRun.IsPresent `
        -FailBeforeCommit $TestFailBeforeCommit.IsPresent -PauseAfterLockMilliseconds $TestPauseAfterLockMilliseconds `
        -FilesystemTypeOverride $TestFilesystemType -HomeDirectoryOverride $TestHomeDirectory
    Write-Output "DZ23_FIRST_RUN=$(if ($DryRun) { 'DRY_RUN_VALID' } else { 'PREPARED' })"
    Write-Output "PROFILE=$Profile"
    Write-Output "DESTINATION=$finalPath"
    Write-Output "ACCESS=$accessState"
    Write-Output "PUBLIC_HOST=$publicHost"
    Write-Output "PUBLIC_ORIGIN=$publicOrigin"
    Write-Output "RP_ID=$rpId"
    Write-Output 'SMTP=[CONFIGURADO_NAO_TESTADO]'
    Write-Output "DZ23_EDGE_SECRET=$(if ($DryRun) { '[NAO_GERADO]' } else { '[CONFIGURADO]' })"
    Write-Output "DZ23_POSTGRES_PASSWORD=$(if ($DryRun) { '[NAO_GERADO]' } else { '[CONFIGURADO]' })"
    if ($Profile -eq 'tailscale') {
        Write-Output 'PENDENCIA=Tailscale, identidade, ACL e HTTPS precisam ser configurados e provados fora deste assistente.'
    } elseif ($Profile -eq 'public') {
        Write-Output 'PENDENCIA=DNS, portas, firewall e emissão ACME precisam ser configurados e provados fora deste assistente.'
    } else {
        Write-Output 'LIMITE=Acesso somente neste computador; não use Basic Auth como única proteção pública.'
    }
} else {
    Write-Output 'DZ23_FIRST_RUN=WHAT_IF'
    Write-Output 'Nenhum segredo foi gerado e nenhum arquivo foi criado.'
}

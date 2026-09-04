Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function New-Dz23Result {
    param([int]$ExitCode, [string]$StdOut = '', [string]$StdErr = '')
    [pscustomobject]@{ ExitCode = $ExitCode; StdOut = $StdOut; StdErr = $StdErr }
}

function Invoke-Dz23Native {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [scriptblock]$CommandInvoker
    )
    if ($CommandInvoker) {
        return & $CommandInvoker $FilePath $ArgumentList
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
        $process.WaitForExit()
        New-Dz23Result -ExitCode $process.ExitCode -StdOut $stdout.GetAwaiter().GetResult() -StdErr $stderr.GetAwaiter().GetResult()
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
        [scriptblock]$CommandInvoker
    )
    $result = Invoke-Dz23Native -FilePath $FilePath -ArgumentList $ArgumentList -CommandInvoker $CommandInvoker
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
        -CommandInvoker $CommandInvoker
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
        [string]$FailureMessage = 'O comando no WSL2 falhou'
    )
    if ($Distro -notmatch '^[A-Za-z0-9._-]{1,80}$') { throw 'Nome de distribuição WSL inválido.' }
    $normalizedScript = $Script.Replace("`r`n", "`n").Replace("`r", "`n")
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($normalizedScript))
    $shell = "printf %s $(ConvertTo-Dz23ShellLiteral $encoded) | base64 -d | bash -s --"
    foreach ($argument in $Arguments) { $shell += ' ' + (ConvertTo-Dz23ShellLiteral $argument) }
    Invoke-Dz23Checked -FilePath 'wsl.exe' -ArgumentList @('-d', $Distro, '--exec', 'bash', '-lc', $shell) `
        -FailureMessage $FailureMessage -CommandInvoker $CommandInvoker
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
test "$(stat -f -c %T /home)" != '9p'
command -v git >/dev/null
command -v docker >/dev/null
test "$(docker info --format '{{.OSType}}')" = 'linux'
'@
    Invoke-Dz23WslScript -Distro $Distro -Script $wslProbe -CommandInvoker $CommandInvoker `
        -FailureMessage 'A distribuição escolhida não está pronta como WSL2 com /home em disco Linux, Git e Docker' | Out-Null
    $docker = Invoke-Dz23Checked -FilePath 'docker.exe' -ArgumentList @('info', '--format', '{{.OSType}}') `
        -FailureMessage 'O Docker Desktop não está disponível' -CommandInvoker $CommandInvoker
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
        -FailureMessage 'Não foi possível confirmar o commit da origem' -CommandInvoker $CommandInvoker
    if ($head.StdOut.Trim() -cne $ExpectedCommit) { throw 'O commit da origem não corresponde ao commit esperado. Instalação interrompida.' }
    $dirty = Invoke-Dz23Checked -FilePath 'git.exe' -ArgumentList @('-C', $resolved, 'status', '--porcelain=v1', '--untracked-files=no') `
        -FailureMessage 'Não foi possível confirmar a integridade da origem' -CommandInvoker $CommandInvoker
    if (-not [string]::IsNullOrWhiteSpace($dirty.StdOut)) { throw 'A origem possui alterações rastreadas. Use um checkout limpo e auditado.' }
    $resolved
}

function Test-Dz23Image {
    param([Parameter(Mandatory)][string]$Image, [Parameter(Mandatory)][string]$Distro, [scriptblock]$CommandInvoker)
    $inspect = Invoke-Dz23Checked -FilePath 'docker.exe' -ArgumentList @('image', 'inspect', '--format', '{{json .RepoDigests}}', $Image) `
        -FailureMessage 'A imagem fixada não está disponível localmente. Baixe-a pelo procedimento auditado antes de instalar' `
        -CommandInvoker $CommandInvoker
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
        -CommandInvoker $CommandInvoker -FailureMessage 'O Docker usado dentro do WSL2 não confirmou o digest aprovado' | Out-Null
}

Export-ModuleMember -Function Assert-Dz23Commit, Assert-Dz23ImageDigest, Assert-Dz23LinuxPath, `
    ConvertTo-Dz23ShellLiteral, Invoke-Dz23Native, Invoke-Dz23Checked, Invoke-Dz23WslScript, `
    Resolve-Dz23InstallRoot, Test-Dz23Prerequisites, Test-Dz23Source, Test-Dz23Image, New-Dz23Result

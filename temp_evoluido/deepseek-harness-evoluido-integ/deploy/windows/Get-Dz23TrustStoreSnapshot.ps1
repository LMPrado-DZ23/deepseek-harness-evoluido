[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$OutputPath,
    [string]$Distro = 'Ubuntu'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function ConvertTo-LowerHex {
    param([Parameter(Mandatory)][byte[]]$Bytes)
    [Convert]::ToHexString($Bytes).ToLowerInvariant()
}

function ConvertFrom-Base64Text {
    param([Parameter(Mandatory)][string]$Value)
    [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Value))
}

function Test-IsElevated {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-WindowsCertificateInventory {
    $items = [Collections.Generic.List[object]]::new()
    foreach ($location in @('CurrentUser', 'LocalMachine')) {
        foreach ($store in @('Root', 'CA')) {
            $certificates = @(Get-ChildItem -LiteralPath "Cert:\$location\$store" -ErrorAction Stop)
            foreach ($certificate in $certificates) {
                $sha256 = [Security.Cryptography.SHA256]::HashData($certificate.RawData)
                $items.Add([pscustomobject][ordered]@{
                    location = $location
                    store = $store
                    thumbprint_sha1 = $certificate.Thumbprint.ToLowerInvariant()
                    certificate_sha256 = ConvertTo-LowerHex $sha256
                })
            }
        }
    }
    @($items | Sort-Object location, store, thumbprint_sha1, certificate_sha256)
}

function Get-WslCertificateInventory {
    param([Parameter(Mandatory)][string]$Distribution)

    if ($Distribution -notmatch '^[A-Za-z0-9._-]{1,64}$') {
        throw 'O nome da distribuição WSL contém caracteres não permitidos.'
    }

    $probe = @'
set -euo pipefail
roots=(/etc/ssl/certs /usr/local/share/ca-certificates /usr/share/ca-certificates)
encode() { printf '%s' "$1" | base64 -w0; }
for root in "${roots[@]}"; do
  if [ ! -e "$root" ] && [ ! -L "$root" ]; then
    printf 'ROOT\t%s\tabsent\n' "$(encode "$root")"
    continue
  fi
  if [ ! -d "$root" ] || [ -L "$root" ]; then
    printf 'ROOT\t%s\tother\n' "$(encode "$root")"
    continue
  fi
  printf 'ROOT\t%s\tdirectory\n' "$(encode "$root")"
  while IFS= read -r -d '' path; do
    if [ -L "$path" ]; then
      target="$(readlink -- "$path")"
      printf 'ENTRY\t%s\tsymlink\t-\t%s\n' "$(encode "$path")" "$(encode "$target")"
    elif [ -f "$path" ]; then
      digest="$(sha256sum -- "$path" | awk '{print $1}')"
      size="$(stat -c '%s' -- "$path")"
      printf 'ENTRY\t%s\tfile\t%s\t%s\n' "$(encode "$path")" "$digest" "$size"
    fi
  done < <(find "$root" -xdev \( -type f -o -type l \) -print0 | sort -z)
done
'@

    $lines = @(& wsl.exe -d $Distribution --exec /usr/bin/env -i PATH=/usr/bin:/bin LANG=C.UTF-8 `
        /bin/bash --noprofile --norc -c $probe 2>$null)
    if ($LASTEXITCODE -ne 0) {
        throw 'Não foi possível inventariar os certificados da distribuição WSL2.'
    }

    $roots = [Collections.Generic.List[object]]::new()
    $entries = [Collections.Generic.List[object]]::new()
    foreach ($line in $lines) {
        $parts = $line -split "`t", 5
        if ($parts.Count -eq 3 -and $parts[0] -eq 'ROOT') {
            $roots.Add([pscustomobject][ordered]@{
                path = ConvertFrom-Base64Text $parts[1]
                kind = $parts[2]
            })
            continue
        }
        if ($parts.Count -eq 5 -and $parts[0] -eq 'ENTRY') {
            $path = ConvertFrom-Base64Text $parts[1]
            if ($parts[2] -eq 'file') {
                if ($parts[3] -notmatch '^[0-9a-f]{64}$' -or $parts[4] -notmatch '^\d+$') {
                    throw 'A sonda WSL2 retornou metadados de certificado inválidos.'
                }
                $entries.Add([pscustomobject][ordered]@{
                    path = $path
                    kind = 'file'
                    sha256 = $parts[3]
                    size = [long]$parts[4]
                    target = $null
                })
            } elseif ($parts[2] -eq 'symlink' -and $parts[3] -eq '-') {
                $entries.Add([pscustomobject][ordered]@{
                    path = $path
                    kind = 'symlink'
                    sha256 = $null
                    size = $null
                    target = ConvertFrom-Base64Text $parts[4]
                })
            } else {
                throw 'A sonda WSL2 retornou um tipo de entrada desconhecido.'
            }
            continue
        }
        throw 'A sonda WSL2 retornou uma linha que não pertence ao protocolo esperado.'
    }

    if ($roots.Count -ne 3) {
        throw 'A sonda WSL2 não confirmou todos os diretórios de certificados esperados.'
    }

    [pscustomobject][ordered]@{
        distro = $Distribution
        roots = @($roots | Sort-Object path)
        entries = @($entries | Sort-Object path, kind, sha256, target)
    }
}

$fullOutputPath = [IO.Path]::GetFullPath($OutputPath)
if (Test-Path -LiteralPath $fullOutputPath) {
    throw 'O arquivo de evidência já existe; escolha outro caminho para não sobrescrever uma prova anterior.'
}
$parent = Split-Path -Parent $fullOutputPath
if ([string]::IsNullOrWhiteSpace($parent)) {
    throw 'O caminho de saída precisa ter um diretório pai explícito.'
}
[IO.Directory]::CreateDirectory($parent) | Out-Null

$snapshot = [pscustomobject][ordered]@{
    schema_version = 1
    captured_at_utc = [DateTimeOffset]::UtcNow.ToString('o')
    host = [pscustomobject][ordered]@{
        platform = 'windows'
        os_version = [Environment]::OSVersion.VersionString
        powershell_version = $PSVersionTable.PSVersion.ToString()
    }
    windows = [pscustomobject][ordered]@{
        stores = @('CurrentUser/Root', 'CurrentUser/CA', 'LocalMachine/Root', 'LocalMachine/CA')
        certificates = @(Get-WindowsCertificateInventory)
    }
    wsl = Get-WslCertificateInventory -Distribution $Distro
    safety = [pscustomobject][ordered]@{
        read_only = $true
        trust_store_modified = $false
        network_contacted = $false
        elevated = Test-IsElevated
    }
}

$temporaryPath = "$fullOutputPath.$([Guid]::NewGuid().ToString('N')).tmp"
try {
    $json = $snapshot | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText($temporaryPath, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporaryPath -Destination $fullOutputPath -ErrorAction Stop
} finally {
    if (Test-Path -LiteralPath $temporaryPath) {
        Remove-Item -LiteralPath $temporaryPath -Force
    }
}

Write-Output ([pscustomobject][ordered]@{
    state = 'PASS'
    output_path = $fullOutputPath
    windows_certificates = $snapshot.windows.certificates.Count
    wsl_entries = $snapshot.wsl.entries.Count
    trust_store_modified = $false
} | ConvertTo-Json -Compress)

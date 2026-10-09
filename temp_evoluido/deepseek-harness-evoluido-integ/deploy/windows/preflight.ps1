[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Distro,
    [ValidateSet('local', 'tailscale', 'public')][string]$Profile = 'local',
    [string]$Hostname = '',
    [string]$Origin = '',
    [string]$RpId = '',
    [ValidateRange(1, 65535)][int[]]$Ports = @(),
    [string]$SourcePath = '',
    [ValidateSet('Human', 'Json', 'Both')][string]$OutputFormat = 'Both'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'Dz23.Windows.psm1') -Force

try {
    $report = Invoke-Dz23WindowsPreflight -Distro $Distro -Profile $Profile -Hostname $Hostname `
        -Origin $Origin -RpId $RpId -Ports $Ports -SourcePath $SourcePath
} catch {
    # Não replique mensagens de exceção: ferramentas do host podem incluir caminho,
    # ambiente ou credencial em seus erros.
    $report = [pscustomobject][ordered]@{
        schema_version = 1
        overall_state = 'BLOCKED'
        exit_code = 2
        profile = $Profile
        checks = @([pscustomobject][ordered]@{
            id = 'preflight.internal'
            state = 'BLOCKED'
            summary = 'O diagnóstico não conseguiu concluir uma verificação segura.'
            remediation = 'Revise os pré-requisitos indicados e execute novamente em PowerShell 7.'
            details = [pscustomobject]@{}
        })
        safety = [pscustomobject][ordered]@{
            read_only = $true
            elevated = $false
            services_started = $false
            endpoint_contacted = $false
            dns_queried = $false
            local_docker_daemon_queried = $false
        }
    }
}

if ($OutputFormat -in @('Human', 'Both')) {
    Write-Output 'DZ23 STUDIO — diagnóstico somente leitura'
    foreach ($check in $report.checks) {
        Write-Output ("[{0}] {1}" -f $check.state, $check.summary)
        if ($check.state -ne 'PASS') { Write-Output ("      Como resolver: {0}" -f $check.remediation) }
    }
    Write-Output ("Resultado: {0}" -f $report.overall_state)
}
if ($OutputFormat -in @('Json', 'Both')) {
    $json = $report | ConvertTo-Json -Depth 8 -Compress
    if ($OutputFormat -eq 'Both') { Write-Output "DZ23_PREFLIGHT_JSON=$json" } else { Write-Output $json }
}
exit $report.exit_code

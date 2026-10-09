param([Parameter(Mandatory)][string]$PidDirectory)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

[IO.Directory]::CreateDirectory($PidDirectory) | Out-Null
$childPidPath = Join-Path $PidDirectory 'child.pid'
$env:DZ23_TIMEOUT_CHILD_PID = $childPidPath
$childSource = @'
[IO.File]::WriteAllText($env:DZ23_TIMEOUT_CHILD_PID, [string]$PID)
Start-Sleep -Seconds 300
'@
$encodedChild = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($childSource))
$currentPwsh = (Get-Process -Id $PID).Path
$child = Start-Process -FilePath $currentPwsh `
    -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', $encodedChild) `
    -WindowStyle Hidden -PassThru
[IO.File]::WriteAllText($childPidPath, [string]$child.Id)
[IO.File]::WriteAllText((Join-Path $PidDirectory 'parent.pid'), [string]$PID)
[Console]::Error.WriteLine($env:DZ23_TIMEOUT_SECRET)
Start-Sleep -Seconds 300

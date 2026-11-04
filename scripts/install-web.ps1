$ErrorActionPreference='Stop'
$taskRoot=Split-Path -Parent $PSScriptRoot
$taskUser=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$node=(Get-Command node.exe -ErrorAction Stop).Source
$server=Join-Path $taskRoot 'src/server.mjs'
$diagnostics=Join-Path $PSScriptRoot 'web-diagnostics.cjs'
$action=New-ScheduledTaskAction -Execute $node -Argument "--require `"$diagnostics`" `"$server`"" -WorkingDirectory $taskRoot
$trigger=New-ScheduledTaskTrigger -AtLogOn -User $taskUser
$principal=New-ScheduledTaskPrincipal -UserId $taskUser -LogonType Interactive
$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
if(Get-ScheduledTask -TaskName 'FamilienWeb' -ErrorAction SilentlyContinue){throw 'FamilienWeb already exists. Inspect the existing installation before changing it.'}
Register-ScheduledTask -TaskName 'FamilienWeb' -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
Start-ScheduledTask -TaskName 'FamilienWeb'

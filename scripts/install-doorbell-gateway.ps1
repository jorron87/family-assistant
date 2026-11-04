$ErrorActionPreference='Stop'
$taskName='FamilienDoorbell'
$taskScript=Join-Path $PSScriptRoot 'doorbell-worker.ps1'
$taskUser=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$taskAction=New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe') -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$taskScript+'"') -WorkingDirectory (Split-Path -Parent $PSScriptRoot)
$taskTrigger=New-ScheduledTaskTrigger -AtLogOn -User $taskUser
$taskRecovery=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$taskPrincipal=New-ScheduledTaskPrincipal -UserId $taskUser -LogonType Interactive
$taskSettings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger @($taskTrigger,$taskRecovery) -Principal $taskPrincipal -Settings $taskSettings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName

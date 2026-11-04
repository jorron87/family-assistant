param([int]$DashboardPort=15319, [string]$SshHost='dashboard')
$taskUser=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$taskName = 'FamilienDashboardTunnel'
$sshPath = (Get-Command ssh.exe).Source
$taskAction = New-ScheduledTaskAction -Execute $sshPath -Argument "-N -T -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -R 127.0.0.1:4318:127.0.0.1:$DashboardPort $SshHost"
$taskTrigger = New-ScheduledTaskTrigger -AtLogOn -User $taskUser
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $taskUser -LogonType Interactive
$taskSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $taskTrigger -Principal $taskPrincipal -Settings $taskSettings -Force | Out-Null
& (Join-Path $PSScriptRoot 'enable-dashboard-recovery.ps1')
Start-ScheduledTask -TaskName $taskName

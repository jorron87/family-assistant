$ErrorActionPreference = 'Stop'
$task = Get-ScheduledTask -TaskName 'FamilienDashboardTunnel'
if ($task.Principal.UserId -ne [System.Security.Principal.WindowsIdentity]::GetCurrent().Name) {throw 'Run under the account owning this task.'}
if ([string]$task.State -eq 'Disabled') {throw 'Tunnelen er deaktivert; ingen automatisk aktivering.'}
# Repair triggers only: keep the live SSH process, account and forwarding action.
$logon = @($task.Triggers | Where-Object {$_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger'})
$recovery = New-ScheduledTaskTrigger -Daily -At '00:00'
$recovery.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 1)).Repetition
$recovery.Repetition.StopAtDurationEnd = $false
$settings = $task.Settings
$settings.MultipleInstances = 2 # IgnoreNew: never interrupt a healthy connection.
$null = Set-ScheduledTask -TaskName $task.TaskName -Trigger (@($logon)+@($recovery)) -Settings $settings
$updated = Get-ScheduledTask -TaskName $task.TaskName
[pscustomobject]@{task=$updated.TaskName;state=[string]$updated.State;account=$updated.Principal.UserId;recoveryInterval=$updated.Triggers[-1].Repetition.Interval;stopAtDurationEnd=$updated.Triggers[-1].Repetition.StopAtDurationEnd} | ConvertTo-Json -Compress

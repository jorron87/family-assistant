$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$task = Get-ScheduledTask -TaskName 'FamilienWeb'
if ($task.Principal.UserId -ne [System.Security.Principal.WindowsIdentity]::GetCurrent().Name) {throw 'Run under the account owning this task.'}
if ([string]$task.State -eq 'Disabled') {throw 'Tjenesten er deaktivert; ingen automatisk aktivering.'}
$diagnostics = Join-Path $PSScriptRoot 'web-diagnostics.cjs'
$server = Join-Path $taskRoot 'src/server.mjs'
& 'C:\Program Files\nodejs\node.exe' --check $diagnostics
if ($LASTEXITCODE -ne 0) {throw 'Feillogger har syntaksfeil.'}
# Preserve the existing task/account/settings. Repeated start attempts are ignored
# while it runs. This restores a stopped service, never interrupts a live agent.
$logon = @($task.Triggers | Where-Object {$_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger'})
$recovery = New-ScheduledTaskTrigger -Daily -At '00:00'
$recovery.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 1)).Repetition
$recovery.Repetition.StopAtDurationEnd = $false # A day's trigger window must never stop the server at midnight.
$action = New-ScheduledTaskAction -Execute 'C:\Program Files\nodejs\node.exe' -Argument "--require `"$diagnostics`" `"$server`"" -WorkingDirectory $taskRoot
$settings = $task.Settings
$settings.MultipleInstances = 2 # IgnoreNew: no parallel web services.
$null = Set-ScheduledTask -TaskName 'FamilienWeb' -Action $action -Trigger (@($logon)+@($recovery)) -Settings $settings
$updated = Get-ScheduledTask -TaskName 'FamilienWeb'
[pscustomobject]@{task=$updated.TaskName;state=[string]$updated.State;account=$updated.Principal.UserId;recoveryInterval=$updated.Triggers[-1].Repetition.Interval;multipleInstances=[string]$updated.Settings.MultipleInstances;diagnosticsFromNextStart=$true} | ConvertTo-Json

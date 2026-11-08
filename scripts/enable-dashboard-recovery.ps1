$ErrorActionPreference = 'Stop'
$task = Get-ScheduledTask -TaskName 'FamilienDashboardTunnel'
$taskOwner=if($task.Principal.UserId -match '^S-1-') {[System.Security.Principal.SecurityIdentifier]::new($task.Principal.UserId)} else {[System.Security.Principal.NTAccount]::new($task.Principal.UserId).Translate([System.Security.Principal.SecurityIdentifier])}
if ($taskOwner.Value -ne [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value) {throw 'Run under the account owning this task.'}
if ([string]$task.State -eq 'Disabled') {throw 'Tunnelen er deaktivert; ingen automatisk aktivering.'}
# Keep the live SSH process, account and forwarding arguments. Launch future
# attempts through the GUI script host so even failed SSH retries stay hidden.
$actions=@($task.Actions)
if($actions.Count -eq 1 -and [IO.Path]::GetFileName($actions[0].Execute) -ieq 'ssh.exe'){
  $taskRuntime=Join-Path (Split-Path -Parent $PSScriptRoot) '.local\runtime'
  $null=New-Item -ItemType Directory -Path $taskRuntime -Force
  $taskLauncher=Join-Path $taskRuntime 'run-hidden.vbs'
  @'
Option Explicit
If WScript.Arguments.Count <> 2 Then WScript.Quit 64
Dim executable, command, shell, result
executable = WScript.Arguments(0)
If InStr(executable, Chr(34)) > 0 Then WScript.Quit 64
command = Chr(34) & executable & Chr(34) & " " & WScript.Arguments(1)
Set shell = CreateObject("WScript.Shell")
result = shell.Run(command, 0, True)
WScript.Quit result
'@ | Set-Content -LiteralPath $taskLauncher -Encoding ASCII
  function Quote-TaskArgument([string]$value){
    '"'+([regex]::Replace($value,'(\\*)"','$1$1\"') -replace '(\\+)$','$1$1')+'"'
  }
  $launcherArguments='//B //Nologo '+(Quote-TaskArgument $taskLauncher)+' '+(Quote-TaskArgument $actions[0].Execute)+' '+(Quote-TaskArgument $actions[0].Arguments)
  $actions=@(New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\wscript.exe') -Argument $launcherArguments -WorkingDirectory (Split-Path -Parent $PSScriptRoot))
}
$logon = @($task.Triggers | Where-Object {$_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger'})
$recovery = New-ScheduledTaskTrigger -Daily -At '00:00'
$recovery.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 1)).Repetition
$recovery.Repetition.StopAtDurationEnd = $false
$settings = $task.Settings
$settings.MultipleInstances = 2 # IgnoreNew: never interrupt a healthy connection.
$null = Set-ScheduledTask -TaskName $task.TaskName -Action $actions -Trigger (@($logon)+@($recovery)) -Settings $settings
$updated = Get-ScheduledTask -TaskName $task.TaskName
[pscustomobject]@{task=$updated.TaskName;state=[string]$updated.State;account=$updated.Principal.UserId;recoveryInterval=$updated.Triggers[-1].Repetition.Interval;stopAtDurationEnd=$updated.Triggers[-1].Repetition.StopAtDurationEnd} | ConvertTo-Json -Compress

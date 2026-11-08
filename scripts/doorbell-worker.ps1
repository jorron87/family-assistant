$ErrorActionPreference='Stop'
$taskRoot=Split-Path -Parent $PSScriptRoot
$taskLocalData=[Environment]::GetFolderPath('LocalApplicationData')
$env:FAMILIEN_DATA_DIR=Join-Path (Split-Path -Parent $taskRoot) 'FamilienDoorbell'
$taskLogDirectory=Join-Path $taskLocalData 'Familien\doorbell'
New-Item -ItemType Directory -Path $taskLogDirectory -Force | Out-Null
Set-Location -LiteralPath $taskRoot
$taskGatewayPath=Join-Path $PSScriptRoot 'doorbell-gateway.mjs'
$taskNodePath=(Get-Command node.exe -ErrorAction Stop).Source
$taskGatewayPort=if($env:FAMILIEN_DOORBELL_PORT){[int]$env:FAMILIEN_DOORBELL_PORT}else{15319}
while($true){
  try{
    # A legacy native-stderr exception can leave a healthy child running.
    # Adopt only this gateway's listener; never stop an unrelated process.
    $taskListeners=@(Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' -LocalPort $taskGatewayPort -ErrorAction SilentlyContinue)
    $taskExisting=$null
    foreach($taskListener in $taskListeners){
      $taskCandidate=Get-CimInstance Win32_Process -Filter ("ProcessId = "+$taskListener.OwningProcess) -ErrorAction SilentlyContinue
      if($taskCandidate.Name -eq 'node.exe' -and $taskCandidate.CommandLine -match ([regex]::Escape($taskGatewayPath)+'(?:"|\s|$)')){$taskExisting=$taskCandidate;break}
    }
    if($taskExisting){Wait-Process -Id $taskExisting.ProcessId -ErrorAction SilentlyContinue}
    else{
      # Keep stderr separate: Windows PowerShell 5 can turn native stderr
      # into a terminating exception even while the child remains alive.
      $taskChild=Start-Process -FilePath $taskNodePath -ArgumentList ('"'+$taskGatewayPath+'"') -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput (Join-Path $taskLogDirectory 'gateway.log') -RedirectStandardError (Join-Path $taskLogDirectory 'gateway-error.log')
      ('Gateway exited: '+$taskChild.ExitCode) | Add-Content -LiteralPath (Join-Path $taskLogDirectory 'worker.log')
    }
  }
  catch{($_.Exception.Message) | Add-Content -LiteralPath (Join-Path $taskLogDirectory 'worker.log')}
  Start-Sleep -Seconds 10
}

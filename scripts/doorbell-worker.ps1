$ErrorActionPreference='Stop'
$taskRoot=Split-Path -Parent $PSScriptRoot
$taskLocalData=[Environment]::GetFolderPath('LocalApplicationData')
$env:FAMILIEN_DATA_DIR=Join-Path (Split-Path -Parent $taskRoot) 'FamilienDoorbell'
$taskLogDirectory=Join-Path $taskLocalData 'Familien\doorbell'
New-Item -ItemType Directory -Path $taskLogDirectory -Force | Out-Null
Set-Location -LiteralPath $taskRoot
while($true){
  try{& 'C:\Program Files\nodejs\node.exe' (Join-Path $PSScriptRoot 'doorbell-gateway.mjs') *>> (Join-Path $taskLogDirectory 'gateway.log')}
  catch{'Ringeklokkeprosessen stoppet; prøver igjen.' | Add-Content -LiteralPath (Join-Path $taskLogDirectory 'gateway.log')}
  Start-Sleep -Seconds 10
}

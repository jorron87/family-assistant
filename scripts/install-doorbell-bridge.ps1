param([switch]$Elevated)

$ErrorActionPreference = 'Stop'
$taskRoot = Join-Path $env:LOCALAPPDATA 'Familien\doorbell'
$taskInstallRoot = Join-Path $taskRoot 'install'
New-Item -ItemType Directory -Path $taskInstallRoot -Force | Out-Null
$taskIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$taskPrincipal = [Security.Principal.WindowsPrincipal]::new($taskIdentity)
if (!$taskPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    if ($Elevated) { throw 'Windows ga ikke administratorrettigheter.' }
    $taskArguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Elevated'
    $taskProcess = Start-Process powershell.exe -ArgumentList $taskArguments -Verb RunAs -WindowStyle Hidden -PassThru
    Write-Output ('Windows-installasjonen startet. PID: ' + $taskProcess.Id)
    exit
}

$taskResultPath = Join-Path $taskRoot 'installation-result.json'
try {
    $taskRelease = Invoke-RestMethod 'https://api.github.com/repos/borexola/neolink.net/releases/latest'
    $taskAsset = @($taskRelease.assets | Where-Object { $_.name -match '^Neolink\.NET\.Desktop-.*-win-x64\.msi$' })
    if ($taskAsset.Count -ne 1 -or $taskAsset[0].digest -notmatch '^sha256:[a-f0-9]{64}$') {
        throw 'Fant ikke en entydig Windows-installer med publisert SHA-256.'
    }
    $taskAsset = $taskAsset[0]
    $taskInstallerPath = Join-Path $taskInstallRoot $taskAsset.name
    $taskExpectedHash = $taskAsset.digest.Substring(7)
    if (!(Test-Path -LiteralPath $taskInstallerPath) -or (Get-FileHash -LiteralPath $taskInstallerPath -Algorithm SHA256).Hash -ne $taskExpectedHash) {
        Invoke-WebRequest $taskAsset.browser_download_url -OutFile $taskInstallerPath
    }
    if ((Get-FileHash -LiteralPath $taskInstallerPath -Algorithm SHA256).Hash -ne $taskExpectedHash) {
        throw 'Installerens SHA-256 stemmer ikke med GitHub-utgivelsen.'
    }
    # MSI's SYSTEM service also needs access to both the media and the log.
    # Stage them outside the interactive user's profile; retain the download.
    $taskMachineStage = Join-Path $env:ProgramData 'Familien\DoorbellSetup'
    New-Item -ItemType Directory -Path $taskMachineStage -Force | Out-Null
    $taskMachineInstaller = Join-Path $taskMachineStage $taskAsset.name
    Copy-Item -LiteralPath $taskInstallerPath -Destination $taskMachineInstaller -Force
    if ((Get-FileHash -LiteralPath $taskMachineInstaller -Algorithm SHA256).Hash -ne $taskExpectedHash) {
        throw 'Installerens SHA-256 stemmer ikke etter kopiering.'
    }
    $taskInstallerPath = $taskMachineInstaller
    $taskInstallLog = Join-Path $taskMachineStage ('install-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
    $taskArguments = @('/i', ('"' + $taskInstallerPath + '"'), '/qn', '/norestart', 'ADDLOCAL=Main,LocalServer', 'INSTALL_LOCAL_SERVER=1', 'WIXUI_EXITDIALOGOPTIONALCHECKBOX=0', '/l*v', ('"' + $taskInstallLog + '"'))
    for ($taskAttempt = 1; $taskAttempt -le 5; $taskAttempt++) {
        $taskProcess = Start-Process msiexec.exe -ArgumentList $taskArguments -WindowStyle Hidden -Wait -PassThru
        # 1622 is a logging failure, not a failed camera/server configuration.
        # Retry without /l*v rather than changing permissions or killing MSI.
        if ($taskProcess.ExitCode -eq 1622) {
            $taskWithoutLog = $taskArguments[0..($taskArguments.Count - 3)]
            $taskProcess = Start-Process msiexec.exe -ArgumentList $taskWithoutLog -WindowStyle Hidden -Wait -PassThru
        }
        if ($taskProcess.ExitCode -ne 1618) { break }
        if ($taskAttempt -lt 5) { Start-Sleep -Seconds 15 }
    }
    if ($taskProcess.ExitCode -notin @(0,3010)) {
        throw ('Windows Installer feilet med kode ' + $taskProcess.ExitCode + '. Se ' + $taskInstallLog)
    }
    $taskService = Get-Service 'Neolink.NET'
    if ($taskService.Status -ne 'Running') { Start-Service 'Neolink.NET' }
    $taskResult = @{installed=$true; version=$taskRelease.tag_name; sha256=$taskExpectedHash; checkedAt=(Get-Date).ToUniversalTime().ToString('o'); rebootRequired=($taskProcess.ExitCode -eq 3010); automaticDashboardEnabled=$false}
} catch {
    $taskResult = @{installed=$false; error=$_.Exception.Message; checkedAt=(Get-Date).ToUniversalTime().ToString('o'); automaticDashboardEnabled=$false}
}
$taskResult | ConvertTo-Json | Set-Content -LiteralPath $taskResultPath -Encoding UTF8
if (!$taskResult.installed) { exit 1 }

$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$deployLog = Join-Path $taskRoot 'artifacts/review-policy-deployment.json'
$base = 'http://127.0.0.1:4318'
# Aldri start på nytt med kode som ikke kompilerer: sjekk syntaks først.
foreach ($file in 'src/server.mjs','src/store.mjs','src/cli.mjs','src/collector.mjs','src/activity-feeds.mjs','src/resources.mjs','src/google-publisher.mjs','src/ingestion-dispatch.mjs','src/library-feed.mjs','src/phone-dispatch.mjs','src/phone-server.mjs','src/shopping.mjs','src/shopping-stock.mjs','src/shopping-oda-cart.mjs','src/shopping-planning.mjs','public/shopping-view.mjs') {
    & node --check (Join-Path $taskRoot $file)
    if ($LASTEXITCODE -ne 0) { throw "Syntaksfeil i $file. Omstart avbrutt." }
}
function Record-Deployment($status, $note) {
    @{status=$status;note=$note;at=(Get-Date).ToUniversalTime().ToString('o')} |
        ConvertTo-Json | Set-Content -LiteralPath $deployLog -Encoding utf8
}
try {
    # Do not acquire, release or wait for the ingestion lease.
    $before = Invoke-RestMethod "$base/api/state"
    $oldHealth = Invoke-RestMethod "$base/health"
    $deadline = (Get-Date).AddHours(6)
    function Agent-Running {
        if ((Invoke-RestMethod "$base/api/phone/dispatcher").running) {return $true}
        try {return (Invoke-RestMethod "$base/api/ingestion/dispatcher").running} catch {
            if ([int]$_.Exception.Response.StatusCode -eq 404) {return $false}
            throw
        }
    }
    while (Agent-Running) {
        Record-Deployment 'waiting' 'Venter på agenten som nettsidetjenesten selv startet.'
        if ((Get-Date) -gt $deadline) {throw 'Mobilagenten kjører fortsatt. Omstart er utsatt.'}
        Start-Sleep -Seconds 15
    }
    Record-Deployment 'restarting' 'Starter nettsidetjenesten på nytt; innhentingslåsen beholdes.'
    $accepted = $false
    $legacy = $false
    $busyUntil = (Get-Date).AddMinutes(15)
    while (-not $accepted -and -not $legacy) {
        try {
            $null = Invoke-RestMethod -Method Post -Uri "$base/api/maintenance/restart" -Headers @{'X-Family-Request'='1'} -ContentType 'application/json' -Body '{}' -TimeoutSec 20
            $accepted = $true
        } catch {
            $code = if ($_.Exception.Response) {[int]$_.Exception.Response.StatusCode} else {0}
            if ($code -eq 404) {
                $legacy = $true
            } elseif ($code -eq 409) {
                # Nothing has been closed yet, so the service keeps running.
                if ((Get-Date) -gt $busyUntil) {throw 'Tjenesten er opptatt. Omstart er utsatt, og tjenesten kjorer videre.'}
                Record-Deployment 'waiting' 'Venter til lange foresporsler er ferdige.'
                Start-Sleep -Seconds 5
            } elseif ($code -eq 0) {
                # The answer was lost. If the service is gone, the drain has begun.
                Start-Sleep -Seconds 3
                try {$null = Invoke-RestMethod "$base/health" -TimeoutSec 5} catch {$accepted = $true}
            } else {
                throw
            }
        }
    }
    if ($accepted) {
        # The listeners are closed now, so from here the service must always come
        # back. The server ends its own drain; stopping it is only for a hung process.
        $deadline = (Get-Date).AddSeconds(75)
        $stopped = $false
        while (Get-Process -Id $oldHealth.pid -ErrorAction SilentlyContinue) {
            if (-not $stopped -and (Get-Date) -gt $deadline) {
                Stop-Process -Id $oldHealth.pid -Force -Confirm:$false
                $stopped = $true
            }
            Start-Sleep -Milliseconds 500
        }
    } else {
        # One-time upgrade of the legacy server, which has no drain endpoint.
        $latest = Invoke-RestMethod "$base/api/state"
        if ($latest.phone.worker) {throw 'Eldre tjeneste har en mobilagent. Ingen tvungen omstart.'}
        Stop-ScheduledTask -TaskName 'FamilienWeb'
        Start-Sleep -Milliseconds 500
    }
    Start-ScheduledTask -TaskName 'FamilienWeb'
    $healthy = $false
    for ($attempt=0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Seconds 1
        try {$health=Invoke-RestMethod "$base/health";if($health.pid -ne $oldHealth.pid){$healthy=$true;break}} catch {}
    }
    if (-not $healthy) {throw 'FamilienWeb svarte ikke etter omstart.'}
    $after = Invoke-RestMethod "$base/api/state"
    if ($before.runLease -and $after.runLease -and $before.runLease.token -ne $after.runLease.token) {throw 'Kjøringslåsen endret eier under omstart; kontroller kjøringshistorikken.'}
    Record-Deployment 'deployed' 'Nettsidetjenesten er oppdatert uavhengig av innhentingskjøringen.'
} catch {
    Record-Deployment 'error' $_.Exception.Message
    throw
}

# AUTO-PULL SCRIPT - DreamHome Bot
# Checks GitHub every 30 seconds for new changes from your friend

$projectPath = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectPath

Write-Host ""
Write-Host "AUTO-PULL STARTED" -ForegroundColor Cyan
Write-Host "Watching GitHub every 30 seconds..." -ForegroundColor Gray
Write-Host "Press Ctrl+C to stop" -ForegroundColor Gray
Write-Host ""

$pullCount = 0

while ($true) {
    $time = Get-Date -Format "HH:mm:ss"

    $result = git pull 2>&1
    $resultStr = ($result | Out-String).Trim()

    if ($resultStr -like "*Already up to date*") {
        Write-Host "[$time] No changes" -ForegroundColor DarkGray
    }
    elseif ($resultStr -like "*error*" -or $resultStr -like "*fatal*") {
        Write-Host "[$time] ERROR: $resultStr" -ForegroundColor Red
    }
    else {
        $pullCount++
        Write-Host ""
        Write-Host "[$time] NEW CHANGES PULLED! (#$pullCount)" -ForegroundColor Green
        Write-Host "$resultStr" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "   Restart your bot to apply changes" -ForegroundColor Cyan
        Write-Host ""
    }

    Start-Sleep -Seconds 30
}

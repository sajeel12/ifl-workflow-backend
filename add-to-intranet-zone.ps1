# Add hosppdevsrv to Intranet Zone
# Zone 1 = Local Intranet

Write-Host "Adding hosppdevsrv to Internet Explorer Intranet Zone..." -ForegroundColor Cyan

# Create the registry key for hosppdevsrv
$regPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings\ZoneMap\Domains\hosppdevsrv"

# Create the key if it doesn't exist
if (-not (Test-Path $regPath)) {
    New-Item -Path $regPath -Force | Out-Null
    Write-Host "Created registry key: $regPath" -ForegroundColor Green
} else {
    Write-Host "Registry key already exists: $regPath" -ForegroundColor Yellow
}

# Set http protocol to zone 1 (Intranet)
New-ItemProperty -Path $regPath -Name "http" -Value 1 -PropertyType DWord -Force | Out-Null
Write-Host "Set http protocol to Intranet zone (1)" -ForegroundColor Green

# Verify
Write-Host "`nVerifying registry entry..." -ForegroundColor Cyan
$value = Get-ItemProperty -Path $regPath -Name "http" -ErrorAction SilentlyContinue
if ($value.http -eq 1) {
    Write-Host "✓ SUCCESS! hosppdevsrv is now in Intranet zone" -ForegroundColor Green
    Write-Host "  Registry path: $regPath" -ForegroundColor Gray
    Write-Host "  Protocol: http" -ForegroundColor Gray
    Write-Host "  Zone: 1 (Local Intranet)" -ForegroundColor Gray
} else {
    Write-Host "✗ FAILED! Could not verify registry entry" -ForegroundColor Red
    exit 1
}

Write-Host "`n" -NoNewline
Write-Host "IMPORTANT NEXT STEPS:" -ForegroundColor Yellow
Write-Host "1. Close ALL browser windows (Chrome, Edge, Firefox)" -ForegroundColor White
Write-Host "2. Check Task Manager - ensure no chrome.exe or msedge.exe is running" -ForegroundColor White
Write-Host "3. Open a NEW browser window" -ForegroundColor White
Write-Host "4. Go to: http://hosppdevsrv:3333/token.aspx" -ForegroundColor Cyan
Write-Host "5. Expected: NO popup, page loads immediately with your identity" -ForegroundColor Green

Write-Host "`nIf you still see a popup:" -ForegroundColor Yellow
Write-Host "- Restart your computer (Group Policy may be blocking manual changes)" -ForegroundColor White
Write-Host "- Contact your AD admin to add hosppdevsrv to domain-wide Intranet zone" -ForegroundColor White

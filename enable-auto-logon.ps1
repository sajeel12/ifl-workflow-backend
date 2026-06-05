# Enable Automatic Logon for Intranet Zone
Write-Host "Enabling Automatic Logon for Local Intranet Zone..." -ForegroundColor Cyan
Write-Host ""

$regPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings\Zones\1"

# Set 1A00 to 0 (Automatically logon with current user name and password)
try {
    New-ItemProperty -Path $regPath -Name "1A00" -Value 0 -PropertyType DWord -Force | Out-Null
    Write-Host "✓ SUCCESS! Automatic logon enabled for Intranet zone" -ForegroundColor Green
    Write-Host ""

    # Verify
    $value = Get-ItemProperty -Path $regPath -Name "1A00"
    Write-Host "Current value: $($value.'1A00')" -ForegroundColor White
    Write-Host "  0 = Automatically logon with current user name and password ✓" -ForegroundColor Green

} catch {
    Write-Host "✗ FAILED: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "=" * 80 -ForegroundColor Yellow
Write-Host "NEXT STEPS:" -ForegroundColor Yellow
Write-Host "=" * 80 -ForegroundColor Yellow
Write-Host "1. Close ALL browser windows (Chrome, Edge)" -ForegroundColor White
Write-Host "2. Check Task Manager - kill any chrome.exe or msedge.exe processes" -ForegroundColor White
Write-Host "3. Open NEW browser window" -ForegroundColor White
Write-Host "4. Go to: http://hosppdevsrv.ifl.net:3333/token.aspx" -ForegroundColor Cyan
Write-Host "5. Expected: NO popup, loads immediately!" -ForegroundColor Green
Write-Host ""
Write-Host "If you STILL see a popup, the issue is likely:" -ForegroundColor Yellow
Write-Host "- Chrome policy blocking automatic authentication" -ForegroundColor White
Write-Host "- Port :3333 breaking Intranet zone matching" -ForegroundColor White
Write-Host "- Need to use port 80 (default HTTP) or port 443 (HTTPS)" -ForegroundColor White

# Fix Chrome/Edge Automatic Windows Authentication
# This adds hosppdevsrv to Chrome's authentication server whitelist

Write-Host "=" * 80 -ForegroundColor Cyan
Write-Host "FIX CHROME/EDGE AUTOMATIC WINDOWS AUTHENTICATION" -ForegroundColor Cyan
Write-Host "=" * 80 -ForegroundColor Cyan
Write-Host ""

$servers = "hosppdevsrv,hosppdevsrv.ifl.net,*.ifl.net"

Write-Host "Adding authentication servers to Chrome/Edge policy..." -ForegroundColor Yellow
Write-Host "  Servers: $servers" -ForegroundColor White
Write-Host ""

# Chrome Policy
$chromePolicyPath = "HKLM:\Software\Policies\Google\Chrome"
if (-not (Test-Path $chromePolicyPath)) {
    New-Item -Path $chromePolicyPath -Force | Out-Null
    Write-Host "Created Chrome policy registry key" -ForegroundColor Green
}

# Set AuthServerWhitelist (which servers to auto-send credentials to)
New-ItemProperty -Path $chromePolicyPath -Name "AuthServerWhitelist" -Value $servers -PropertyType String -Force | Out-Null
Write-Host "✓ Set Chrome AuthServerWhitelist: $servers" -ForegroundColor Green

# Set AuthNegotiateDelegateWhitelist (which servers can delegate credentials)
New-ItemProperty -Path $chromePolicyPath -Name "AuthNegotiateDelegateWhitelist" -Value $servers -PropertyType String -Force | Out-Null
Write-Host "✓ Set Chrome AuthNegotiateDelegateWhitelist: $servers" -ForegroundColor Green

Write-Host ""

# Edge Policy
$edgePolicyPath = "HKLM:\Software\Policies\Microsoft\Edge"
if (-not (Test-Path $edgePolicyPath)) {
    New-Item -Path $edgePolicyPath -Force | Out-Null
    Write-Host "Created Edge policy registry key" -ForegroundColor Green
}

# Set AuthServerWhitelist
New-ItemProperty -Path $edgePolicyPath -Name "AuthServerWhitelist" -Value $servers -PropertyType String -Force | Out-Null
Write-Host "✓ Set Edge AuthServerWhitelist: $servers" -ForegroundColor Green

# Set AuthNegotiateDelegateWhitelist
New-ItemProperty -Path $edgePolicyPath -Name "AuthNegotiateDelegateWhitelist" -Value $servers -PropertyType String -Force | Out-Null
Write-Host "✓ Set Edge AuthNegotiateDelegateWhitelist: $servers" -ForegroundColor Green

Write-Host ""
Write-Host "=" * 80 -ForegroundColor Green
Write-Host "SUCCESS! Chrome/Edge authentication whitelist configured" -ForegroundColor Green
Write-Host "=" * 80 -ForegroundColor Green
Write-Host ""

Write-Host "NEXT STEPS:" -ForegroundColor Yellow
Write-Host "1. Close ALL Chrome/Edge windows (very important!)" -ForegroundColor White
Write-Host "2. Check Task Manager - kill any chrome.exe or msedge.exe processes" -ForegroundColor White
Write-Host "3. Open NEW Chrome/Edge window" -ForegroundColor White
Write-Host "4. Go to: http://hosppdevsrv.ifl.net:3333/token.aspx" -ForegroundColor Cyan
Write-Host "5. Expected: NO POPUP! Page loads immediately with your identity!" -ForegroundColor Green
Write-Host ""
Write-Host "If you STILL see a popup:" -ForegroundColor Yellow
Write-Host "- Run: gpupdate /force" -ForegroundColor White
Write-Host "- Restart your computer" -ForegroundColor White
Write-Host "- Test again" -ForegroundColor White
Write-Host ""
Write-Host "To verify the settings were applied:" -ForegroundColor Yellow
Write-Host "1. Open Chrome" -ForegroundColor White
Write-Host "2. Go to: chrome://policy" -ForegroundColor Cyan
Write-Host "3. Look for: AuthServerWhitelist and AuthNegotiateDelegateWhitelist" -ForegroundColor White
Write-Host "4. Should show: $servers" -ForegroundColor White

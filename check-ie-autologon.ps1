# Check Internet Explorer Automatic Logon Settings
Write-Host "Checking Internet Explorer Security Settings for Automatic Logon..." -ForegroundColor Cyan
Write-Host ""

# Zone 1 = Local Intranet
$regPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings\Zones\1"

Write-Host "Local Intranet Zone (Zone 1) Settings:" -ForegroundColor Yellow
Write-Host "Registry Path: $regPath" -ForegroundColor Gray
Write-Host ""

# 1A00 = Automatic logon setting
# 0 = Automatically logon with current user name and password
# 1 = Prompt for user name and password
# 2 = Automatic logon only in Intranet zone
$autoLogon = Get-ItemProperty -Path $regPath -Name "1A00" -ErrorAction SilentlyContinue

if ($autoLogon) {
    $value = $autoLogon.'1A00'
    Write-Host "Automatic Logon Setting (1A00): $value" -ForegroundColor White

    switch ($value) {
        0 {
            Write-Host "  ✓ GOOD: Automatically logon with current user name and password" -ForegroundColor Green
            Write-Host "  This should work for SSO!" -ForegroundColor Green
        }
        65536 {
            Write-Host "  ✓ GOOD: Automatic logon only in Intranet zone" -ForegroundColor Green
            Write-Host "  This should work for SSO in Intranet sites!" -ForegroundColor Green
        }
        196608 {
            Write-Host "  ❌ PROBLEM: Prompt for user name and password" -ForegroundColor Red
            Write-Host "  This is why you're seeing the popup!" -ForegroundColor Red
            Write-Host "  SOLUTION: Change this setting to enable automatic logon" -ForegroundColor Yellow
        }
        131072 {
            Write-Host "  ❌ PROBLEM: Anonymous logon" -ForegroundColor Red
            Write-Host "  This won't work for Windows Authentication" -ForegroundColor Red
        }
        default {
            Write-Host "  ⚠ Unknown value: $value" -ForegroundColor Yellow
        }
    }
} else {
    Write-Host "  ⚠ Automatic Logon setting not found (using default)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Other relevant settings:" -ForegroundColor Yellow

# Check if user authentication policy is set
$userAuth = Get-ItemProperty -Path $regPath -Name "1A00" -ErrorAction SilentlyContinue
Write-Host "All Zone 1 properties:" -ForegroundColor Gray
Get-ItemProperty -Path $regPath | Format-List

Write-Host ""
Write-Host "=" * 80 -ForegroundColor Cyan
Write-Host "HOW TO FIX if Automatic Logon is disabled:" -ForegroundColor Yellow
Write-Host "=" * 80 -ForegroundColor Cyan
Write-Host ""
Write-Host "Option 1: Via Internet Options GUI" -ForegroundColor Green
Write-Host "1. Open Control Panel → Internet Options" -ForegroundColor White
Write-Host "2. Security tab → Local intranet → Custom level" -ForegroundColor White
Write-Host "3. Scroll to bottom: 'User Authentication' → 'Logon'" -ForegroundColor White
Write-Host "4. Select: 'Automatic logon with current user name and password'" -ForegroundColor White
Write-Host "5. Click OK → OK" -ForegroundColor White
Write-Host ""
Write-Host "Option 2: Via Registry (Run as Administrator)" -ForegroundColor Green
Write-Host "Run this command:" -ForegroundColor White
Write-Host "  reg add ""HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings\Zones\1"" /v 1A00 /t REG_DWORD /d 0 /f" -ForegroundColor Cyan
Write-Host ""
Write-Host "After changing:" -ForegroundColor Yellow
Write-Host "- Close ALL browser windows" -ForegroundColor White
Write-Host "- Open new browser" -ForegroundColor White
Write-Host "- Test: http://hosppdevsrv.ifl.net:3333/token.aspx" -ForegroundColor Cyan
Write-Host "- Expected: NO popup!" -ForegroundColor Green

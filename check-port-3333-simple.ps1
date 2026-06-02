# Check if port 3333 is in Intranet zone

Write-Host "Checking port 3333 configuration..." -ForegroundColor Cyan
Write-Host ""

# Check FQDN
$fqdnPath = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\CurrentVersion\Internet Settings\ZoneMap\Domains\ifl.net\hosppdevsrv"
Write-Host "1. FQDN (hosppdevsrv.ifl.net):" -ForegroundColor Yellow

if (Test-Path $fqdnPath) {
    $props = Get-ItemProperty -Path $fqdnPath

    Write-Host "   http property = $($props.http)" -ForegroundColor White

    if (Get-Member -InputObject $props -Name '3333') {
        Write-Host "   3333 property = $($props.'3333') [PORT 3333 CONFIGURED]" -ForegroundColor Green
    } else {
        Write-Host "   3333 property = NOT SET [PORT 3333 MISSING]" -ForegroundColor Red
    }
} else {
    Write-Host "   Path does not exist" -ForegroundColor Red
}

Write-Host ""

# Check short name
$shortPath = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\CurrentVersion\Internet Settings\ZoneMap\Domains\hosppdevsrv"
Write-Host "2. Short hostname (hosppdevsrv):" -ForegroundColor Yellow

if (Test-Path $shortPath) {
    $props = Get-ItemProperty -Path $shortPath
    Write-Host "   Registry key exists" -ForegroundColor Green
} else {
    Write-Host "   Registry key does NOT exist" -ForegroundColor Red
}

Write-Host ""
Write-Host "PROBLEM:" -ForegroundColor Red
Write-Host "Domain entries only match default ports (80/443)" -ForegroundColor White
Write-Host "Port 3333 requires explicit registry entry" -ForegroundColor White
Write-Host ""
Write-Host "SOLUTION:" -ForegroundColor Green
Write-Host "AD admin needs to add property: 3333 = 1 (DWORD)" -ForegroundColor White
Write-Host "To path: $fqdnPath" -ForegroundColor Gray

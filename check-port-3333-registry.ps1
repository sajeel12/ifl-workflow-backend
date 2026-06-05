# Check if port 3333 is in Intranet zone for hosppdevsrv
# Run this to see if the AD admin actually added port 3333

Write-Host "=" * 80 -ForegroundColor Cyan
Write-Host "CHECKING INTRANET ZONE REGISTRY FOR PORT 3333" -ForegroundColor Cyan
Write-Host "=" * 80 -ForegroundColor Cyan
Write-Host ""

# Check FQDN: hosppdevsrv.ifl.net
$fqdnPath = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\CurrentVersion\Internet Settings\ZoneMap\Domains\ifl.net\hosppdevsrv"
Write-Host "1. Checking FQDN: hosppdevsrv.ifl.net" -ForegroundColor Yellow
Write-Host "   Path: $fqdnPath" -ForegroundColor Gray

if (Test-Path $fqdnPath) {
    $props = Get-ItemProperty -Path $fqdnPath
    Write-Host "   ✓ Registry key exists" -ForegroundColor Green
    Write-Host ""
    Write-Host "   Properties:" -ForegroundColor White

    if ($props.http) {
        Write-Host "     http = $($props.http) " -ForegroundColor Green -NoNewline
        Write-Host "(matches port 80 only)" -ForegroundColor Gray
    }

    if ($props.'3333') {
        Write-Host "     3333 = $($props.'3333') " -ForegroundColor Green -NoNewline
        Write-Host "← PORT 3333 IS CONFIGURED! ✓" -ForegroundColor Green
    } else {
        Write-Host "     3333 = NOT SET " -ForegroundColor Red -NoNewline
        Write-Host "← PORT 3333 IS MISSING! ✗" -ForegroundColor Red
    }
} else {
    Write-Host "   ✗ Registry key does not exist" -ForegroundColor Red
}

Write-Host ""

# Check short hostname: hosppdevsrv
$shortPath = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\CurrentVersion\Internet Settings\ZoneMap\Domains\hosppdevsrv"
Write-Host "2. Checking short hostname: hosppdevsrv" -ForegroundColor Yellow
Write-Host "   Path: $shortPath" -ForegroundColor Gray

if (Test-Path $shortPath) {
    $props = Get-ItemProperty -Path $shortPath
    Write-Host "   ✓ Registry key exists" -ForegroundColor Green
    Write-Host ""
    Write-Host "   Properties:" -ForegroundColor White

    if ($props.http) {
        Write-Host "     http = $($props.http) " -ForegroundColor Green -NoNewline
        Write-Host "(matches port 80 only)" -ForegroundColor Gray
    }

    if ($props.'3333') {
        Write-Host "     3333 = $($props.'3333') " -ForegroundColor Green -NoNewline
        Write-Host "← PORT 3333 IS CONFIGURED! ✓" -ForegroundColor Green
    } else {
        Write-Host "     3333 = NOT SET " -ForegroundColor Red -NoNewline
        Write-Host "← PORT 3333 IS MISSING! ✗" -ForegroundColor Red
    }
} else {
    Write-Host "   ✗ Registry key does not exist" -ForegroundColor Red
}

Write-Host ""

# Check IP range
$rangePath = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\CurrentVersion\Internet Settings\ZoneMap\Ranges\Range1"
Write-Host "3. Checking IP range: 192.168.1.92" -ForegroundColor Yellow
Write-Host "   Path: $rangePath" -ForegroundColor Gray

if (Test-Path $rangePath) {
    $props = Get-ItemProperty -Path $rangePath
    Write-Host "   ✓ Registry key exists" -ForegroundColor Green
    Write-Host ""
    Write-Host "   Properties:" -ForegroundColor White

    if ($props.':Range') {
        Write-Host "     :Range = $($props.':Range') " -ForegroundColor Green -NoNewline
        Write-Host "(IP address)" -ForegroundColor Gray
    }

    if ($props.http) {
        Write-Host "     http = $($props.http) " -ForegroundColor Green -NoNewline
        Write-Host "(matches ALL ports - that's why IP works!)" -ForegroundColor Green
    }
} else {
    Write-Host "   ✗ Registry key does not exist" -ForegroundColor Red
}

Write-Host ""
Write-Host "=" * 80 -ForegroundColor Cyan
Write-Host "SUMMARY" -ForegroundColor Cyan
Write-Host "=" * 80 -ForegroundColor Cyan
Write-Host ""

Write-Host "Why IP address works but hostname doesn't:" -ForegroundColor Yellow
Write-Host "• IP ranges (192.168.1.92) match ALL ports automatically" -ForegroundColor White
Write-Host "• Domain entries (hosppdevsrv.ifl.net) ONLY match default ports (80/443)" -ForegroundColor White
Write-Host "• Custom port 3333 requires explicit registry entry: 3333 = 1" -ForegroundColor White
Write-Host ""

Write-Host "What the AD admin needs to add:" -ForegroundColor Yellow
Write-Host "Path: $fqdnPath" -ForegroundColor Gray
Write-Host "Property: 3333 = 1 (DWORD)" -ForegroundColor White
Write-Host ""

Write-Host "Or optionally for short hostname:" -ForegroundColor Yellow
Write-Host "Path: $shortPath" -ForegroundColor Gray
Write-Host "Property: 3333 = 1 (DWORD)" -ForegroundColor White
Write-Host ""

Write-Host "After AD admin adds this via Group Policy:" -ForegroundColor Yellow
Write-Host "1. Run: gpupdate /force" -ForegroundColor Cyan
Write-Host "2. Close ALL browser windows completely" -ForegroundColor Cyan
Write-Host "3. Test: http://hosppdevsrv.ifl.net:3333/token.aspx" -ForegroundColor Cyan
Write-Host "4. Expected: NO popup, immediate load" -ForegroundColor Green
Write-Host ""

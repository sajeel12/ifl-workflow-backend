# Windows Authentication & SPN Resolution

**Date:** May 29-30, 2026
**Status:** ✅ **RESOLVED** - Missing SPNs were the root cause
**Priority:** Critical - Required for Kerberos authentication

---

## ✅ RESOLUTION (May 30, 2026)

### The REAL Root Cause: Missing HTTP SPNs

**The problem was NOT Intranet zone port matching.**

**The ACTUAL issue:** HTTP Service Principal Names (SPNs) were not registered to the application pool account (sppadmin).

### What Fixed It

```cmd
# Register HTTP SPNs to sppadmin application pool account
setspn -S HTTP/HOSPPDEVSRV ibrahim1_nt\sppadmin
setspn -S HTTP/HOSPPDEVSRV.IFL.NET ibrahim1_nt\sppadmin

# Restart IIS
iisreset
```

### Result

**ALL hostname access now works WITHOUT popup:**
- ✅ `http://hosppdevsrv.ifl.net:3333` - NO POPUP!
- ✅ `http://hosppdevsrv:3333` - NO POPUP!
- ✅ `http://192.168.1.92:3333` - NO POPUP!

**Authentication method:** Kerberos (via Negotiate provider)

---

## Why This Was Confusing

### Initial Symptoms (May 29, 2026)

- ✅ **IP Address:** `http://192.168.1.92:3333` - NO popup, worked perfectly
- ❌ **Hostname:** `http://hosppdevsrv.ifl.net:3333` - Showed popup every time

This pattern led to the **incorrect theory** about Intranet zone port matching.

### Why IP Address Worked But Hostname Didn't

**IP Address (192.168.1.92):**
```
Kerberos does NOT work with IP addresses (by design)
    ↓
Browser immediately uses NTLM (no Kerberos attempt)
    ↓
NTLM succeeds without popup (Intranet zone allows it)
    ↓
✅ NO POPUP!
```

**Hostname (hosppdevsrv.ifl.net) BEFORE SPN fix:**
```
Browser tries Kerberos first (hostname-based)
    ↓
SPN lookup: HTTP/hosppdevsrv.ifl.net
    ↓
Active Directory: SPN NOT FOUND
    ↓
Kerberos FAILS
    ↓
Falls back to NTLM
    ↓
NTLM challenge triggers popup
    ↓
❌ POPUP SHOWN!
```

**Hostname (hosppdevsrv.ifl.net) AFTER SPN fix:**
```
Browser tries Kerberos first (hostname-based)
    ↓
SPN lookup: HTTP/hosppdevsrv.ifl.net
    ↓
Active Directory: SPN FOUND (registered to sppadmin)
    ↓
Kerberos ticket issued
    ↓
IIS validates ticket (sppadmin can decrypt it)
    ↓
✅ Authentication successful - NO POPUP!
```

---

## What Are SPNs and Why Do They Matter?

### Service Principal Name (SPN)

An SPN is a unique identifier for a service instance in Active Directory. It's **REQUIRED** for Kerberos authentication.

**Format:** `ServiceClass/HostName`

**Examples:**
- `HTTP/hosppdevsrv.ifl.net`
- `HTTP/hosppdevsrv`
- `MSSQLSvc/server.domain.com:1433`

**Important:** HTTP SPNs do NOT include port numbers!

### Our web.config Uses Negotiate Provider

```xml
<windowsAuthentication enabled="true" useKernelMode="false" useAppPoolCredentials="true">
    <providers>
        <clear />
        <add value="Negotiate" />  ← Tries Kerberos FIRST (requires SPNs)
        <add value="NTLM" />       ← Falls back to NTLM if Kerberos fails
    </providers>
</windowsAuthentication>
```

**Key setting:** `useAppPoolCredentials="true"`
- IIS uses the application pool identity (sppadmin) to validate Kerberos tickets
- SPNs MUST be registered to this account

---

## How We Discovered the Real Issue

### Investigation Steps (May 29, 2026)

1. **Initial theory:** Port 3333 not in Intranet zone
2. **Checked registry:** Found `http = 1` but no `3333 = 1` property
3. **Created diagnostic tools:** 5-layer authentication testing
4. **Tested extensively:** Confirmed IP works, hostname doesn't

### Breakthrough (May 30, 2026)

**AD Admin's insight:** Checked application pool account and discovered missing SPNs

```cmd
C:\> setspn -Q HTTP/HOSPPDEVSRV
Checking domain DC=IFL,DC=NET
No such SPN found.  ← THE PROBLEM!

C:\> setspn -Q HTTP/HOSPPDEVSRV.IFL.NET
Checking domain DC=IFL,DC=NET
No such SPN found.  ← THE PROBLEM!
```

**Before fix:** sppadmin had only MSSQLSvc SPNs, NO HTTP SPNs

```cmd
C:\> setspn -L ibrahim1_nt\sppadmin
Registered ServicePrincipalNames for CN=SPP Admin:
        MSSQLSvc/IGCPROJECT.IFL.NET:1433
        MSSQLSvc/IGCPROJECT.IFL.NET
        ... (many SQL Server SPNs, but NO HTTP SPNs)
```

**After fix:** sppadmin now has HTTP SPNs

```cmd
C:\> setspn -L ibrahim1_nt\sppadmin
Registered ServicePrincipalNames for CN=SPP Admin:
        HTTP/HOSPPDEVSRV.IFL.NET      ← ADDED!
        HTTP/HOSPPDEVSRV              ← ADDED!
        MSSQLSvc/IGCPROJECT.IFL.NET:1433
        MSSQLSvc/IGCPROJECT.IFL.NET
        ... (SQL Server SPNs)
```

---

## Original Investigation (May 29, 2026)

### ~~Intranet Zone Port Matching Theory (INCORRECT)~~

**We initially thought:**
- Domain entries (e.g., `hosppdevsrv.ifl.net`) only match default ports (80/443)
- IP ranges (e.g., `192.168.1.92`) match ALL ports
- Port 3333 not in Intranet zone for hostname entries

**This was a RED HERRING!** The real issue was missing SPNs.

### Why We Thought It Was Intranet Zone

**Registry showed:**
```
HKLM:\...\ZoneMap\Domains\ifl.net\hosppdevsrv
  http = 1    (matches port 80)

Missing: 3333 = 1  (thought this was needed for port 3333)
```

**We were wrong!** Domain entries don't need port-specific entries for Kerberos. The issue was the missing SPN, not the port configuration.

### IIS Log Evidence (May 29, 2026)

**Logs showed:**
```
c-ip: 172.28.33.24
Accessing: http://hosppdevsrv.ifl.net:3333/token.aspx

401 2 5         cs-username: -  (browser didn't send credentials)
401 1 2148074254  cs-username: -  (SEC_E_NO_CREDENTIALS)
401 2 5         cs-username: -  (STILL failing on every request)
```

**What we didn't realize:** This was Kerberos failing due to missing SPN, then NTLM also failing.

---

## Diagnostic Tools Created (Still Useful!)

### 1. Full Diagnostic UI
**URL:** `http://192.168.1.92:3333/diagnostics/auth-ui`

**Tests:**
- BROWSER: Can connect and send requests
- IIS: Windows Authentication and X-Auth-User header
- token.aspx: HMAC token generation with AD lookup
- NETWORK: Loopback trust validation
- NODE.JS: HMAC signature validation (timing-safe)

### 2. Simple Test Page
**URL:** `http://192.168.1.92:3333/test-auth.html`

### 3. Browser Fix Guide
**URL:** `http://192.168.1.92:3333/fix-windows-auth.html`

These tools are still valuable for diagnosing authentication issues!

---

## How to Diagnose SPN Issues in the Future

### Step 1: Check Application Pool Identity

In IIS Manager:
- Application Pools → Select pool → Advanced Settings
- Identity: Custom account (e.g., IBRAHIM1_NT\sppadmin)

### Step 2: Check if SPNs Exist

```cmd
# Check for HTTP SPNs matching your hostname
setspn -Q HTTP/yourhostname
setspn -Q HTTP/yourhostname.domain.com
```

**If "No such SPN found"** → This is likely your problem!

### Step 3: Check SPNs Registered to Account

```cmd
# List all SPNs for the application pool account
setspn -L domain\accountname
```

Look for HTTP SPNs. If missing, that's the problem.

### Step 4: Add Missing SPNs

```cmd
# Add HTTP SPNs
setspn -S HTTP/hostname domain\account
setspn -S HTTP/hostname.domain.com domain\account

# Restart IIS
iisreset
```

### Step 5: Verify

```cmd
# Check SPNs were added
setspn -L domain\account

# Test in browser (close all windows first)
# Navigate to: http://hostname.domain.com:port/
# Expected: NO POPUP!
```

---

## Key Learnings

1. **Kerberos requires SPNs**
   - Without SPNs, Kerberos fails silently
   - Falls back to NTLM (which may trigger popups)

2. **IP addresses bypass Kerberos**
   - Kerberos doesn't work with IP addresses
   - That's why IP worked (used NTLM directly)

3. **Check application pool account first**
   - SPNs must match the account IIS uses
   - Not the machine account, not the user account

4. **HTTP SPNs don't include ports**
   - `HTTP/hostname` works for ALL ports
   - Don't add `:3333` to the SPN

5. **Intranet zone was a red herring**
   - IP worked because it bypassed Kerberos
   - Hostname failed because Kerberos failed (missing SPN)
   - Port matching was NOT the issue

---

## References

- **SPN_TROUBLESHOOTING_GUIDE.md** - Comprehensive SPN troubleshooting (NEW)
- **Commit c72b239** - Diagnostic tools
- **Commit 1d00095** - SSO Auth Guardian skill
- **web.config** - Windows Authentication configuration
- **DIAGNOSTICS.md** - Diagnostic tool documentation

---

## Timeline

- **May 12, 2026:** Users accessed via IP, got popup once (credentials cached)
- **May 29, 2026:** Investigated popup issue, created diagnostic tools, suspected Intranet zone
- **May 30, 2026:** ✅ **RESOLVED** - Admin added HTTP SPNs, issue fixed!

---

**Resolution:** SPNs added to sppadmin account
**Fixed By:** AD Admin
**Status:** ✅ WORKING - Kerberos authentication successful
**No further action needed**

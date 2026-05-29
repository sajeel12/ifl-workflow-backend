# Windows Authentication & Intranet Zone Issues

**Date:** May 29, 2026
**Status:** ✅ Working with IP address | ⏳ Pending fix for hostname
**Priority:** High - Affects user experience

---

## Current Status

### ✅ What Works
- **IP Address Access:** `http://192.168.1.92:3333`
  - NO popup
  - Seamless SSO
  - All authentication layers pass (except IIS layer on initial HTML load, which is expected)

### ❌ What Doesn't Work
- **Hostname Access:** `http://hosppdevsrv.ifl.net:3333`
  - Shows Windows Authentication popup
  - Popup appears on EVERY request (browser won't cache credentials)
  - After entering credentials manually, portal works correctly

---

## Root Cause Analysis

### Why IP Works But Hostname Doesn't

**Windows Intranet Zone Matching Rules:**

1. **Domain entries** (e.g., `hosppdevsrv.ifl.net`)
   - ONLY match **default ports** (80 for HTTP, 443 for HTTPS)
   - Do NOT match custom ports like `:3333`
   - Example: `hosppdevsrv.ifl.net` matches `http://hosppdevsrv.ifl.net:80` but NOT `http://hosppdevsrv.ifl.net:3333`

2. **IP range entries** (e.g., `192.168.1.92`)
   - Match **ALL ports** (port-agnostic)
   - Example: `192.168.1.92` matches `http://192.168.1.92:ANY_PORT`

### Current Group Policy Configuration

```
HKLM:\SOFTWARE\Policies\Microsoft\Windows\CurrentVersion\Internet Settings\ZoneMap\Domains\ifl.net\hosppdevsrv
  http = 1  (Intranet zone)

HKLM:\SOFTWARE\Policies\Microsoft\Windows\CurrentVersion\Internet Settings\ZoneMap\Ranges\Range1
  :Range = 192.168.1.92
  http = 1  (Intranet zone)
```

**Result:**
- ✅ `http://hosppdevsrv.ifl.net` (port 80) → Would work (if site was on port 80)
- ✅ `http://192.168.1.92:3333` → Works (IP matches all ports)
- ❌ `http://hosppdevsrv.ifl.net:3333` → Doesn't work (port 3333 not matched)

---

## Authentication Flow Analysis

### Successful Flow (IP Address)

```
User opens: http://192.168.1.92:3333/portal/it-ops
    ↓
Browser checks: Is 192.168.1.92 in Intranet zone?
    ↓
YES (Range1 matches) → Browser AUTO-SENDS Windows credentials
    ↓
IIS receives credentials → Validates → Sets X-Auth-User header
    ↓
Node.js receives request with X-Auth-User header
    ↓
✅ Page loads, NO POPUP!
```

### Failed Flow (Hostname with Port)

```
User opens: http://hosppdevsrv.ifl.net:3333/portal/it-ops
    ↓
Browser checks: Is hosppdevsrv.ifl.net:3333 in Intranet zone?
    ↓
NO (only hosppdevsrv.ifl.net:80 matches) → Browser DOES NOT auto-send credentials
    ↓
IIS challenges with 401
    ↓
Browser shows popup asking for credentials
    ↓
User enters credentials → Request succeeds
    ↓
Next request → SAME PROBLEM → Popup again!
    ↓
❌ Infinite popup loop
```

---

## IIS Log Evidence

### May 12, 2026 (When It Worked)
```
c-ip: 192.168.1.253
Accessing: http://192.168.1.92:3333/api/onboarding/initiate

401 2 5         cs-username: -  (browser didn't send credentials initially)
401 1 2148074254  cs-username: -  (SEC_E_NO_CREDENTIALS)
200 0 0         cs-username: IBRAHIM1_NT\ADNANJVD  (SUCCESS after popup)
```

**Pattern:** Users were accessing via IP address, got popup ONCE, then credentials were cached.

### May 29, 2026 (Current Issue)
```
c-ip: 172.28.33.24
Accessing: http://hosppdevsrv.ifl.net:3333/token.aspx

401 2 5         cs-username: -  (browser didn't send credentials)
401 1 2148074254  cs-username: -  (SEC_E_NO_CREDENTIALS)
401 2 5         cs-username: -  (STILL failing on every request)
```

**Pattern:** Using hostname with port 3333, popup appears on EVERY request (credentials not cached).

---

## Solution Options

### Option 1: Use IP Address (Current Workaround) ✅

**Pros:**
- ✅ Works immediately
- ✅ No configuration changes needed
- ✅ No AD admin involvement

**Cons:**
- ❌ Harder to remember
- ❌ If server IP changes, URLs break
- ❌ Less professional

**Implementation:**
```
Update all documentation/bookmarks to:
http://192.168.1.92:3333/portal/it-ops
```

---

### Option 2: Add Port to Group Policy (RECOMMENDED) 🔧

**Pros:**
- ✅ Clean hostname URLs
- ✅ Professional appearance
- ✅ IP-independent

**Cons:**
- ⏳ Requires AD admin
- ⏳ Takes time for policy propagation

**AD Admin Instructions:**

```powershell
# Add port 3333 for short hostname
New-Item -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows\CurrentVersion\Internet Settings\ZoneMap\Domains\hosppdevsrv" -Force
New-ItemProperty -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows\CurrentVersion\Internet Settings\ZoneMap\Domains\hosppdevsrv" -Name "3333" -Value 1 -PropertyType DWord -Force

# Add port 3333 for FQDN
New-Item -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows\CurrentVersion\Internet Settings\ZoneMap\Domains\ifl.net\hosppdevsrv" -Force
New-ItemProperty -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows\CurrentVersion\Internet Settings\ZoneMap\Domains\ifl.net\hosppdevsrv" -Name "3333" -Value 1 -PropertyType DWord -Force
```

**After policy update, users must run:**
```powershell
gpupdate /force
```

**Verification:**
```powershell
Get-ItemProperty -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows\CurrentVersion\Internet Settings\ZoneMap\Domains\hosppdevsrv"
# Should show: 3333 = 1

Get-ItemProperty -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows\CurrentVersion\Internet Settings\ZoneMap\Domains\ifl.net\hosppdevsrv"
# Should show: 3333 = 1
```

---

### Option 3: Move to Port 80 (Long-term) 🚀

**Pros:**
- ✅ No port number needed in URLs
- ✅ Automatically matches Intranet zone
- ✅ Most professional

**Cons:**
- ❌ Port 80 might be used by another site
- ❌ Requires IIS reconfiguration

**Implementation:**
1. Check if port 80 is available: `netstat -an | findstr :80`
2. If available, change IIS binding from `:3333` to `:80`
3. Update Node.js to listen on different port (IIS proxies to it anyway)
4. Access via: `http://hosppdevsrv.ifl.net/portal/it-ops`

---

## Diagnostic Tools Created (May 29, 2026)

### 1. Full Diagnostic UI
**URL:** `http://192.168.1.92:3333/diagnostics/auth-ui`

**Tests:**
- BROWSER: Can connect and send requests
- IIS: Windows Authentication and X-Auth-User header
- token.aspx: HMAC token generation with AD lookup
- NETWORK: Loopback trust validation
- NODE.JS: HMAC signature validation (timing-safe)

**Expected Result with IP:**
- Browser: PASS
- IIS: FAIL (on initial HTML load - this is normal!)
- token.aspx: PASS (hasSignature: true)
- Network: PASS (isLoopback: true)
- Node.js: PASS (signatureValid: true, v2)

**Note:** IIS layer showing "FAIL" for initial page load is EXPECTED. The sidecar token pattern means the HTML page loads without X-Auth-User, then JavaScript fetches token.aspx which DOES have authentication. This is by design.

---

### 2. Simple Test Page
**URL:** `http://192.168.1.92:3333/test-auth.html`

**Tests:**
- Connection check
- token.aspx authentication
- Diagnostics API call

**Use Case:** Quick validation without running full diagnostics

---

### 3. Browser Fix Guide
**URL:** `http://192.168.1.92:3333/fix-windows-auth.html`

**Provides:**
- Step-by-step troubleshooting
- Browser configuration checks
- Registry verification
- Interactive testing

---

## Key Learnings

1. **DNS is NOT the issue** - hostname resolves correctly, issue is Windows security zone matching

2. **Port matching is STRICT for domains** - custom ports require explicit registry entries

3. **IP ranges are PORT-AGNOSTIC** - that's why IP address works with any port

4. **Browser behavior differs:**
   - Chrome: More lenient, caches credentials after first popup
   - Edge: Stricter, requires exact Intranet zone match

5. **IIS logs are invaluable:**
   - `401 2 5` = Access denied (no credentials sent)
   - `401 1 2148074254` = SEC_E_NO_CREDENTIALS
   - Empty `cs-username` = browser didn't auto-send credentials

6. **Sidecar token pattern is CORRECT:**
   - Initial HTML page load: X-Auth-User may be empty
   - JavaScript then fetches token.aspx: Windows credentials ARE sent
   - All subsequent API calls: Use sidecar HMAC token
   - IIS layer "FAIL" in diagnostics is expected and normal!

---

## Pending Actions

### For AD Admin:
- [ ] Add port 3333 to Group Policy Intranet zone for `hosppdevsrv`
- [ ] Add port 3333 to Group Policy Intranet zone for `hosppdevsrv.ifl.net`
- [ ] Verify policy propagation to test machines

### After Group Policy Update:
- [ ] Run `gpupdate /force` on all client machines
- [ ] Verify registry entries exist
- [ ] Test with hostname: `http://hosppdevsrv.ifl.net:3333/token.aspx`
- [ ] Expected: NO popup, immediate load
- [ ] Run full diagnostics: `http://hosppdevsrv.ifl.net:3333/diagnostics/auth-ui`
- [ ] Update documentation with hostname URLs

---

## References

- **Commit:** c72b239 (May 29, 2026) - "Add comprehensive SSO authentication diagnostics and troubleshooting tools"
- **Working web.config:** Identical to May 13, 2026 version (anonymous=false, windows=true)
- **Diagnostic tools:** All committed to main branch
- **Documentation:** DIAGNOSTICS.md, TROUBLESHOOTING_POPUP.md, EDGE_POPUP_FIX.md, NEXT_STEPS.md

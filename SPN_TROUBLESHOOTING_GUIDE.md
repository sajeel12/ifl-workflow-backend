# Service Principal Name (SPN) Troubleshooting Guide

**Date:** May 30, 2026
**Status:** ✅ RESOLVED - SPNs were the root cause of Windows Authentication popup
**Priority:** CRITICAL - Required for Kerberos authentication

---

## 🎯 The REAL Root Cause

**The Windows Authentication popup was NOT caused by Intranet zone port matching.**

**The ACTUAL problem:** Missing HTTP Service Principal Names (SPNs) for the application pool account.

---

## What Happened

### Timeline of Discovery

1. **Initial symptom:** Windows Auth popup when accessing `http://hosppdevsrv.ifl.net:3333`
2. **IP address worked:** `http://192.168.1.92:3333` had NO popup
3. **Initial theory:** Port 3333 not in Windows Intranet zone (INCORRECT)
4. **Admin investigation:** Checked IIS application pool account (sppadmin)
5. **Discovery:** NO HTTP SPNs registered to sppadmin account
6. **Solution:** Added HTTP SPNs for HOSPPDEVSRV and HOSPPDEVSRV.IFL.NET
7. **Result:** ✅ **NO MORE POPUP! SSO works perfectly!**

---

## Understanding SPNs and Kerberos

### What is an SPN?

A **Service Principal Name (SPN)** is a unique identifier for a service instance in Active Directory. It's required for **Kerberos authentication** to work.

**Format:** `ServiceClass/HostName:Port/ServiceName`

**Examples:**
- `HTTP/hosppdevsrv.ifl.net` - HTTP service on hosppdevsrv.ifl.net
- `HTTP/hosppdevsrv` - HTTP service on hosppdevsrv (short name)
- `MSSQLSvc/server.domain.com:1433` - SQL Server on port 1433

### How Kerberos Authentication Works

```
1. User accesses: http://hosppdevsrv.ifl.net:3333
    ↓
2. Browser looks up SPN: HTTP/hosppdevsrv.ifl.net
    ↓
3. Active Directory finds SPN registered to account: IBRAHIM1_NT\sppadmin
    ↓
4. Browser requests Kerberos ticket for that account
    ↓
5. DC issues Kerberos ticket
    ↓
6. Browser sends ticket to IIS
    ↓
7. IIS validates ticket (sppadmin can decrypt it)
    ↓
8. ✅ Authentication successful - NO POPUP!
```

### When SPN is Missing

```
1. User accesses: http://hosppdevsrv.ifl.net:3333
    ↓
2. Browser looks up SPN: HTTP/hosppdevsrv.ifl.net
    ↓
3. Active Directory: SPN NOT FOUND
    ↓
4. Kerberos authentication FAILS
    ↓
5. Falls back to NTLM authentication
    ↓
6. NTLM challenge/response triggers popup
    ↓
7. ❌ User sees Windows Authentication popup
```

---

## Why IP Address Worked But Hostname Didn't

This was the key clue that it was an SPN issue!

### IP Address: http://192.168.1.92:3333 ✅ (Worked)

```
Kerberos does NOT work with IP addresses (by design)
    ↓
Browser immediately uses NTLM (no Kerberos attempt)
    ↓
NTLM succeeds without popup (Intranet zone allows it)
    ↓
✅ NO POPUP!
```

### Hostname: http://hosppdevsrv.ifl.net:3333 ❌ (Failed before SPN fix)

```
Browser tries Kerberos first (hostname-based)
    ↓
SPN lookup fails (not registered)
    ↓
Kerberos FAILS
    ↓
Falls back to NTLM
    ↓
NTLM challenge triggers popup
    ↓
❌ POPUP SHOWN!
```

---

## The Solution

### Commands Used to Fix

```cmd
# Check if SPNs exist (they didn't)
setspn -Q HTTP/HOSPPDEVSRV
setspn -Q HTTP/HOSPPDEVSRV.IFL.NET

# Register SPNs to sppadmin application pool account
setspn -S HTTP/HOSPPDEVSRV ibrahim1_nt\sppadmin
setspn -S HTTP/HOSPPDEVSRV.IFL.NET ibrahim1_nt\sppadmin

# Restart IIS to apply changes
iisreset

# Verify SPNs are registered
setspn -L ibrahim1_nt\sppadmin
```

### Output After Fix

```
Registered ServicePrincipalNames for CN=SPP Admin,OU=Admin Accounts,DC=IFL,DC=NET:
        HTTP/HOSPPDEVSRV.IFL.NET     ← ADDED
        HTTP/HOSPPDEVSRV             ← ADDED
        MSSQLSvc/IGCPROJECT.IFL.NET:1433
        MSSQLSvc/IGCPROJECT.IFL.NET
        ... (many SQL Server SPNs)
```

---

## web.config Context

Our `web.config` uses the **Negotiate** provider, which tries Kerberos first:

```xml
<windowsAuthentication enabled="true" useKernelMode="false" useAppPoolCredentials="true">
    <providers>
        <clear />
        <add value="Negotiate" />  ← Tries Kerberos FIRST (requires SPNs)
        <add value="NTLM" />       ← Falls back to NTLM if Kerberos fails
    </providers>
    <extendedProtection tokenChecking="None" />
</windowsAuthentication>
```

**Key setting:** `useAppPoolCredentials="true"`
- IIS uses the **application pool identity** (sppadmin) to validate Kerberos tickets
- SPNs MUST be registered to **this account** (not the machine account)

---

## How to Diagnose SPN Issues

### Step 1: Check Application Pool Identity

```powershell
# In IIS Manager or PowerShell
Get-IISAppPool -Name "YourAppPoolName" | Select-Object Name, ProcessModel
```

For this app: **sppadmin** account

### Step 2: Check if SPNs Exist

```cmd
# Check for HTTP SPNs
setspn -Q HTTP/yourhostname
setspn -Q HTTP/yourhostname.domain.com

# Example for our app
setspn -Q HTTP/HOSPPDEVSRV
setspn -Q HTTP/HOSPPDEVSRV.IFL.NET
```

**If you see:** "No such SPN found" → **THIS IS THE PROBLEM**

### Step 3: Check What SPNs Are Registered to Account

```cmd
setspn -L domain\accountname

# Example for our app
setspn -L ibrahim1_nt\sppadmin
```

Look for HTTP SPNs matching your hostname.

### Step 4: Add Missing SPNs

```cmd
# Add SPN to account
setspn -S HTTP/hostname domain\account
setspn -S HTTP/hostname.domain.com domain\account

# Example for our app
setspn -S HTTP/HOSPPDEVSRV ibrahim1_nt\sppadmin
setspn -S HTTP/HOSPPDEVSRV.IFL.NET ibrahim1_nt\sppadmin
```

**Flags:**
- `-S` = Add SPN (checks for duplicates first, safe to use)
- `-A` = Add SPN (force, no duplicate check, can break things)
- `-Q` = Query for SPN
- `-L` = List SPNs for account

### Step 5: Restart IIS

```cmd
iisreset
```

### Step 6: Test

```
Open browser (close all windows first)
Navigate to: http://hostname.domain.com:3333/token.aspx
Expected: NO POPUP, immediate load
```

---

## Common SPN Issues

### Issue 1: Duplicate SPNs

**Symptom:** Kerberos fails even though SPN exists

**Cause:** Same SPN registered to multiple accounts

**Check:**
```cmd
setspn -X
```

**Fix:** Remove duplicate SPNs, keep only one registration

### Issue 2: Missing Port in SPN

**Important:** HTTP SPNs do NOT include port numbers!

**Correct:**
```
HTTP/hosppdevsrv.ifl.net         ✅ (no port)
HTTP/hosppdevsrv                 ✅ (no port)
```

**Incorrect:**
```
HTTP/hosppdevsrv.ifl.net:3333    ❌ (port included - WRONG!)
```

Kerberos uses only the hostname, not the port.

### Issue 3: Wrong Account

**Symptom:** SPN exists but Kerberos still fails

**Cause:** SPN registered to wrong account (machine vs. service account)

**Check:**
```cmd
# Find which account has the SPN
setspn -Q HTTP/hostname
```

**Fix:** Delete SPN from wrong account, add to correct account
```cmd
setspn -D HTTP/hostname wrongdomain\wrongaccount
setspn -S HTTP/hostname correctdomain\correctaccount
```

### Issue 4: useKernelMode=true (Machine Account)

If `web.config` has `useKernelMode="true"`:
- IIS uses **machine account** (HOSTNAME$) for Kerberos
- SPNs must be registered to **machine account**, not service account

Our config uses `useKernelMode="false"` and `useAppPoolCredentials="true"`:
- IIS uses **application pool account** (sppadmin)
- SPNs must be registered to **sppadmin**, not machine

---

## Testing Authentication Methods

### Check Which Auth Method is Used

**Windows Event Logs:**
- Event Viewer → Security
- Look for Event ID 4624 (Successful logon)
- **Logon Type 3** (Network logon)
- **Authentication Package:**
  - `Kerberos` = Kerberos authentication ✅
  - `NTLM` = NTLM authentication ⚠️

### Browser Developer Tools

**Chrome/Edge:**
1. F12 → Network tab
2. Navigate to site
3. Click on request → Headers
4. Look for `WWW-Authenticate` header:
   - `Negotiate` = Kerberos/NTLM negotiation
   - Response header shows which was used

### IIS Logs

**Check:** `C:\inetpub\logs\LogFiles\W3SVC1\`

**Successful Kerberos:**
```
cs-username: IBRAHIM1_NT\ISRARULHAQ
sc-status: 200
```

**Failed (NTLM with popup):**
```
cs-username: -
sc-status: 401
sc-substatus: 2
```

---

## Best Practices

### 1. Always Register Both Short and FQDN

```cmd
setspn -S HTTP/hostname domain\account
setspn -S HTTP/hostname.domain.com domain\account
```

Users might access via either name.

### 2. Use Managed Service Accounts (MSA) or Group Managed Service Accounts (gMSA)

Benefits:
- Automatic SPN management
- Automatic password rotation
- No manual SPN registration needed

### 3. Document Application Pool Accounts

Keep a record of:
- Application pool name
- Identity account
- Required SPNs
- Date registered

### 4. Monitor for SPN Conflicts

Regularly run:
```cmd
setspn -X
```

Duplicate SPNs break Kerberos for ALL affected services.

### 5. Use Descriptive Service Account Names

Good: `svc-iflworkflow`, `sppadmin`
Bad: `admin`, `user1`

---

## Checklist for New IIS Applications

When deploying a new IIS application with Windows Authentication:

- [ ] Create dedicated service account (or use gMSA)
- [ ] Assign service account to application pool
- [ ] Register HTTP SPNs to service account:
  - [ ] `HTTP/shortname`
  - [ ] `HTTP/fqdn.domain.com`
- [ ] Set web.config:
  - [ ] `useKernelMode="false"`
  - [ ] `useAppPoolCredentials="true"`
  - [ ] `<add value="Negotiate" />` before `<add value="NTLM" />`
- [ ] Run `iisreset`
- [ ] Test from client machine (not server)
- [ ] Verify NO popup appears
- [ ] Check Event Viewer for Kerberos logon (Event ID 4624)

---

## Related Files

- `web.config` - IIS Windows Authentication configuration
- `DIAGNOSTICS.md` - Authentication diagnostic tools
- `TROUBLESHOOTING_POPUP.md` - Windows Auth popup troubleshooting (needs update)
- `windows-auth-intranet-zone-issues.md` - Original troubleshooting (needs correction)
- `.claude/skills/sso-auth-guardian/` - SSO Auth Guardian skill (needs update)

---

## Key Takeaways

1. **SPNs are REQUIRED for Kerberos authentication**
   - Without SPNs, Kerberos fails silently
   - Falls back to NTLM (which may trigger popups)

2. **IP addresses never use Kerberos**
   - That's why IP address worked (pure NTLM)
   - Hostnames try Kerberos first (requires SPNs)

3. **Application pool account matters**
   - SPNs must match the account IIS uses
   - Check `useKernelMode` and `useAppPoolCredentials` settings

4. **HTTP SPNs don't include port numbers**
   - Only hostname is used
   - Works for all ports (80, 443, 3333, etc.)

5. **The Intranet zone theory was a red herring**
   - IP address worked because it bypassed Kerberos entirely
   - Hostname failed because Kerberos failed (missing SPN)
   - Intranet zone port matching was NOT the issue

---

**Resolution Date:** May 30, 2026
**Fixed By:** AD Admin (added HTTP SPNs to sppadmin account)
**Status:** ✅ WORKING - No popup on hostname access
**Auth Method:** Kerberos (via Negotiate provider)

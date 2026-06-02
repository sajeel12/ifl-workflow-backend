# Troubleshooting Windows Auth Popup Issues

## Your Current Issue

You're experiencing:
1. **Edge:** Persistent Windows Auth popup (even after entering credentials)
2. **Chrome:** "Unexpected token '<'" error in diagnostic tool

Both indicate **Windows Authentication is not configured properly**.

---

## Why This Happens

### The "Unexpected token '<'" Error
This means the server is returning **HTML** (an error page) instead of **JSON**.

**What's happening:**
```
Browser → Requests /api/diagnostics/auth or /token.aspx
         ↓
IIS sees request → Triggers Windows Auth (401 challenge)
         ↓
Browser doesn't have credentials → Shows popup
         ↓
Request fails → IIS returns HTML error page
         ↓
JavaScript tries to parse HTML as JSON → "Unexpected token '<'" error
```

### The Persistent Popup in Edge
Windows Authentication is challenging **every request**. Even after you enter credentials, the next request triggers another challenge.

**Possible causes:**
1. Windows Authentication not properly enabled in IIS
2. Accessing via IP address instead of hostname
3. Browser not sending credentials automatically
4. User account not in correct domain

---

## Step-by-Step Fix

### Step 1: Check How You're Accessing the Site

**WRONG:**
```
http://192.168.1.x:3333/diagnostics/auth-ui  ❌
http://localhost:3333/diagnostics/auth-ui    ❌
```

**CORRECT:**
```
http://hosppdevsrv:3333/diagnostics/auth-ui  ✅
```

**Why:** Windows Authentication only works with hostnames in the Intranet zone, not IP addresses.

**Fix:**
- Always use the hostname: `http://hosppdevsrv:3333`
- Add to hosts file if DNS doesn't resolve:
  ```
  # C:\Windows\System32\drivers\etc\hosts
  192.168.x.x  hosppdevsrv
  ```

---

### Step 2: Verify IIS Windows Authentication

1. Open **IIS Manager** on the server
2. Navigate to your site
3. Click **Authentication**
4. Check settings:

```
✅ Windows Authentication: ENABLED
✅ Anonymous Authentication: ENABLED (for static files)
❌ Forms Authentication: DISABLED
❌ Basic Authentication: DISABLED
```

5. Double-click **Windows Authentication** → **Providers**
6. Ensure order is:
   ```
   1. Negotiate (Kerberos/NTLM)
   2. NTLM
   ```

7. Click **Advanced Settings**:
   ```
   ✅ Extended Protection: Off (or Accept)
   ✅ Enable Kernel-mode authentication: Checked
   ```

---

### Step 3: Check IIS Application Pool

1. IIS Manager → **Application Pools**
2. Find your app pool → Right-click → **Advanced Settings**
3. Under **Process Model** → **Identity**:
   ```
   Should be: ApplicationPoolIdentity (default)
   OR: NetworkService
   OR: Specific domain account with AD read permissions
   ```

4. If using specific account, ensure it has:
   - Read access to Active Directory
   - Access to AD Global Catalog (HODCSRV19S.IFL.NET:3268)

---

### Step 4: Configure Browser Settings

#### Microsoft Edge

1. Go to **Settings** → **Privacy, search, and services**
2. Scroll down to **Security**
3. Click **Manage security keys**
4. Add `hosppdevsrv` to trusted sites

**OR**

1. Open **Internet Options** (Control Panel)
2. Go to **Security** tab
3. Click **Local intranet** → **Sites** → **Advanced**
4. Add: `http://hosppdevsrv:3333`
5. Click **OK**

#### Google Chrome

1. Close all Chrome windows
2. Open command prompt as Administrator
3. Run Chrome with auth whitelist:
   ```cmd
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --auth-server-whitelist="hosppdevsrv"
   ```

**OR**

1. Go to `chrome://policy`
2. Check if `AuthServerWhitelist` is set
3. If not, create registry key:
   ```reg
   Windows Registry Editor Version 5.00

   [HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Google\Chrome]
   "AuthServerWhitelist"="hosppdevsrv"
   ```

#### Firefox

1. Type `about:config` in address bar
2. Search for `network.automatic-ntlm-auth.trusted-uris`
3. Set value to: `http://hosppdevsrv:3333`
4. Restart Firefox

---

### Step 5: Check User Account & Domain

Open Command Prompt and run:
```cmd
whoami
```

**Expected output:**
```
IBRAHIM1_NT\your.username
```

**If it shows local computer name instead:**
```
COMPUTERNAME\username  ❌
```

Then your computer is NOT domain-joined. **Windows Authentication requires domain-joined computer.**

**To check domain:**
```cmd
echo %USERDOMAIN%
```

Should show: `IBRAHIM1_NT` or `IFL` (not your computer name)

**To check AD connectivity:**
```cmd
nltest /dsgetdc:ifl.net
```

Should return domain controller info.

---

### Step 6: Test Direct Access

#### Test 1: Access token.aspx directly

Open browser and go to:
```
http://hosppdevsrv:3333/token.aspx
```

**Expected result (success):**
```json
{
  "username": "your.username",
  "timestamp": 1735561200,
  "email": "your.email@ifl.com.pk",
  "displayName": "Your Name",
  "sig": "abc123..."
}
```

**If you get popup:** Windows Auth is not working
**If you get HTML error:** IIS or AD connection issue
**If you get 404:** token.aspx file missing in IIS

#### Test 2: Access diagnostics API directly

Open browser and go to:
```
http://hosppdevsrv:3333/api/diagnostics/auth
```

**Expected result:**
```json
{
  "overallStatus": "PARTIAL",
  "layers": {
    "browser": { "status": "PASS" },
    "iis": { "status": "FAIL" or "PASS" },
    ...
  }
}
```

**If you get popup:** Problem with Windows Auth
**If you get "Unexpected token '<'":** Server returned HTML error page

---

### Step 7: Check IIS Event Logs

1. Open **Event Viewer** (`eventvwr.msc`)
2. Navigate to **Windows Logs** → **Application**
3. Filter for:
   - Source: `IIS-Configuration`
   - Source: `ASP.NET`
   - Event ID: 1309 (Windows Auth failure)

Look for errors related to authentication.

---

### Step 8: Enable Detailed IIS Logging

1. IIS Manager → Your Site → **Logging**
2. Change **Format** to: **W3C**
3. Click **Select Fields** → Check:
   - `cs-username` (authenticated user)
   - `sc-status` (HTTP status code)
   - `sc-substatus` (detailed error code)
   - `sc-win32-status` (Windows error)

4. Reproduce the issue
5. Check logs at: `C:\inetpub\logs\LogFiles\W3SVC1\`

Look for:
```
GET /token.aspx - 401 2 5 (Access Denied - Auth Required)
GET /token.aspx username 200 0 0 (Success)
```

If you see continuous `401 2 5` even after entering credentials, Windows Auth is not accepting credentials.

---

## Quick Diagnostic Commands

Run these on the **IIS server**:

### Check IIS Authentication Settings
```powershell
Import-Module WebAdministration
Get-WebConfigurationProperty -Filter "/system.webServer/security/authentication/windowsAuthentication" -PSPath "IIS:\Sites\Default Web Site" -Name "enabled"
```

Should return: `True`

### Check App Pool Identity
```powershell
Get-IISAppPool | Select-Object Name, @{Name="Identity";Expression={$_.ProcessModel.IdentityType}}
```

### Check URL Rewrite Rules
```powershell
Get-WebConfiguration -Filter "system.webServer/rewrite/rules" -PSPath "IIS:\Sites\Default Web Site"
```

Should show rule proxying to `127.0.0.1:3000`

---

## Common Error Messages & Fixes

### "401.2 - Unauthorized: Access is denied due to server configuration"
**Cause:** Windows Authentication not enabled or user not in domain
**Fix:** Enable Windows Authentication in IIS, ensure domain-joined computer

### "401.1 - Unauthorized: Access is denied due to invalid credentials"
**Cause:** Credentials not accepted
**Fix:** Check user account, domain connectivity, ensure browser sending credentials

### "500 - Internal Server Error"
**Cause:** Server-side error (Node.js crash, IIS misconfiguration)
**Fix:** Check Node.js logs, check IIS event logs

### "Unexpected token '<', ..."
**Cause:** JavaScript trying to parse HTML as JSON
**Fix:** This means a request failed and returned an error page. Check which request failed (token.aspx or /api/diagnostics/auth) and fix that layer.

---

## Still Not Working?

If you've tried everything above and still have issues:

### Option 1: Use SSO_MODE=OPTIONAL (Development Only!)

**WARNING: Only for local development/debugging!**

Edit `.env` file:
```bash
# Temporarily disable SSO requirement
SSO_MODE=OPTIONAL

# Mock user for testing
SSO_MOCK_USERNAME=your.username
SSO_MOCK_EMAIL=your.email@ifl.com.pk
SSO_MOCK_DISPLAY=Your Name
```

Restart Node.js server. This will bypass Windows Auth temporarily so you can test other functionality.

**CRITICAL: Change back to PROD before deploying!**
```bash
SSO_MODE=PROD
```

### Option 2: Direct Node.js Access (Testing Only)

Temporarily access Node.js directly (bypassing IIS):
```
http://localhost:3000/diagnostics/auth-ui
```

This tests if Node.js works without IIS. If this works but IIS doesn't, the problem is in IIS configuration.

### Option 3: Check Firewall

Windows Firewall may be blocking:
```powershell
# Check if port 3333 is allowed
netsh advfirewall firewall show rule name="IIS"
```

Add rule if needed:
```powershell
netsh advfirewall firewall add rule name="IIS Port 3333" dir=in action=allow protocol=TCP localport=3333
```

---

## Summary Checklist

- [ ] Using hostname (not IP): `http://hosppdevsrv:3333`
- [ ] Windows Authentication ENABLED in IIS
- [ ] Anonymous Authentication ENABLED in IIS (for static files)
- [ ] Site added to browser's Intranet zone
- [ ] Computer is domain-joined
- [ ] User logged in with domain account
- [ ] token.aspx returns JSON (test directly)
- [ ] /api/diagnostics/auth returns JSON (test directly)
- [ ] IIS app pool has AD read permissions
- [ ] AD Global Catalog accessible (HODCSRV19S.IFL.NET:3268)
- [ ] No firewall blocking port 3333

If ALL boxes checked and still not working, there may be a deeper IIS/network/AD configuration issue requiring server admin assistance.

---

**Last Updated:** 2026-05-29

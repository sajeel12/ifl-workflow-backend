# Fix Edge Windows Authentication Popup Loop

## Your Current Situation

✅ **Chrome**: token.aspx works! Authentication IS working!
❌ **Edge**: Persistent popup asking for credentials (even after entering them correctly)

## Why This Happens in Edge

Edge is **stricter** about Intranet zone than Chrome. Your Intranet zone has:
```
http://192.168.1.92                ← IP address (don't use!)
http://hosppdevsrv.ifl.net         ← Full domain name
https://ciscoauth.ifl.net
https://ciscoauth.lhr.ifl.net
```

**Problem:** You're probably accessing via `http://hosppdevsrv:3333` but your Intranet zone has `http://hosppdevsrv.ifl.net` (with .ifl.net)

The **hostname doesn't match exactly**, so Edge treats it as untrusted → popup loop.

---

## 🔧 SOLUTION: Fix Intranet Zone URLs

### Option 1: Add Short Hostname with Port (RECOMMENDED)

1. Open **Internet Options** (Control Panel → Internet Options)
2. Go to **Security** tab
3. Click **Local intranet** → **Sites** → **Advanced**
4. **Add these URLs:**
   ```
   http://hosppdevsrv
   http://hosppdevsrv:3333
   http://hosppdevsrv.ifl.net
   http://hosppdevsrv.ifl.net:3333
   ```
5. **Remove this URL:**
   ```
   http://192.168.1.92   ← Remove! Don't use IP for Windows Auth
   ```
6. Click **OK** → **OK** → **OK**
7. **Close ALL Edge windows**
8. **Restart Edge**

### Option 2: Add Wildcard Pattern

1. Same steps as above, but add:
   ```
   http://*.ifl.net
   http://hosppdevsrv*
   ```

This will match any subdomain or port.

---

## 🎯 How to Access the Site

After fixing Intranet zone, access via:

### ✅ CORRECT URLs (These will work with SSO):
```
http://hosppdevsrv:3333/diagnostics/auth-ui
http://hosppdevsrv.ifl.net:3333/diagnostics/auth-ui
```

### ❌ WRONG URLs (Will cause popup):
```
http://192.168.1.92:3333/diagnostics/auth-ui     ← Don't use IP!
http://localhost:3333/diagnostics/auth-ui         ← Won't work
```

---

## 📝 Step-by-Step Test

After updating Intranet zone:

1. **Close ALL Edge windows** (very important!)
2. **Open new Edge window**
3. **Type in address bar:**
   ```
   http://hosppdevsrv:3333/test-auth.html
   ```
4. **Press Enter**

**Expected:** Page loads immediately with NO popup

**If popup appears:**
- Check the URL in address bar - is it exactly `hosppdevsrv:3333`?
- Check Internet Options → Local intranet → Sites → Advanced
- Verify `http://hosppdevsrv:3333` is in the list
- Try `http://hosppdevsrv.ifl.net:3333` instead

---

## 🔍 Verify Your Settings

### Check Current Intranet Zone Settings

1. Open **Registry Editor** (regedit)
2. Navigate to:
   ```
   HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Internet Settings\ZoneMap\Domains
   ```
3. Look for `hosppdevsrv` or `ifl.net` entries
4. Should see entries with value `1` (meaning Intranet zone)

### Check via PowerShell

```powershell
# Get all Intranet zone sites
Get-ChildItem "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings\ZoneMap\Domains" -Recurse | Where-Object {$_.Property -like "http*"} | ForEach-Object {
    $props = $_ | Get-ItemProperty
    $props.PSPath -replace ".*Domains\\", ""
    $props | Select-Object -Property http*
}
```

---

## 🎨 Alternative: Group Policy (For IT Admins)

If you're an IT admin and want to configure this for all users:

1. Open **Group Policy Management**
2. Create or edit GPO
3. Navigate to:
   ```
   User Configuration → Preferences → Windows Settings → Registry
   ```
4. Add registry items for Intranet zone sites
5. Apply to domain computers

---

## ⚡ Quick Fix for Testing

If you just want to test quickly without changing Intranet zone:

### Method 1: Use Chrome
Chrome is less strict. Just access:
```
http://hosppdevsrv:3333
```

Chrome will ask for credentials once, cache them, and then work.

### Method 2: Temporary SSO_MODE=OPTIONAL

**WARNING: Development only!**

Edit `W:\.env`:
```bash
SSO_MODE=OPTIONAL
```

Restart Node.js server. This bypasses Windows Auth temporarily.

**CRITICAL: Change back to PROD before going to production:**
```bash
SSO_MODE=PROD
```

---

## 🧪 Testing After Fix

### Test 1: Simple Page Load
```
http://hosppdevsrv:3333
```
**Expected:** No popup, shows "IFL Workflow Backend is Running"

### Test 2: token.aspx
```
http://hosppdevsrv:3333/token.aspx
```
**Expected:** No popup, shows JSON with your username

### Test 3: Full Diagnostic
```
http://hosppdevsrv:3333/diagnostics/auth-ui
```
**Expected:** No popup, diagnostic runs automatically

### Test 4: Portal
```
http://hosppdevsrv:3333/portal/it-ops
```
**Expected:** No popup, portal loads with your identity

---

## 📊 Understanding the Popup Behavior

### Normal SSO Flow (No Popup):
```
Edge → Accesses http://hosppdevsrv:3333
     ↓
Edge checks: Is hosppdevsrv:3333 in Intranet zone?
     ↓
YES → Edge automatically sends Windows credentials
     ↓
IIS receives credentials → Validates → Sets X-Auth-User header
     ↓
Node.js sees authenticated user → No 401
     ↓
✅ Page loads, NO POPUP!
```

### Broken Flow (Popup Loop):
```
Edge → Accesses http://hosppdevsrv:3333
     ↓
Edge checks: Is hosppdevsrv:3333 in Intranet zone?
     ↓
NO (hostname mismatch) → Edge does NOT send credentials automatically
     ↓
IIS challenges with 401
     ↓
Edge shows popup asking for credentials
     ↓
User enters credentials → Request succeeds
     ↓
Next request → Same problem → Popup again!
     ↓
❌ Infinite popup loop
```

---

## 🎯 Why Your Portal Works in Chrome but Not Edge

**Chrome:**
- You entered credentials once
- Chrome **cached** them
- Chrome automatically reuses cached credentials
- Works until you close browser or cache is cleared

**Edge:**
- More strict about Intranet zone
- Won't cache credentials for non-Intranet sites
- Challenges every request
- Requires exact hostname match in Intranet zone

---

## ✅ Final Checklist

After applying the fix:

- [ ] Added `http://hosppdevsrv:3333` to Local intranet zone
- [ ] Added `http://hosppdevsrv.ifl.net:3333` to Local intranet zone
- [ ] Removed `http://192.168.1.92` from Intranet zone (IPs don't work)
- [ ] Closed ALL Edge windows
- [ ] Restarted Edge
- [ ] Accessed via hostname (not IP)
- [ ] Computer is domain-joined (`whoami` shows IBRAHIM1_NT\...)
- [ ] Tested: `http://hosppdevsrv:3333` → No popup
- [ ] Tested: `http://hosppdevsrv:3333/token.aspx` → No popup
- [ ] Tested: `http://hosppdevsrv:3333/diagnostics/auth-ui` → No popup

---

## 🚨 If Still Not Working

1. **Check exact URL in address bar:**
   - Must be `hosppdevsrv:3333` or `hosppdevsrv.ifl.net:3333`
   - NOT `192.168.1.92:3333`
   - NOT any other variation

2. **Verify Intranet zone settings:**
   - Open Internet Options → Security → Local intranet → Sites → Advanced
   - Verify exact URL is listed

3. **Check browser cache:**
   - Edge → Settings → Privacy → Clear browsing data
   - Clear "Cached images and files" and "Cookies"
   - Restart Edge

4. **Test with InPrivate window:**
   - Edge → New InPrivate Window
   - Go to `http://hosppdevsrv:3333/test-auth.html`
   - Should still work without popup (InPrivate doesn't affect Intranet zone)

5. **Check Event Viewer logs:**
   - `eventvwr.msc` → Windows Logs → Application
   - Look for IIS or authentication errors

---

## 🎉 Success Indicators

When properly configured, you should see:

1. **No popup on any page** (portal, admin, diagnostics)
2. **token.aspx returns JSON immediately** (no popup)
3. **Diagnostics show all layers PASS**
4. **Edge behaves same as Chrome** (both work automatically)

---

**Last Updated:** 2026-05-29
**Status:** READY TO TEST

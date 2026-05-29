# SSO Authentication Diagnostics

This diagnostic tool helps identify which layer is causing Windows Authentication popup issues.

## Quick Start

### Option 1: Web UI (Recommended)

1. Open your browser and navigate to:
   ```
   http://hosppdevsrv:3333/diagnostics/auth-ui
   ```

2. Click "Run Diagnostics"

3. View results showing each authentication layer:
   - **✅ PASS** - Layer working correctly
   - **❌ FAIL** - Layer has problems (this is where the issue is!)
   - **⚠ WARN** - Layer has warnings
   - **SKIP** - Layer skipped (not applicable)

### Option 2: API Endpoint

Get JSON results programmatically:
```bash
curl http://hosppdevsrv:3333/diagnostics/auth
```

Or with sidecar token:
```bash
# Fetch token first
TOKEN=$(curl http://hosppdevsrv:3333/token.aspx)

# Run diagnostics with token
curl -H "x-sidecar-token: $TOKEN" http://hosppdevsrv:3333/diagnostics/auth
```

## Authentication Layers

The diagnostic tool tests 5 layers in order:

### Layer 1: BROWSER
**What it tests:**
- Can browser connect to Node.js?
- Is request reaching the server?
- What browser/user-agent?

**Common failures:**
- Network connectivity issues
- Firewall blocking connection
- Wrong URL/port

**How to fix:**
- Check network connection
- Verify URL: `http://hosppdevsrv:3333` (not IP)
- Check firewall rules

---

### Layer 2: IIS - Windows Authentication
**What it tests:**
- Is Windows Authentication enabled in IIS?
- Is `X-Auth-User` header set by IIS?
- What username is being passed?

**Common failures:**
- Windows Authentication not enabled in IIS
- X-Auth-User header missing
- User not domain-joined
- Accessing via IP instead of hostname

**How to fix:**
1. **IIS Configuration:**
   - Open IIS Manager
   - Select your site → Authentication
   - Enable "Windows Authentication"
   - Disable "Basic Authentication"

2. **Browser Settings:**
   - Use hostname: `http://hosppdevsrv:3333` (not `http://192.168.x.x:3333`)
   - Add site to Intranet zone (IE/Edge)
   - Chrome: Add to `--auth-server-whitelist`

3. **User Account:**
   - Ensure user is in domain (ifl.net)
   - Computer must be domain-joined
   - User logged in with domain credentials

**Expected Result:**
```json
{
  "layer": "IIS",
  "status": "PASS",
  "checks": {
    "hasXAuthUserHeader": true,
    "xAuthUserValue": "IBRAHIM1_NT\\israr.haq",
    "strippedUsername": "israr.haq"
  }
}
```

---

### Layer 3: token.aspx - HMAC Token Generation
**What it tests:**
- Can token.aspx be accessed?
- Does it return valid JSON?
- Does it query AD for email/displayName?
- Is HMAC signature present?

**Common failures:**
- token.aspx not accessible (404)
- AD query failing (no email/displayName)
- JSON parse error
- Missing signature field

**How to fix:**
1. **Test token.aspx directly:**
   ```
   http://hosppdevsrv:3333/token.aspx
   ```
   Should return:
   ```json
   {
     "username": "your.username",
     "timestamp": 1735561200,
     "email": "your.email@ifl.com.pk",
     "displayName": "Your Name",
     "sig": "abc123def456..."
   }
   ```

2. **If 404 Error:**
   - Check IIS has token.aspx file
   - Check IIS ASPX handler enabled

3. **If email/displayName missing:**
   - Check AD Global Catalog accessible
   - Check IIS app pool identity has AD read permissions
   - Verify GC server: HODCSRV19S.IFL.NET:3268

**Expected Result:**
```json
{
  "layer": "token.aspx",
  "status": "PASS",
  "checks": {
    "hasToken": true,
    "canParseJson": true,
    "hasUsername": true,
    "hasEmail": true,
    "hasDisplayName": true,
    "hasSignature": true,
    "tokenAge": 2
  }
}
```

---

### Layer 4: NETWORK - Loopback Trust
**What it tests:**
- Is request coming from loopback (127.0.0.1)?
- Should Node.js trust the X-Auth-User header?
- Is SSO_TRUST_PROXY_HEADER enabled?

**Common failures:**
- Request from non-loopback IP (accessing Node directly, not through IIS)
- SSO_TRUST_PROXY_HEADER set to false

**How to fix:**
1. **Ensure traffic goes through IIS:**
   - Users should access `http://hosppdevsrv:3333` (IIS)
   - IIS proxies to Node.js on 127.0.0.1:3000
   - Direct access to Node.js will show non-loopback IP

2. **Check .env configuration:**
   ```bash
   SSO_TRUST_PROXY_HEADER=true  # Must be true for IIS integration
   ```

3. **Verify IIS URL Rewrite:**
   - IIS → Your Site → URL Rewrite
   - Should have rule proxying to 127.0.0.1:3000

**Expected Result:**
```json
{
  "layer": "NETWORK",
  "status": "PASS",
  "checks": {
    "clientIp": "::ffff:127.0.0.1",
    "cleanIp": "127.0.0.1",
    "isLoopback": true,
    "trustProxyHeaderEnabled": true,
    "canTrustXAuthUser": true
  }
}
```

---

### Layer 5: NODE.JS - HMAC Validation
**What it tests:**
- Is token age within 5-minute window?
- Does HMAC signature match?
- Does SSO_SHARED_SECRET match web.config?
- Is signature v1 or v2 format?

**Common failures:**
- Token expired (>5 minutes old)
- Invalid HMAC signature (secret mismatch)
- SSO_SHARED_SECRET doesn't match web.config SsoSharedSecret

**How to fix:**
1. **Token Age Issue:**
   - This is expected if token >5 minutes old
   - User should refresh page or click link again
   - For development: Can temporarily increase window in ssoMiddleware.js

2. **Secret Mismatch - CRITICAL:**
   ```bash
   # Check .env
   grep SSO_SHARED_SECRET .env
   # Should show: SSO_SHARED_SECRET=IFL_WORKFLOW_SECRET_KEY_2025

   # Check web.config
   grep SsoSharedSecret web.config
   # Should show: <add key="SsoSharedSecret" value="IFL_WORKFLOW_SECRET_KEY_2025" />
   ```

   **If they don't match:**
   - Update one to match the other
   - Restart Node.js server
   - Restart IIS app pool

3. **Signature Version:**
   - v2 is current (includes email + displayName)
   - v1 is legacy (username + timestamp only)
   - Both are supported for backward compatibility

**Expected Result:**
```json
{
  "layer": "NODE.JS",
  "status": "PASS",
  "checks": {
    "tokenAge": 3,
    "tokenExpired": false,
    "maxAge": 300,
    "signatureValid": true,
    "signatureVersion": "v2"
  }
}
```

---

## Interpreting Results

### All Layers PASS ✅
```
✓ All authentication layers working correctly
```
**Meaning:** SSO is working perfectly. If users still see popups, it's likely:
- Browser security settings (not sending credentials)
- Accessing via IP instead of hostname
- Specific route returning 401 instead of 403

### IIS Layer FAIL ❌
```
❌ FAILED: X-Auth-User header missing
```
**Problem:** Windows Authentication not working in IIS
**Fix:** Enable Windows Authentication in IIS Manager

### token.aspx Layer FAIL ❌
```
❌ FAILED: Token exists but JSON parse failed
```
**Problem:** token.aspx not generating valid token
**Fix:** Check token.aspx directly, verify AD access

### NODE.JS Layer FAIL ❌
```
❌ FAILED: Invalid HMAC signature
```
**Problem:** Secret mismatch between .env and web.config
**Fix:** Ensure SSO_SHARED_SECRET matches in both files

---

## Log Output

The diagnostic tool logs detailed information to console:

```
=== SSO DIAGNOSTICS START ===
Request URL: /diagnostics/auth
Request Method: GET
Request IP: ::ffff:127.0.0.1

[LAYER 1: BROWSER]
✓ Browser connected
  User-Agent: Mozilla/5.0...

[LAYER 2: IIS - Windows Authentication]
✓ Windows Auth working
  Raw header: IBRAHIM1_NT\israr.haq
  Stripped username: israr.haq

[LAYER 3: token.aspx - HMAC Token]
✓ token.aspx working
  Username: israr.haq
  Email: israr.haq@ifl.com.pk
  Display Name: Israr Ul Haq
  Token Age (seconds): 3

[LAYER 4: NETWORK - Loopback Trust]
✓ Request from loopback
  Client IP: ::ffff:127.0.0.1
  X-Auth-User trusted: true

[LAYER 5: NODE.JS - HMAC Validation]
✓ HMAC validation passed
  Signature version: v2
  Token age: 3 seconds

=== OVERALL STATUS ===
✓ All authentication layers working correctly
=== SSO DIAGNOSTICS END ===
```

---

## Common Scenarios

### Scenario 1: Popup on Admin Panel
**Symptoms:** Popup appears when accessing /admin/*

**Likely Layer:** NODE.JS or route-specific issue

**Diagnosis:**
1. Run diagnostics - if all PASS, issue is route-specific
2. Check if admin route returns 401 (should be 403)
3. Search code: `grep -rn "status(401)" src/routes/admin.js`

**Fix:** Change 401 to 403 in admin routes

---

### Scenario 2: Popup on File Upload
**Symptoms:** Popup when uploading files

**Likely Layer:** Route configuration issue (multer order)

**Diagnosis:**
1. Run diagnostics - likely all PASS
2. Check route middleware order
3. Ensure multer runs BEFORE ssoMiddleware

**Fix:** Reorder middleware in route definition

---

### Scenario 3: Popup After 5 Minutes
**Symptoms:** Works initially, popup after being idle

**Likely Layer:** NODE.JS (token age)

**Diagnosis:**
1. Run diagnostics - NODE.JS will show "tokenExpired: true"
2. Check tokenAge > 300 seconds

**Expected:** This is normal security behavior

**Fix:** User refreshes page or clicks link again

---

### Scenario 4: Popup for Specific Users
**Symptoms:** Works for some users, not others

**Likely Layer:** IIS (Windows Auth)

**Diagnosis:**
1. Run diagnostics AS THAT USER
2. Check if X-Auth-User header present
3. Verify user in correct domain

**Fix:**
- Ensure user account in ifl.net domain
- Computer must be domain-joined
- User logged in with domain credentials

---

## Emergency Debugging

If diagnostics don't help, enable detailed logging:

### 1. Add Logging to ssoMiddleware
Edit `src/middleware/ssoMiddleware.js`:
```javascript
function ssoMiddleware(req, res, next) {
    console.log('[SSO DEBUG]', {
        url: req.url,
        method: req.method,
        ip: req.socket?.remoteAddress,
        xAuthUser: req.headers['x-auth-user'],
        hasSidecarToken: !!req.headers['x-sidecar-token']
    });
    // ... rest of code
}
```

### 2. Enable IIS Failed Request Tracing
1. IIS Manager → Your Site → Failed Request Tracing
2. Add rule for Status Code: 401
3. Reproduce issue
4. Check logs in `C:\inetpub\logs\FailedReqLogFiles`

### 3. Temporary OPTIONAL Mode (Development Only)
```bash
# .env - DO NOT USE IN PRODUCTION!
SSO_MODE=OPTIONAL
SSO_MOCK_USERNAME=your.username
SSO_MOCK_EMAIL=your.email@ifl.com.pk
```

This bypasses Windows Auth for testing.

---

## Support

If issue persists after running diagnostics:

1. Take screenshot of diagnostic results
2. Copy console log output
3. Note which layer(s) are failing
4. Check IIS Event Viewer: `eventvwr.msc` → Windows Logs → Application
5. Use SSO Auth Guardian skill: `/sso-auth-guardian`

---

**Created:** 2026-05-29
**Version:** 1.0

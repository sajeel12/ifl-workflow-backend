# Authentication Patterns Explained

**Date:** May 29, 2026
**Key Insight:** Why X-Auth-User "failing" is actually CORRECT for our app

---

## The Question That Led to This Discovery

> "When SSO works fine for the IP address, why is X-Auth-User even required from browser? It's failing anyway but everything still works!"

**Answer:** X-Auth-User is NOT required for the sidecar token pattern. You were absolutely right!

---

## Two Different Authentication Patterns

### Pattern A: X-Auth-User (Direct Browser Navigation)

**When it's used:**
- User clicks a link that navigates directly to a page
- Browser sends credentials automatically (Windows Auth)
- Example: Clicking a link to `/portal/it-ops`

**Flow:**
```
Browser navigates → http://hosppdevsrv.ifl.net/portal/it-ops
    ↓
IIS receives request with Windows credentials
    ↓
IIS authenticates user, sets X-Auth-User header
    ↓
Proxy forwards to Node.js with X-Auth-User: DOMAIN\USERNAME
    ↓
Node.js reads username from X-Auth-User header
    ↓
✅ Page loads with user identity
```

**Characteristics:**
- Works for full page navigations
- IIS authenticates on every request
- Simple but limited (can't add custom headers to link clicks)

---

### Pattern B: Sidecar Token (AJAX/Fetch) ← **USED BY THIS APP**

**When it's used:**
- JavaScript makes API calls
- Need to add custom data to requests
- Example: All API endpoints like `/api/onboarding/initiate`

**Flow:**
```
STEP 1: Initial page load
Browser navigates → http://192.168.1.92:3333/diagnostics/auth-ui
    ↓
IIS → Node.js (NO X-Auth-User needed, just serving HTML file)
    ↓
HTML page loads
    ↓
Result: IIS layer shows "FAIL" or "EXPECTED" ← THIS IS NORMAL!

STEP 2: JavaScript fetches sidecar token
JavaScript runs: fetch('/token.aspx')
    ↓
Browser AUTO-SENDS Windows credentials to token.aspx
    ↓
IIS authenticates user (Windows Auth happens HERE!)
    ↓
token.aspx reads User.Identity.Name from Windows identity
    ↓
token.aspx looks up user in Active Directory (email, display name)
    ↓
token.aspx generates HMAC signature:
  signature = HMAC-SHA256(username|timestamp|email|displayName, SECRET)
    ↓
Returns: {
  username: "israrulhaq",
  email: "israr.haq@igc.com.pk",
  displayName: "Israr Ul Haq",
  timestamp: 1748539200,
  signature: "a1b2c3d4..."
}
    ↓
Result: token.aspx layer shows "PASS" ← AUTH SUCCEEDS!

STEP 3: JavaScript makes API calls with token
fetch('/api/onboarding/initiate', {
  method: 'POST',
  body: JSON.stringify({
    'x-sidecar-token': tokenFromStep2,
    // ... other data
  })
})
    ↓
Node.js receives request with token in body
    ↓
Node.js validates HMAC signature (timing-safe comparison)
    ↓
Reconstructs: HMAC-SHA256(username|timestamp|email|displayName, SECRET)
    ↓
Compares with provided signature using crypto.timingSafeEqual()
    ↓
Checks token age (must be < 5 minutes old)
    ↓
Extracts user identity from validated token
    ↓
Result: Node.js layer shows "PASS" ← COMPLETE!
```

**Characteristics:**
- X-Auth-User is NOT set on initial HTML load (normal!)
- Authentication happens when JavaScript fetches token.aspx
- Token is valid for 5 minutes, reusable across requests
- More secure (HMAC prevents tampering)
- Flexible (can add custom data to requests)

---

## Why This Matters for Diagnostics

### OLD Diagnostic Output (Confusing)
```
IIS Layer: ❌ FAIL
  Message: X-Auth-User header missing. Windows Authentication
           may not be enabled in IIS.
```
**Problem:** Makes it look like something is broken!

### NEW Diagnostic Output (Clear)
```
IIS Layer: ⚠️ EXPECTED
  Message: X-Auth-User not set (using sidecar token pattern).
           This is normal for initial page load and AJAX requests.
           Authentication happens in token.aspx layer instead.
```
**Better:** Explains this is expected behavior!

---

## Key Takeaways

1. **IIS layer showing "EXPECTED" is NORMAL and CORRECT**
   - Initial HTML page loads don't need X-Auth-User
   - Just serving a static file, no auth required

2. **Authentication happens in token.aspx layer**
   - Browser sends Windows credentials to token.aspx
   - token.aspx generates HMAC-signed token
   - This is where Windows Auth actually happens!

3. **Node.js validates the HMAC signature**
   - No need for X-Auth-User header
   - Token includes all user identity (username, email, display name)
   - Signature proves it came from token.aspx (has shared secret)

4. **This pattern is MORE secure than X-Auth-User alone**
   - HMAC signature prevents token tampering
   - Token age validation (5 minutes)
   - Timing-safe comparison prevents timing attacks
   - Works for AJAX/fetch requests where we can't control headers

---

## When Each Pattern is Used in This App

### Portal Routes (Both patterns)
- Initial load: `GET /portal/it-ops` → Uses Pattern B (serves HTML)
- Authentication: JavaScript fetches `/token.aspx` → Windows Auth
- Session token: Portal creates 8-hour session token
- API calls: Use portal session token (not sidecar token)

### API Routes (Pattern B only)
- All `/api/*` routes use sidecar token pattern
- File uploads: Multer parses body → ssoMiddleware validates token
- Request tokens: Special tokens for approval actions

### Admin Routes (Both patterns possible)
- Can use either X-Auth-User or sidecar token
- Always return 403 (not 401) to prevent IIS popup loops

---

## Conclusion

Your observation was **100% correct**: When SSO works fine with the IP address, the X-Auth-User header "failing" is expected and normal for the sidecar token pattern.

The diagnostic has been updated to show this as "EXPECTED" status instead of "FAIL" to avoid confusion.

Authentication happens in the **token.aspx layer**, not the IIS layer, for this application.

---

**Related Files:**
- `src/controllers/diagnosticsController.js` - Updated with EXPECTED status
- `src/middleware/ssoMiddleware.js` - Sidecar token validation
- `token.aspx` - HMAC token generation
- `DIAGNOSTICS.md` - Diagnostic tool documentation

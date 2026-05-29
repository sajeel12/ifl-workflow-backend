---
name: sso-auth-guardian
description: Verify SSO, session management, and authentication middleware implementation. Use when adding routes, modifying auth code, reviewing security, or auditing authentication compliance.
---

# SSO & Authentication Guardian

This skill audits and enforces authentication rules for the IFL Workflow application, ensuring all code follows established SSO, session management, and security patterns.

## When to Use This Skill

- Before adding new API routes or endpoints
- When modifying authentication or authorization code
- Before code reviews or production deployments
- When adding new portal roles or workflow stages
- Periodically to audit authentication compliance
- When investigating authentication issues or security concerns
- When troubleshooting Windows Authentication popup issues
- When verifying SSO configuration and Intranet zone settings

## Instructions

### Step 1: Understand the Request Context

Identify what the user wants to verify or build:
- New route/endpoint being added?
- Authentication code being modified?
- General security audit requested?
- New portal role or workflow stage?
- Investigating an auth issue?

### Step 2: Run Authentication Audit

Perform a comprehensive audit of the current authentication implementation:

1. **Verify SSO Middleware Usage**
   - Check all routes in `src/routes/api.js`, `src/routes/admin.js`, `src/routes/portal.js`
   - Identify which routes use `ssoMiddleware`
   - Flag routes that should be protected but aren't
   - Verify public routes are intentionally public

2. **Validate Admin Route Protection**
   - Ensure all `/admin/*` routes use `adminPageGuard` (for HTML) or `adminApiGuard` (for JSON APIs)
   - Verify NO admin routes return 401 (must return 403 to prevent IIS popup loops)
   - Check admin authorization uses ADMIN_USERS or ADMIN_EMAILS from environment

3. **Check Portal Authentication Flow**
   - Verify portal routes DO NOT use ssoMiddleware (they read X-Auth-User directly)
   - Confirm portal session tokens are validated in `/portal/:roleSlug/view`
   - Check portal token issuance uses `portalTokenService.issueToken()`
   - Validate 8-hour session expiration is enforced

4. **Verify Request Token Authentication**
   - Check approval/action routes validate `currentStageToken`
   - Ensure tokens are single-use (cleared after action)
   - Verify requester email matches `currentStageAssigneeEmail`
   - Confirm new tokens are generated for next workflow stage

5. **Validate File Upload Routes**
   - CRITICAL: Ensure multer runs BEFORE ssoMiddleware on all upload routes
   - Check route order: `upload.array()` → `ssoMiddleware` → controller
   - Flag any upload routes where ssoMiddleware runs first

6. **Check Security Pattern Compliance**
   - Verify HMAC token validation uses timing-safe comparison
   - Check 5-minute token age validation is enforced
   - Ensure loopback-only proxy header trust (127.0.0.1/::1)
   - Validate domain prefix stripping on all identity sources
   - Check both v1 and v2 HMAC signatures are supported

### Step 2.5: Windows Authentication & Intranet Zone Diagnostics

**CRITICAL CONTEXT (as of May 29, 2026):**
- ✅ **SSO works perfectly with IP address:** `http://192.168.1.92:3333` (no popup)
- ❌ **SSO fails with hostname:** `http://hosppdevsrv.ifl.net:3333` (shows popup)
- 🔧 **Pending fix:** AD admin needs to add port 3333 to Group Policy Intranet zone
- 📋 **Root cause:** Hostname with custom port not in Windows Intranet zone

When troubleshooting Windows Authentication popup issues:

1. **Use Built-in Diagnostic Tools**
   - Navigate to: `http://192.168.1.92:3333/diagnostics/auth-ui`
   - Click "Run Diagnostics" - tests all 5 authentication layers
   - Check simple test: `http://192.168.1.92:3333/test-auth.html`
   - Review troubleshooting guide: `http://192.168.1.92:3333/fix-windows-auth.html`

2. **Verify Intranet Zone Configuration**
   ```powershell
   # Check if hostname+port is in Intranet zone (Group Policy)
   Get-ItemProperty -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows\CurrentVersion\Internet Settings\ZoneMap\Domains\ifl.net\hosppdevsrv"

   # Check if IP range is in Intranet zone
   Get-ItemProperty -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows\CurrentVersion\Internet Settings\ZoneMap\Ranges\Range1"

   # Force Group Policy update
   gpupdate /force
   ```

3. **Understand Port Matching Rules**
   - **Domain entries** (e.g., `hosppdevsrv.ifl.net`) ONLY match default ports (80/443)
   - **IP ranges** (e.g., `192.168.1.92`) match ALL ports
   - Custom ports like `:3333` require explicit registry entries
   - Entry needed: `HKLM:\...\ZoneMap\Domains\ifl.net\hosppdevsrv` with property `3333 = 1`

4. **Check IIS Logs for Authentication Patterns**
   - Look for `401 2 5` (browser didn't send credentials)
   - Look for `401 1 2148074254` (SEC_E_NO_CREDENTIALS)
   - Success shows username in `cs-username` column (e.g., `IBRAHIM1_NT\ISRARULHAQ`)
   - If `cs-username` is empty (`-`), browser is not auto-sending credentials

5. **Verify Browser Configuration**
   - Chrome/Edge policy: `chrome://policy` → Search for `AuthServerWhitelist`
   - IE settings: Internet Options → Security → Local intranet → Sites → Advanced
   - Automatic logon setting: Must be "Automatic logon with current user name and password"

6. **Common Workarounds**
   - **Immediate:** Use IP address `http://192.168.1.92:3333` (works now)
   - **Short-term:** Ask AD admin to add hostname:port to Group Policy
   - **Long-term:** Move site to port 80 (no port matching issues)

7. **Diagnostic Layer Analysis**
   - **BROWSER:** Can connect and send requests
   - **IIS:** Windows Authentication enabled, X-Auth-User header set
   - **token.aspx:** HMAC token generation with AD lookup
   - **NETWORK:** Loopback trust for proxy headers
   - **NODE.JS:** HMAC signature validation (timing-safe)

   **Expected behavior:** IIS layer may show "FAIL" for initial HTML page load (no X-Auth-User), but token.aspx should succeed. This is normal - sidecar token pattern handles authentication.

### Step 3: Identify Violations and Risks

Compare current implementation against established patterns:

**CRITICAL VIOLATIONS (Fix Immediately):**
- Admin routes returning 401 instead of 403
- ssoMiddleware running before multer on file uploads
- Portal routes using ssoMiddleware (breaks IIS proxy flow)
- HMAC validation not using timing-safe comparison
- Proxy headers trusted from non-loopback IPs

**HIGH PRIORITY:**
- Protected routes missing ssoMiddleware
- Token validation missing email match check
- Session tokens not being validated on protected pages
- Missing token age checks (5-minute window)

**MEDIUM PRIORITY:**
- Inconsistent domain stripping on identity fields
- Missing support for v1/v2 HMAC signatures
- Email-only matching without username fallback
- Missing location-aware authorization for IT_OPS/HR_INITIATOR roles

**LOW PRIORITY:**
- Inconsistent error messages on auth failures
- Missing audit logging on auth events
- Suboptimal session cleanup intervals

### Step 4: Review New Code Changes

If the user is adding or modifying code, verify:

1. **New API Routes Checklist:**
   - [ ] Route uses `ssoMiddleware` if it needs authentication
   - [ ] Public routes are intentionally public (health checks, lookups, etc.)
   - [ ] Admin routes use `adminPageGuard` or `adminApiGuard` (never return 401)
   - [ ] File upload routes have multer BEFORE ssoMiddleware
   - [ ] Token-based approval routes validate token AND requester email
   - [ ] Portal routes DO NOT use ssoMiddleware

2. **New Portal Role Checklist:**
   - [ ] Role added to ROLE_SLUGS mapping in `portalController.js`
   - [ ] WorkflowApproverConfig table has row for new role
   - [ ] Location-aware roles have WorkflowApproverLocationOverride support
   - [ ] Email workflow templates include new role recipient
   - [ ] Portal loading page includes role slug in allowed list
   - [ ] Dashboard view filters requests by role's workflow stage

3. **Authentication Code Changes Checklist:**
   - [ ] HMAC validation uses `crypto.timingSafeEqual()`
   - [ ] Token age check validates 5-minute window
   - [ ] Both v1 and v2 HMAC signatures are supported
   - [ ] Proxy header trust restricted to loopback IPs
   - [ ] Domain prefixes stripped from all identity sources
   - [ ] SSO_SHARED_SECRET matches web.config SsoSharedSecret

4. **Session Management Changes Checklist:**
   - [ ] Portal sessions expire after 8 hours
   - [ ] Session tokens are UUIDs (crypto.randomUUID())
   - [ ] Session validation checks expiration timestamp
   - [ ] Expired sessions redirect to portal login with `?expired=1`
   - [ ] Session cleanup runs hourly to prune expired tokens

### Step 5: Verify Environment Configuration

Check that required environment variables are properly configured:

**Required SSO Variables:**
```bash
SSO_MODE=PROD                              # Never MOCK in production
SSO_SHARED_SECRET=<matches web.config>     # Must match SsoSharedSecret
SSO_TRUST_PROXY_HEADER=true               # Required for IIS integration
```

**Required Admin Variables:**
```bash
ADMIN_USERS=user1,user2                    # Comma-separated AD usernames
ADMIN_EMAILS=user1@domain.com,user2@...    # Legacy fallback
```

**Development/Testing Variables:**
```bash
SSO_MODE=OPTIONAL                          # For local dev only
SSO_MOCK_USERNAME=dev.user
SSO_MOCK_EMAIL=dev.user@ifl.com.pk
SSO_MOCK_DISPLAY=Dev User
```

**Validation Steps:**
1. Read `.env` file and verify all required variables are set
2. Check `web.config` to ensure SsoSharedSecret matches SSO_SHARED_SECRET
3. Verify SSO_MODE is PROD in production environments
4. Validate ADMIN_USERS list includes current admin usernames

### Step 6: Generate Compliance Report

Create a comprehensive report with:

1. **Authentication Architecture Summary**
   - SSO provider and integration method
   - Session management approach (portal vs request tokens)
   - Middleware usage breakdown by route type

2. **Route Protection Analysis**
   - Total routes: X
   - SSO-protected routes: Y
   - Public routes: Z
   - Admin routes: W
   - Token-based routes: V

3. **Security Pattern Compliance**
   - HMAC validation: ✓/✗
   - Timing-safe comparison: ✓/✗
   - Token age validation: ✓/✗
   - Loopback-only proxy trust: ✓/✗
   - Domain normalization: ✓/✗

4. **Identified Issues**
   - Critical: [list]
   - High Priority: [list]
   - Medium Priority: [list]
   - Low Priority: [list]

5. **Recommendations**
   - Immediate fixes required
   - Security improvements suggested
   - Code refactoring opportunities

### Step 7: Provide Actionable Guidance

For each violation or issue found:

1. **Explain the Risk**: Why this pattern matters for security
2. **Show the Fix**: Provide exact code changes needed
3. **Reference Pattern**: Point to existing correct implementation
4. **Test Validation**: Suggest how to verify the fix works

Example:
```
ISSUE: Route /api/onboarding/upload-proof has ssoMiddleware before multer

RISK: When ssoMiddleware runs first on multipart requests, req.body is empty,
so it can't read x-sidecar-token from the body. This causes 401 errors, which
IIS intercepts and triggers Windows Auth popup loops.

FIX: Move multer before ssoMiddleware:
router.post('/onboarding/upload-proof',
    upload.array('dciProof', 5),    // MUST be first
    ssoMiddleware,                  // THEN validate auth
    onboardingController.handleProofUpload
);

REFERENCE: See src/routes/api.js line 42 (correct pattern)

TEST: Upload a file via the portal and verify no 401 popup appears.
```

### Step 8: Future-Proof Recommendations

Suggest improvements for long-term maintainability:

1. **Centralized Route Registry**
   - Create a route configuration file that declares auth requirements
   - Automatically apply middleware based on route metadata
   - Easier to audit and catch missing middleware

2. **Automated Testing**
   - Add integration tests for auth flows (see `tests/sso-middleware.audit.test.js`)
   - Test both portal and token-based authentication
   - Verify 401/403 behavior on protected routes

3. **Documentation**
   - Maintain authentication architecture doc (like the summary from exploration)
   - Document security patterns in code comments
   - Create developer onboarding guide for auth flows

4. **Monitoring & Logging**
   - Log all authentication events (success, failure, token validation)
   - Track session creation and expiration
   - Alert on suspicious patterns (high failure rates, token reuse attempts)

5. **Session Store Migration**
   - Current in-memory sessions are lost on server restart
   - Consider Redis or database-backed session store for production
   - Enables horizontal scaling and session persistence

## Key Security Patterns Reference

### Pattern 1: HMAC Token Validation
```javascript
// ALWAYS use timing-safe comparison
const computedHmac = crypto.createHmac('sha256', SSO_SHARED_SECRET)
    .update(signingData)
    .digest('hex');

const providedBuffer = Buffer.from(providedHmac, 'hex');
const computedBuffer = Buffer.from(computedHmac, 'hex');

if (!crypto.timingSafeEqual(providedBuffer, computedBuffer)) {
    throw new Error('Invalid signature');
}
```

### Pattern 2: Loopback-Only Proxy Trust
```javascript
function isLoopback(req) {
    const ip = (req.socket && req.socket.remoteAddress) || '';
    const clean = ip.replace(/^::ffff:/, '');
    return clean === '127.0.0.1' || clean === '::1' || clean === 'localhost';
}

// Only trust X-Auth-User header from loopback
if (SSO_TRUST_PROXY_HEADER && isLoopback(req)) {
    username = req.headers['x-auth-user'];
}
```

### Pattern 3: No 401 on Admin Routes
```javascript
// BAD: Returns 401, triggers IIS popup
if (!isAdmin) {
    return res.status(401).json({ error: 'Unauthorized' });
}

// GOOD: Returns 403, no IIS interference
if (!isAdmin) {
    return res.status(403).json({ error: 'Forbidden - admin access required' });
}
```

### Pattern 4: Multer Before ssoMiddleware
```javascript
// BAD: ssoMiddleware can't read req.body on multipart
router.post('/upload', ssoMiddleware, upload.array('files'), handler);

// GOOD: multer parses body first, then ssoMiddleware reads it
router.post('/upload', upload.array('files'), ssoMiddleware, handler);
```

### Pattern 5: Portal Session Validation
```javascript
// Always validate session exists, hasn't expired, and role matches
const session = portalTokenService.validateToken(req.query.token || '');
if (!session || session.roleKey !== expectedRoleKey) {
    return res.redirect(`/portal/${roleSlug}?expired=1`);
}

// Check expiration
if (Date.now() > session.expiresAt) {
    return res.redirect(`/portal/${roleSlug}?expired=1`);
}
```

### Pattern 6: Request Token Single-Use
```javascript
// Validate token matches request
const request = await OnboardingRequest.findOne({
    where: { currentStageToken: token }
});

if (!request) {
    return res.status(404).json({ error: 'Invalid or expired token' });
}

// Validate requester email matches
if (req.user.email !== request.currentStageAssigneeEmail) {
    return res.status(403).json({ error: 'Token not assigned to you' });
}

// Process action...

// Clear token after use (single-use pattern)
await request.update({ currentStageToken: null });
```

## Critical Files to Monitor

When reviewing changes, pay special attention to these files:

**Authentication Core:**
- `src/middleware/ssoMiddleware.js` - Primary SSO validation
- `src/middleware/adminMiddleware.js` - Admin guards (3 variants)
- `src/services/portalTokenService.js` - Portal session management

**Route Definitions:**
- `src/routes/api.js` - API endpoints with mixed auth requirements
- `src/routes/admin.js` - Admin panel routes (must never return 401)
- `src/routes/portal.js` - Portal entry points (no ssoMiddleware)
- `src/routes/diagnostics.js` - Authentication diagnostic endpoints (added May 29, 2026)

**Configuration:**
- `web.config` - IIS integration, must match SSO_SHARED_SECRET
- `.env` - Environment variables for SSO, admin users
- `server.js` - Secret sync validation on startup

**Controllers:**
- `src/controllers/portalController.js` - Portal auth flow, session issuance
- `src/controllers/onboardingController.js` - Request token validation
- `src/controllers/approvalController.js` - Token-based approvals
- `src/controllers/diagnosticsController.js` - 5-layer auth diagnostics (added May 29, 2026)

**Diagnostic & Troubleshooting Tools:**
- `public/test-auth.html` - Simple auth test page
- `public/fix-windows-auth.html` - Browser-based troubleshooting guide
- `DIAGNOSTICS.md` - Diagnostic tool documentation
- `TROUBLESHOOTING_POPUP.md` - Windows Auth popup troubleshooting
- `EDGE_POPUP_FIX.md` - Edge-specific SSO fixes
- `NEXT_STEPS.md` - Step-by-step fix instructions

## Output Format

When running this skill, provide:

1. **Executive Summary** (2-3 sentences)
2. **Authentication Status** (compliant/issues found)
3. **Critical Issues** (if any, with immediate fixes)
4. **Detailed Findings** (organized by severity)
5. **Code Examples** (for any fixes needed)
6. **Verification Steps** (how to test fixes)
7. **Future Recommendations** (optional improvements)

Keep the tone professional, technical, and actionable. Focus on security and correctness.

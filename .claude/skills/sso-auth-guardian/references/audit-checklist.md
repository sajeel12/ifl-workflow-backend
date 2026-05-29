# SSO & Authentication Audit Checklist

Use this checklist to quickly audit authentication compliance across the codebase.

## 🔐 SSO Middleware Validation

### Core Middleware (src/middleware/ssoMiddleware.js)

- [ ] HMAC validation uses `crypto.timingSafeEqual()` (timing-safe comparison)
- [ ] Token age check validates 5-minute window (300 seconds max)
- [ ] Both v1 and v2 HMAC signatures are supported for backward compatibility
- [ ] Proxy header trust restricted to loopback IPs (127.0.0.1, ::1)
- [ ] Domain prefixes stripped from all identity sources
- [ ] SSO_SHARED_SECRET matches web.config SsoSharedSecret
- [ ] Three auth modes supported: sidecar token → proxy header → mock/optional
- [ ] Mock mode only active when SSO_MODE=MOCK or SSO_MODE=OPTIONAL

### Admin Middleware (src/middleware/adminMiddleware.js)

- [ ] `adminPageGuard` reads X-Auth-User header directly (no ssoMiddleware dependency)
- [ ] `adminApiGuard` validates sidecar token OR proxy header
- [ ] Both guards return 403 (never 401) to prevent IIS popup loops
- [ ] Admin username list loaded from ADMIN_USERS or ADMIN_EMAILS
- [ ] Both username and email-local-part matching supported
- [ ] Case-insensitive username comparison
- [ ] Domain prefixes stripped before admin check

---

## 🛣️ Route Protection Analysis

### Public Routes (src/routes/api.js)

Should NOT have ssoMiddleware:
- [ ] GET /health
- [ ] GET /test/request/:id/status
- [ ] GET /onboarding/lookup (AD lookup)
- [ ] GET /onboarding/history/:id (public history)
- [ ] GET /hrms/employee/:id (HRMS lookup)
- [ ] GET /ad-debug/:username (debug endpoint)

### SSO-Protected Routes (src/routes/api.js)

Must have ssoMiddleware:
- [ ] GET /auth/me
- [ ] GET /portal-auth/:roleSlug
- [ ] POST /onboarding/initiate
- [ ] GET /onboarding/my-hr-location
- [ ] GET /onboarding/:id/details
- [ ] GET /ad-users
- [ ] POST /offboarding/initiate

### Token-Based Routes

Must validate currentStageToken AND requester email:
- [ ] POST /approvals/handle
- [ ] GET /onboarding/handle
- [ ] POST /onboarding/handle
- [ ] GET /offboarding/handle
- [ ] POST /offboarding/handle

### Admin Routes (src/routes/admin.js)

**Page Routes** (HTML, use adminPageGuard):
- [ ] GET /hod-panel
- [ ] GET /settings
- [ ] GET /offboarding
- [ ] GET /workflow-approvers
- [ ] GET /onboarding-history
- [ ] GET /system-config

**API Routes** (JSON, use adminApiGuard):
- [ ] GET /employees
- [ ] GET /employee/:id
- [ ] PUT /employee/:id
- [ ] POST /assign-hod
- [ ] POST /workflow-approvers (all CRUD operations)
- [ ] POST /delegation/delegate
- [ ] POST /delegation/revert

**Critical Check:**
- [ ] NO admin routes return 401 status (all use 403 instead)

### Portal Routes (src/routes/portal.js)

**Must NOT use ssoMiddleware** (reads X-Auth-User directly):
- [ ] GET /:roleSlug (initial login)
- [ ] GET /:roleSlug/enter (email link entry)
- [ ] GET /:roleSlug/view (dashboard)

**Session Validation:**
- [ ] `/view` route validates portal session token from query string
- [ ] Checks token exists, hasn't expired, and roleKey matches
- [ ] Redirects to login with `?expired=1` on validation failure

---

## 📤 File Upload Routes

### Critical Ordering Check

For ALL file upload routes:
- [ ] Multer middleware runs BEFORE ssoMiddleware
- [ ] Route order: `upload.array()` → `ssoMiddleware` → controller
- [ ] No routes have ssoMiddleware before multer (will break authentication)

**Example Routes to Check:**
```javascript
// src/routes/api.js
router.post('/onboarding/upload-proof',
    upload.array('dciProof', 5),    // ✓ Multer first
    ssoMiddleware,                  // ✓ Then auth
    onboardingController.handleProofUpload  // ✓ Then controller
);
```

---

## 🎟️ Portal Session Management

### Token Issuance (src/services/portalTokenService.js)

- [ ] Tokens are UUIDs generated with `crypto.randomUUID()`
- [ ] Expiration set to 8 hours (28,800,000 ms)
- [ ] Session data includes: token, roleKey, username, email, accesses, roleName
- [ ] Sessions stored in-memory Map (aware of restart limitation)
- [ ] Hourly cleanup job prunes expired sessions

### Token Validation

- [ ] Validates token exists in session store
- [ ] Checks expiration timestamp (Date.now() > session.expiresAt)
- [ ] Verifies roleKey matches expected role from URL
- [ ] Returns null for invalid/expired tokens

### Authorization Resolution (src/controllers/portalController.js)

- [ ] Location-aware roles (IT_OPS, HR_INITIATOR) check WorkflowApproverLocationOverride first
- [ ] Falls back to WorkflowApproverConfig for global access
- [ ] Supports both username and email-local-part matching
- [ ] Tracks delegation (isDelegatedTemporarily, previousApproverUsername)
- [ ] Handles secondary approvers (escalation after 48 hours)

---

## 🔑 Request Token Authentication

### Token Generation (src/services/onboardingService.js)

- [ ] Tokens are hex strings: `crypto.randomBytes(20).toString('hex')`
- [ ] Stored in `OnboardingRequest.currentStageToken` column
- [ ] Generated when workflow enters new stage
- [ ] Cleared when workflow reaches terminal status (Completed, Rejected, Cancelled)

### Token Validation

- [ ] Request lookup by token: `OnboardingRequest.findOne({ where: { currentStageToken: token } })`
- [ ] Validates requester email matches `currentStageAssigneeEmail`
- [ ] Returns 404 if token not found (invalid or already used)
- [ ] Returns 403 if email doesn't match (forwarded email attack prevention)

### Token Lifecycle

- [ ] New token generated for each workflow stage
- [ ] Old token cleared when advancing to next stage
- [ ] Token set to null when workflow completes
- [ ] Email link includes token: `/portal/:roleSlug/enter?action={token}`

---

## 🔒 Security Pattern Compliance

### HMAC Signature

- [ ] Uses SHA-256 algorithm
- [ ] Signing data format v2: `username|timestamp|email|displayName`
- [ ] Signing data format v1: `username|timestamp` (legacy support)
- [ ] Shared secret from SSO_SHARED_SECRET environment variable
- [ ] Timing-safe comparison with `crypto.timingSafeEqual()`
- [ ] Buffer length check before comparison (prevents length-based timing leak)

### Loopback Trust

- [ ] Only trusts X-Auth-User from 127.0.0.1 or ::1
- [ ] Strips IPv6-mapped IPv4 prefix (::ffff:)
- [ ] Uses `req.socket.remoteAddress` (not req.ip)
- [ ] SSO_TRUST_PROXY_HEADER flag controls this behavior

### Domain Normalization

- [ ] All identity sources strip domain prefixes (DOMAIN\username → username)
- [ ] Case-insensitive comparison (normalize to lowercase)
- [ ] Handles cases where domain prefix is absent
- [ ] Applied to: sidecar token, proxy header, database lookups, admin checks

### No 401 on Admin Routes

- [ ] All admin API routes return 403 for unauthorized (not 401)
- [ ] All admin page routes return 403 HTML render (not 401)
- [ ] No admin routes trigger IIS Windows Auth popup loop

### Email Matching

- [ ] Both username and email fields checked for backward compatibility
- [ ] Email comparison uses local-part (before @)
- [ ] Username is preferred; email is fallback
- [ ] Case-insensitive comparison on both

---

## 🌍 Environment Configuration

### Required Variables

**SSO Configuration:**
- [ ] `SSO_MODE` is set (PROD, MOCK, or OPTIONAL)
- [ ] `SSO_SHARED_SECRET` matches web.config SsoSharedSecret
- [ ] `SSO_TRUST_PROXY_HEADER` is "true" for IIS integration
- [ ] In production: SSO_MODE must be PROD (not MOCK)

**Admin Authorization:**
- [ ] `ADMIN_USERS` is comma-separated list of AD usernames
- [ ] `ADMIN_EMAILS` is comma-separated list (legacy fallback)
- [ ] At least one admin user configured
- [ ] Current admins included in the list

**Mock/Dev Variables (Optional):**
- [ ] `SSO_MOCK_USERNAME` (for MOCK or OPTIONAL mode)
- [ ] `SSO_MOCK_EMAIL` (for MOCK or OPTIONAL mode)
- [ ] `SSO_MOCK_DISPLAY` (for MOCK or OPTIONAL mode)
- [ ] Only used when SSO_MODE is not PROD

### Secret Sync Validation

- [ ] server.js checks SSO_SHARED_SECRET matches web.config SsoSharedSecret
- [ ] Logs ERROR if mismatch detected (helps catch config drift)
- [ ] Startup validation runs before server starts listening

---

## 🗂️ Database Configuration

### Session Storage

- [ ] Portal sessions stored in-memory JavaScript Map
- [ ] Aware of limitation: sessions lost on server restart
- [ ] Hourly cleanup job scheduled with setInterval
- [ ] Consider Redis/database migration for production scaling

### Token Storage

- [ ] Request tokens stored in `currentStageToken` column
- [ ] Token column allows null (cleared after use)
- [ ] Indexed for fast lookup (if high volume)

### Authorization Tables

- [ ] `WorkflowApproverConfig` has one row per role
- [ ] `WorkflowApproverLocationOverride` configured for location-aware roles
- [ ] Both tables have approverUsername (preferred) and approverEmail (fallback)
- [ ] Delegation fields tracked: isDelegatedTemporarily, previousApproverUsername, etc.

---

## 🧪 Testing Coverage

### Unit Tests (tests/sso-middleware.audit.test.js)

- [ ] Valid sidecar token passes authentication
- [ ] Expired token (>5 minutes) is rejected
- [ ] Invalid HMAC signature is rejected
- [ ] Proxy header only trusted from loopback
- [ ] Mock mode works when SSO_MODE=MOCK
- [ ] Optional mode falls back to mock when no auth provided
- [ ] Domain prefix stripping works correctly
- [ ] v1 and v2 signatures both validate

### Integration Tests

- [ ] Portal login flow works end-to-end
- [ ] File upload with sidecar token succeeds
- [ ] Admin routes return 403 (not 401) for non-admins
- [ ] Token-based approval validates email match
- [ ] Session expiration redirects to login
- [ ] Location-aware authorization resolves correctly

---

## 📊 Audit Summary Template

Use this format for reporting audit results:

```
## Authentication Audit Report
Date: YYYY-MM-DD
Auditor: [Name]

### Executive Summary
[2-3 sentences on overall compliance status]

### Routes Analyzed
- Total routes: X
- SSO-protected: Y
- Public: Z
- Admin: W
- Token-based: V

### Critical Issues ❌
[List any critical violations requiring immediate fix]

### High Priority ⚠️
[List high-priority issues to address soon]

### Medium Priority ⚡
[List medium-priority improvements]

### Low Priority 💡
[List nice-to-have optimizations]

### Compliance Score
[X/Y checks passed (Z%)]

### Recommendations
1. [Immediate action item 1]
2. [Immediate action item 2]
3. [Future improvement 1]
```

---

## 🚨 Common Violation Patterns

### Pattern 1: Missing ssoMiddleware
```javascript
// ❌ WRONG: Protected route without auth
router.post('/api/sensitive-action', controller.handle);

// ✅ CORRECT: Protected route with auth
router.post('/api/sensitive-action', ssoMiddleware, controller.handle);
```

### Pattern 2: Admin Routes Returning 401
```javascript
// ❌ WRONG: Triggers IIS popup loop
if (!isAdmin) {
    return res.status(401).json({ error: 'Unauthorized' });
}

// ✅ CORRECT: Returns 403, no popup
if (!isAdmin) {
    return res.status(403).json({ error: 'Forbidden - admin access required' });
}
```

### Pattern 3: Multer After ssoMiddleware
```javascript
// ❌ WRONG: ssoMiddleware can't read req.body
router.post('/upload', ssoMiddleware, upload.array('files'), handler);

// ✅ CORRECT: multer parses body first
router.post('/upload', upload.array('files'), ssoMiddleware, handler);
```

### Pattern 4: Unsafe HMAC Comparison
```javascript
// ❌ WRONG: Vulnerable to timing attacks
if (providedHmac === computedHmac) { ... }

// ✅ CORRECT: Timing-safe comparison
if (crypto.timingSafeEqual(
    Buffer.from(providedHmac, 'hex'),
    Buffer.from(computedHmac, 'hex')
)) { ... }
```

### Pattern 5: Trusting Proxy Header from Anywhere
```javascript
// ❌ WRONG: Trusts header from any IP (security risk)
const username = req.headers['x-auth-user'];

// ✅ CORRECT: Only trusts from loopback
if (isLoopback(req)) {
    const username = req.headers['x-auth-user'];
}
```

### Pattern 6: Token Reuse
```javascript
// ❌ WRONG: Token can be reused multiple times
const request = await OnboardingRequest.findOne({
    where: { currentStageToken: token }
});
// ... process action ...
// Token still in database, can be reused!

// ✅ CORRECT: Single-use token
const request = await OnboardingRequest.findOne({
    where: { currentStageToken: token }
});
// ... process action ...
await request.update({ currentStageToken: null });  // Clear after use
```

---

## 📁 Files to Review

When auditing, always check these critical files:

**Authentication Core:**
- `src/middleware/ssoMiddleware.js`
- `src/middleware/adminMiddleware.js`
- `src/services/portalTokenService.js`

**Route Definitions:**
- `src/routes/api.js`
- `src/routes/admin.js`
- `src/routes/portal.js`

**Controllers:**
- `src/controllers/portalController.js`
- `src/controllers/onboardingController.js`
- `src/controllers/approvalController.js`
- `src/controllers/offboardingController.js`

**Configuration:**
- `web.config`
- `.env`
- `server.js`

**Tests:**
- `tests/sso-middleware.audit.test.js`

---

## ✅ Quick Compliance Check

Run these commands to quickly spot issues:

```bash
# Find routes without ssoMiddleware that might need it
grep -n "router\\.\\(get\\|post\\|put\\|delete\\)" src/routes/api.js | \
    grep -v "ssoMiddleware" | \
    grep -v "// Public"

# Find admin routes that might return 401
grep -n "status(401)" src/routes/admin.js src/controllers/*Controller.js

# Find upload routes to check multer ordering
grep -n "upload\\." src/routes/*.js

# Check for unsafe HMAC comparison
grep -n "=== computedHmac" src/middleware/*.js

# Verify SSO_SHARED_SECRET is set
grep "SSO_SHARED_SECRET" .env
```

---

## 🎯 Audit Frequency

- **Before every deployment:** Quick compliance check (15 min)
- **Monthly:** Full comprehensive audit (1-2 hours)
- **After auth changes:** Targeted audit of affected areas (30 min)
- **Quarterly:** Security review with penetration testing (4+ hours)

---

**Last Updated:** 2026-05-29
**Version:** 1.0
**Maintained By:** SSO Auth Guardian Skill

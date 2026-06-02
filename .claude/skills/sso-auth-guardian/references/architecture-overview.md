# Authentication Architecture Overview

Quick reference guide for the IFL Workflow authentication system.

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Internet / Intranet                      │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                    ┌───────────▼──────────┐
                    │   IIS (Public IP)    │
                    │  Windows Auth + SSL  │
                    └───────────┬──────────┘
                                │
                    ┌───────────▼──────────┐
                    │   URL Rewrite Rules  │
                    │  - Set X-Auth-User   │
                    │  - Proxy to Node     │
                    └───────────┬──────────┘
                                │
                    ┌───────────▼──────────┐
                    │   token.aspx         │
                    │  - Query AD GC       │
                    │  - Generate HMAC     │
                    │  - Return JSON token │
                    └───────────┬──────────┘
                                │
            Loopback (127.0.0.1:3000)
                                │
                    ┌───────────▼──────────┐
                    │   Node.js Express    │
                    │  - ssoMiddleware     │
                    │  - Portal sessions   │
                    │  - Request tokens    │
                    └──────────────────────┘
```

## Authentication Flows

### Flow 1: Browser-Based Portal Login

```
1. User → IIS:3333/portal/it-ops
   ↓
2. IIS performs Windows Auth (NTLM/Kerberos)
   ↓
3. IIS URL Rewrite sets X-Auth-User from {LOGON_USER}
   ↓
4. IIS proxies to Node.js 127.0.0.1:3000/portal/it-ops
   ↓
5. Node.js portal route reads X-Auth-User header
   ↓
6. Renders portal_loading.ejs page (fast path or loading screen)
   ↓
7. Client-side JS calls window.iflFetch()
   ↓
8. window.iflFetch → IIS:3333/token.aspx
   ↓
9. token.aspx queries AD Global Catalog for email/displayName
   ↓
10. token.aspx generates HMAC-signed JSON token
   ↓
11. Client-side JS calls GET /api/portal-auth/:roleSlug with token
   ↓
12. ssoMiddleware validates HMAC signature
   ↓
13. Portal controller resolves user's access for role
   ↓
14. portalTokenService.issueToken() creates 8-hour session
   ↓
15. Redirects to /portal/:roleSlug/view?token={SESSION_UUID}
   ↓
16. Dashboard validates session token and renders UI
```

### Flow 2: Email Link Action (Token-Based)

```
1. User receives email with link:
   /portal/it-ops/enter?action={HEX_TOKEN}
   ↓
2. IIS Windows Auth + URL Rewrite (same as Flow 1)
   ↓
3. Node.js portal route renders portal_loading.ejs
   ↓
4. Client-side JS fetches token.aspx (same as Flow 1)
   ↓
5. Client-side JS calls GET /api/portal-auth/:roleSlug?action={HEX_TOKEN}
   ↓
6. ssoMiddleware validates HMAC signature
   ↓
7. Portal controller validates action token exists in database
   ↓
8. Auto-corrects role if request moved to different stage
   ↓
9. Issues portal session token (8-hour duration)
   ↓
10. Redirects to dashboard with request auto-expanded
```

### Flow 3: API Request from Portal Dashboard

```
1. Portal dashboard page (already has session token)
   ↓
2. Client-side JS calls window.iflFetch('/api/onboarding/:id/details')
   ↓
3. window.iflFetch automatically fetches sidecar token from token.aspx
   ↓
4. Attaches x-sidecar-token to request body or query
   ↓
5. Request goes through IIS → Node.js
   ↓
6. ssoMiddleware validates sidecar token HMAC signature
   ↓
7. Sets req.user = { username, email, displayName }
   ↓
8. Controller processes request with authenticated user context
```

### Flow 4: Direct Email Action (No Portal)

```
1. User receives email with link:
   /api/onboarding/handle?token={HEX_TOKEN}
   ↓
2. IIS Windows Auth + URL Rewrite
   ↓
3. GET displays form with token embedded
   ↓
4. User submits form
   ↓
5. POST includes x-sidecar-token (from window.iflFetch)
   ↓
6. ssoMiddleware validates sidecar token
   ↓
7. Controller validates action token from database
   ↓
8. Checks req.user.email === request.currentStageAssigneeEmail
   ↓
9. Processes approval/rejection
   ↓
10. Clears old token, generates new token for next stage
```

## Token Types

### 1. Sidecar Token (HMAC-Signed JSON)

**Source:** token.aspx on IIS
**Format:**
```json
{
    "username": "israr.haq",
    "timestamp": 1735561200,
    "email": "israr.haq@ifl.com.pk",
    "displayName": "Israr Ul Haq",
    "sig": "abc123...def456"
}
```

**Lifetime:** 5 minutes (300 seconds)
**Validation:**
- HMAC signature with SSO_SHARED_SECRET
- Timestamp within 5-minute window
- Timing-safe comparison

**Transport:**
- HTTP header: `x-sidecar-token`
- Request body: `x-sidecar-token` field
- Query string: `?x-sidecar-token=...`

### 2. Portal Session Token (UUID)

**Source:** portalTokenService.issueToken()
**Format:** UUID string (e.g., `550e8400-e29b-41d4-a716-446655440000`)

**Lifetime:** 8 hours (28,800,000 ms)
**Storage:** In-memory JavaScript Map
**Validation:**
- Token exists in sessions Map
- Not expired (Date.now() <= expiresAt)
- roleKey matches expected role

**Transport:**
- Query string: `/portal/:roleSlug/view?token={UUID}`

**Session Data:**
```javascript
{
    token: UUID,
    roleKey: 'IT_OPS',
    username: 'israr.haq',
    email: 'israr.haq@ifl.com.pk',
    accesses: [{location: 'Head Office', isPrimary: true}],
    roleName: 'IT Operations',
    expiresAt: 1735651200000
}
```

### 3. Request Action Token (Hex String)

**Source:** crypto.randomBytes(20).toString('hex')
**Format:** 40-character hex string (e.g., `a1b2c3d4e5f6...`)

**Lifetime:** Until workflow stage completes (unlimited)
**Storage:** Database column `OnboardingRequest.currentStageToken`
**Validation:**
- Token exists in database
- Requester email matches currentStageAssigneeEmail
- Single-use (cleared after action)

**Transport:**
- Query string: `?token={HEX}` or `?action={HEX}`
- Email links: `/portal/:roleSlug/enter?action={HEX}`

## Middleware Stack

### Route Type: Public API
```javascript
router.get('/health', healthController.check);
// No middleware - open to all
```

### Route Type: SSO-Protected API
```javascript
router.post('/onboarding/initiate', ssoMiddleware, onboardingController.initiate);
// ssoMiddleware validates sidecar token or proxy header
```

### Route Type: File Upload
```javascript
router.post('/upload', upload.array('files'), ssoMiddleware, controller.handle);
// CRITICAL: multer BEFORE ssoMiddleware
```

### Route Type: Admin Page
```javascript
router.get('/admin/settings', adminPageGuard, adminController.settings);
// adminPageGuard reads X-Auth-User, returns 403 HTML
```

### Route Type: Admin API
```javascript
router.get('/admin/employees', adminApiGuard, adminController.getEmployees);
// adminApiGuard validates sidecar OR proxy, returns 403 JSON
```

### Route Type: Portal Entry
```javascript
router.get('/portal/:roleSlug', portalController.login);
// NO ssoMiddleware - reads X-Auth-User directly in controller
```

### Route Type: Portal Dashboard
```javascript
router.get('/portal/:roleSlug/view', portalController.view);
// Validates session token from query string
```

## Role Configuration

### Portal Roles

| Role Slug      | Role Key       | Location-Aware | Delegation | Escalation |
|----------------|----------------|----------------|------------|------------|
| it-ops         | IT_OPS         | Yes            | No         | 48h → Secondary |
| hr-initiator   | HR_INITIATOR   | Yes            | No         | No |
| dci-team       | DCI_TEAM       | No             | No         | No |
| dci-implementer| DCI_IMPLEMENTER| No             | No         | No |
| it-hod         | IT_HOD         | No             | Yes        | No |
| dci-manager    | DCI_MANAGER    | No             | Yes        | No |
| it-ops-mgr     | IT_OPS_MGR     | No (monitor)   | No         | No |

**Location-Aware Roles:**
- Check `WorkflowApproverLocationOverride` first
- Fall back to `WorkflowApproverConfig` global
- Session includes `accesses` array with locations

**Delegation Roles:**
- IT_HOD and DCI_MANAGER support temporary delegation
- Original approver can view queue in read-only mode
- Session includes `isOriginalDelegator` flag

**Monitoring Roles:**
- IT_OPS_MGR sees all locations (no filter)
- Displays location summary and escalation tracking

## Authorization Resolution

```javascript
// Pseudo-code for resolving user access
async function resolveAccess(username, email, roleKey) {
    // Step 1: Check location overrides (if location-aware role)
    if (roleKey === 'IT_OPS' || roleKey === 'HR_INITIATOR') {
        const overrides = await WorkflowApproverLocationOverride.findAll({
            where: {
                roleKey,
                OR: [
                    { approverUsername: username },
                    { approverEmail: extractLocalPart(email) },
                    { secondaryUsername: username },
                    { secondaryEmail: extractLocalPart(email) }
                ]
            }
        });

        if (overrides.length > 0) {
            return overrides.map(o => ({
                location: o.location,
                isPrimary: o.approverUsername === username,
                isOriginalDelegator: o.isDelegatedTemporarily &&
                                    o.previousApproverUsername === username
            }));
        }
    }

    // Step 2: Fallback to global config
    const globalConfig = await WorkflowApproverConfig.findOne({
        where: {
            roleKey,
            OR: [
                { approverUsername: username },
                { approverEmail: extractLocalPart(email) }
            ]
        }
    });

    if (globalConfig) {
        return [{ location: null, isPrimary: true }];
    }

    // Step 3: No access found
    return [];
}
```

## Environment Variables

### Production Configuration

```bash
# SSO Mode
SSO_MODE=PROD
SSO_SHARED_SECRET=IFL_WORKFLOW_SECRET_KEY_2025  # Must match web.config
SSO_TRUST_PROXY_HEADER=true

# Admin Users
ADMIN_USERS=israr.haq,ahmed.ali,sajeel.dilshad
ADMIN_EMAILS=israr.haq@igc.com.pk  # Legacy fallback

# Database
DB_DIALECT=mssql
DB_HOST=sp16-svr
DB_PORT=1433
DB_NAME=IFL_Workflow_DB
DB_USER=sa
DB_PASS=Sa123456

# Email
SMTP_HOST=192.168.1.101
SMTP_PORT=25
SMTP_SECURE=false
EMAIL_MODE=PROD

# App URL (for email links)
APP_URL=http://hosppdevsrv:3333
```

### Development Configuration

```bash
# SSO Mode (allows mock login)
SSO_MODE=OPTIONAL
SSO_SHARED_SECRET=IFL_WORKFLOW_SECRET_KEY_2025
SSO_TRUST_PROXY_HEADER=true

# Mock User (used when no real auth)
SSO_MOCK_USERNAME=dev.user
SSO_MOCK_EMAIL=dev.user@ifl.com.pk
SSO_MOCK_DISPLAY=Dev User (Mock SSO)
SSO_MOCK_DESIGNATION=HR

# Database (local SQLite)
DB_DIALECT=sqlite
DB_NAME=IFL_Workflow_DB

# Email (dev mode)
EMAIL_MODE=DEV
TEST_RECIPIENT_EMAIL=developer@ifl.com.pk
```

## Security Best Practices

### ✅ DO

1. **Always use timing-safe HMAC comparison**
   ```javascript
   crypto.timingSafeEqual(providedBuffer, computedBuffer)
   ```

2. **Restrict proxy header trust to loopback**
   ```javascript
   if (isLoopback(req)) { /* trust X-Auth-User */ }
   ```

3. **Return 403 (not 401) from admin routes**
   ```javascript
   res.status(403).json({ error: 'Forbidden' })
   ```

4. **Run multer before ssoMiddleware on uploads**
   ```javascript
   router.post('/upload', upload.array('files'), ssoMiddleware, handler)
   ```

5. **Validate both token existence AND email match for actions**
   ```javascript
   if (req.user.email !== request.currentStageAssigneeEmail) { /* reject */ }
   ```

6. **Clear action tokens after use (single-use pattern)**
   ```javascript
   await request.update({ currentStageToken: null })
   ```

### ❌ DON'T

1. **Don't use regular string comparison for HMAC**
   ```javascript
   // ❌ Vulnerable to timing attacks
   if (providedHmac === computedHmac) { /* ... */ }
   ```

2. **Don't trust proxy headers from non-loopback IPs**
   ```javascript
   // ❌ Security risk
   const username = req.headers['x-auth-user'];
   ```

3. **Don't return 401 from admin routes**
   ```javascript
   // ❌ Triggers IIS popup loop
   res.status(401).json({ error: 'Unauthorized' })
   ```

4. **Don't use ssoMiddleware on portal routes**
   ```javascript
   // ❌ Breaks IIS proxy flow
   router.get('/portal/:roleSlug', ssoMiddleware, handler)
   ```

5. **Don't reuse action tokens across stages**
   ```javascript
   // ❌ Security risk - tokens should be single-use
   // Always generate new token for next stage
   ```

## Troubleshooting

### Issue: Windows Auth popup loop

**Symptoms:** Browser repeatedly prompts for Windows credentials

**Cause:** Route returned 401 status, which IIS intercepts

**Fix:** Change to 403 status
```javascript
// Before
res.status(401).json({ error: 'Unauthorized' });

// After
res.status(403).json({ error: 'Forbidden' });
```

### Issue: File upload returns 401

**Symptoms:** File upload fails with 401 error

**Cause:** ssoMiddleware runs before multer, can't read req.body

**Fix:** Reorder middleware
```javascript
// Before
router.post('/upload', ssoMiddleware, upload.array('files'), handler);

// After
router.post('/upload', upload.array('files'), ssoMiddleware, handler);
```

### Issue: Portal login fails with "Invalid signature"

**Symptoms:** All portal logins fail with HMAC validation error

**Cause:** SSO_SHARED_SECRET doesn't match web.config SsoSharedSecret

**Fix:** Ensure secrets match
```bash
# .env
SSO_SHARED_SECRET=IFL_WORKFLOW_SECRET_KEY_2025

# web.config
<add key="SsoSharedSecret" value="IFL_WORKFLOW_SECRET_KEY_2025" />
```

### Issue: Action link redirects to wrong portal

**Symptoms:** Email link goes to wrong role dashboard

**Cause:** Request moved to different stage while email was in flight

**Fix:** This is expected behavior! The portal controller auto-corrects:
```javascript
// Portal auth checks current stage and redirects if needed
if (request.currentStage !== expectedStage) {
    const correctRoleSlug = stageToRoleSlugMap[request.currentStage];
    return res.redirect(`/portal/${correctRoleSlug}/view?token=${portalToken}`);
}
```

### Issue: Session expired immediately

**Symptoms:** Portal session expires right after login

**Cause:** Server restarted (sessions are in-memory)

**Fix:** This is a known limitation. Consider migrating to Redis/database sessions for production.

---

**Version:** 1.0
**Last Updated:** 2026-05-29
**Maintained By:** SSO Auth Guardian Skill

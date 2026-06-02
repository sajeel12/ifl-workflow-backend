# Security Patterns Reference

This document details all security patterns enforced by the SSO & Authentication Guardian.

## Table of Contents
1. [HMAC Token Validation](#hmac-token-validation)
2. [Loopback-Only Proxy Trust](#loopback-only-proxy-trust)
3. [Admin Route Protection](#admin-route-protection)
4. [Multer Ordering](#multer-ordering)
5. [Portal Session Management](#portal-session-management)
6. [Request Token Lifecycle](#request-token-lifecycle)
7. [Domain Normalization](#domain-normalization)
8. [Location-Aware Authorization](#location-aware-authorization)

---

## HMAC Token Validation

### Pattern Description
All sidecar tokens from token.aspx must be validated using HMAC-SHA256 with a shared secret. The signature must be verified using timing-safe comparison to prevent timing attacks.

### Implementation
```javascript
// Extract token from request (priority: header → body → query)
const rawToken = req.headers['x-sidecar-token']
                || req.body?.['x-sidecar-token']
                || req.query['x-sidecar-token'];

// Parse JSON token
const tokenData = JSON.parse(rawToken);
const { username, timestamp, email, displayName, sig } = tokenData;

// Validate token age (5-minute window)
const now = Math.floor(Date.now() / 1000);
if (Math.abs(now - timestamp) > 300) {
    throw new Error('Token expired (max 5 minutes)');
}

// Compute HMAC signature
const signingData = `${username}|${timestamp}|${email || ''}|${displayName || ''}`;
const computedHmac = crypto.createHmac('sha256', SSO_SHARED_SECRET)
    .update(signingData)
    .digest('hex');

// Timing-safe comparison (prevents timing attacks)
const providedBuffer = Buffer.from(sig, 'hex');
const computedBuffer = Buffer.from(computedHmac, 'hex');

if (providedBuffer.length !== computedBuffer.length) {
    throw new Error('Invalid signature');
}

if (!crypto.timingSafeEqual(providedBuffer, computedBuffer)) {
    throw new Error('Invalid signature');
}
```

### Why This Matters
- **Timing Attacks**: Regular string comparison (`===`) can leak timing information about which byte differs first. Attackers can use this to forge signatures byte-by-byte.
- **Token Age**: Without age validation, captured tokens could be replayed indefinitely.
- **Shared Secret**: Must match between Node.js (.env) and IIS (web.config) or all tokens will fail validation.

### Common Violations
❌ Using `sig === computedHmac` instead of `timingSafeEqual()`
❌ Not checking token age
❌ Only validating v2 signatures (breaks backward compatibility)
❌ Mismatched secrets between .env and web.config

### Testing
```javascript
// Test case: Valid token should pass
const validToken = {
    username: 'test.user',
    timestamp: Math.floor(Date.now() / 1000),
    email: 'test.user@ifl.com.pk',
    displayName: 'Test User',
    sig: computeValidSignature(...)
};

// Test case: Expired token should fail
const expiredToken = {
    ...validToken,
    timestamp: Math.floor(Date.now() / 1000) - 400  // 6+ minutes old
};

// Test case: Invalid signature should fail
const tamperedToken = {
    ...validToken,
    sig: 'deadbeef1234567890'
};
```

---

## Loopback-Only Proxy Trust

### Pattern Description
The X-Auth-User header (set by IIS URL Rewrite) should only be trusted when the request comes from the loopback interface (127.0.0.1 or ::1).

### Implementation
```javascript
function isLoopback(req) {
    const ip = (req.socket && req.socket.remoteAddress) || '';
    const clean = ip.replace(/^::ffff:/, '');  // Strip IPv6 prefix
    return clean === '127.0.0.1' || clean === '::1' || clean === 'localhost';
}

// Only trust proxy header from loopback
if (SSO_TRUST_PROXY_HEADER === 'true' && isLoopback(req)) {
    const rawUsername = req.headers['x-auth-user'];
    if (rawUsername) {
        username = stripDomain(rawUsername);
        // Note: No email/displayName available via proxy header
    }
}
```

### Why This Matters
Node.js binds to 127.0.0.1 only. IIS is the sole ingress point and forwards requests via loopback. If we trusted X-Auth-User from any IP, an external attacker could forge the header and impersonate any user.

### Network Architecture
```
Internet → IIS (public IP) → URL Rewrite → Node.js (127.0.0.1:3000)
           └─ Sets X-Auth-User from Windows Auth
```

### Common Violations
❌ Trusting X-Auth-User without checking source IP
❌ Using `req.ip` instead of `req.socket.remoteAddress` (may be wrong behind proxy)
❌ Not handling IPv6-mapped IPv4 addresses (::ffff:127.0.0.1)

### Testing
```javascript
// Test case: Loopback request should trust header
req.socket.remoteAddress = '127.0.0.1';
req.headers['x-auth-user'] = 'DOMAIN\\test.user';
// Should extract username = 'test.user'

// Test case: External request should ignore header
req.socket.remoteAddress = '192.168.1.100';
req.headers['x-auth-user'] = 'DOMAIN\\admin.user';
// Should NOT extract username from header (potential attack)
```

---

## Admin Route Protection

### Pattern Description
Admin routes must NEVER return 401 status codes. Always return 403 to prevent IIS from triggering Windows Authentication popup loops.

### Implementation

#### Admin Page Guard (HTML responses)
```javascript
function adminPageGuard(req, res, next) {
    const rawUsername = req.headers['x-auth-user'];

    // If no header, let API guards handle it (could be API request with sidecar token)
    if (!rawUsername) {
        return next();
    }

    const username = stripDomain(rawUsername);

    // Check against admin list
    if (!ADMIN_USERNAMES.has(username)) {
        return res.status(403).render('error', {
            title: 'Access Denied',
            message: 'Admin access required'
        });
    }

    next();
}
```

#### Admin API Guard (JSON responses)
```javascript
function adminApiGuard(req, res, next) {
    // Validate sidecar token OR proxy header
    const rawToken = req.headers['x-sidecar-token']
                    || req.body?.['x-sidecar-token'];

    let username;

    if (rawToken) {
        // Validate HMAC token
        const tokenData = validateHmacToken(rawToken);
        username = tokenData.username;
    } else if (isLoopback(req)) {
        // Fallback to proxy header
        username = stripDomain(req.headers['x-auth-user']);
    }

    if (!username || !ADMIN_USERNAMES.has(username)) {
        // CRITICAL: Return 403, NOT 401
        return res.status(403).json({
            error: 'Forbidden - admin access required'
        });
    }

    next();
}
```

### Why This Matters
IIS intercepts 401 responses and triggers Windows Authentication popup. For AJAX/fetch requests, this creates infinite popup loops because JavaScript can't provide Windows credentials.

### Common Violations
❌ Returning `res.status(401).json(...)` from admin routes
❌ Using generic `adminMiddleware` that can return 401
❌ Not separating page guards (HTML) from API guards (JSON)

### Testing
```javascript
// Test case: Non-admin API request should get 403 JSON
const response = await fetch('/admin/employees', {
    headers: { 'x-sidecar-token': nonAdminToken }
});
expect(response.status).toBe(403);  // NOT 401
expect(response.headers.get('content-type')).toContain('application/json');

// Test case: Non-admin page request should get 403 HTML
const response = await fetch('/admin/settings');
expect(response.status).toBe(403);  // NOT 401
expect(response.headers.get('content-type')).toContain('text/html');
```

---

## Multer Ordering

### Pattern Description
File upload routes must run multer middleware BEFORE ssoMiddleware. If ssoMiddleware runs first, req.body is empty and can't read the x-sidecar-token from multipart form data.

### Implementation
```javascript
// CORRECT ORDER
router.post('/onboarding/upload-proof',
    upload.array('dciProof', 5),    // 1️⃣ Parse multipart data first
    ssoMiddleware,                  // 2️⃣ Then validate auth (reads req.body)
    onboardingController.handleProofUpload  // 3️⃣ Finally handle upload
);

// INCORRECT ORDER (WILL BREAK)
router.post('/onboarding/upload-proof',
    ssoMiddleware,                  // ❌ req.body is empty here!
    upload.array('dciProof', 5),
    onboardingController.handleProofUpload
);
```

### Why This Matters
1. Browser submits multipart/form-data with both files and x-sidecar-token
2. Express doesn't parse multipart bodies by default (req.body is `{}`)
3. ssoMiddleware looks for x-sidecar-token in req.body
4. If multer hasn't run yet, token lookup fails → 401 error
5. IIS sees 401 → triggers Windows Auth popup → infinite loop

### Common Violations
❌ Adding ssoMiddleware before upload middleware
❌ Using body-parser instead of multer (doesn't handle multipart)
❌ Not documenting the ordering requirement in comments

### Testing
```javascript
// Test case: Upload with sidecar token in form data
const formData = new FormData();
formData.append('file', fileBlob);
formData.append('x-sidecar-token', validToken);

const response = await fetch('/api/onboarding/upload-proof', {
    method: 'POST',
    body: formData
});

expect(response.status).toBe(200);  // Should succeed, not 401
```

---

## Portal Session Management

### Pattern Description
Portal sessions use UUID tokens with 8-hour expiration, stored in-memory. Validation must check token existence, expiration, and role match.

### Implementation

#### Session Issuance
```javascript
// portalTokenService.js
function issueToken({ roleKey, username, email, accesses, roleName, ... }) {
    const token = crypto.randomUUID();  // UUID format
    const expiresAt = Date.now() + 8 * 60 * 60 * 1000;  // 8 hours

    sessions.set(token, {
        token,
        roleKey,
        username,
        email,
        accesses,
        roleName,
        expiresAt,
        // ... other metadata
    });

    return token;
}
```

#### Session Validation
```javascript
// portalController.js
function viewPortalDashboard(req, res) {
    const token = req.query.token;
    const { roleSlug } = req.params;

    // Validate session
    const session = portalTokenService.validateToken(token || '');

    if (!session) {
        return res.redirect(`/portal/${roleSlug}?expired=1`);
    }

    // Check expiration
    if (Date.now() > session.expiresAt) {
        return res.redirect(`/portal/${roleSlug}?expired=1`);
    }

    // Verify role matches
    const expectedRoleKey = ROLE_SLUGS[roleSlug];
    if (session.roleKey !== expectedRoleKey) {
        return res.redirect(`/portal/${roleSlug}?expired=1`);
    }

    // Session is valid, render dashboard
    res.render('portal_dashboard', { session, ... });
}
```

#### Session Cleanup
```javascript
// Hourly cleanup of expired sessions
setInterval(() => {
    const now = Date.now();
    for (const [token, session] of sessions.entries()) {
        if (now > session.expiresAt) {
            sessions.delete(token);
        }
    }
}, 60 * 60 * 1000);  // Every hour
```

### Why This Matters
- **In-Memory Storage**: Fast but lost on restart. Users must re-login after deployment.
- **8-Hour Expiration**: Balances security (not too long) with UX (not too short).
- **Role Validation**: Prevents users from switching roles by editing query string.

### Common Violations
❌ Not validating expiration timestamp
❌ Not checking roleKey matches expected role
❌ Using predictable tokens instead of UUIDs
❌ Not cleaning up expired sessions (memory leak)

### Future Improvement
Consider migrating to Redis or database-backed sessions for:
- Session persistence across restarts
- Horizontal scaling support
- Centralized session management

---

## Request Token Lifecycle

### Pattern Description
Workflow action tokens are single-use hex strings stored in `currentStageToken`. After use, they're cleared and a new token is generated for the next stage.

### Implementation

#### Token Generation
```javascript
// onboardingService.js
function generateActionToken() {
    return crypto.randomBytes(20).toString('hex');  // 40-char hex string
}

// When creating or moving to new stage
await onboardingRequest.update({
    currentStageToken: generateActionToken(),
    currentStage: 'PendingIT',
    currentStageAssigneeEmail: 'it.ops@ifl.com.pk'
});
```

#### Token Validation
```javascript
// onboardingController.js
async function handleApproval(req, res) {
    const { token } = req.query;

    // Find request by token
    const request = await OnboardingRequest.findOne({
        where: { currentStageToken: token }
    });

    if (!request) {
        return res.status(404).json({
            error: 'Invalid or expired token'
        });
    }

    // Validate requester email matches assignee
    if (req.user.email !== request.currentStageAssigneeEmail) {
        return res.status(403).json({
            error: 'This action token is not assigned to your email'
        });
    }

    // Process approval...

    // Generate new token for next stage
    const newToken = generateActionToken();

    await request.update({
        currentStage: nextStage,
        currentStageToken: nextStage === 'Completed' ? null : newToken,
        currentStageAssigneeEmail: nextAssignee
    });

    // Send email with new token to next assignee
    sendEmail({
        to: nextAssignee,
        actionLink: `/portal/${nextRoleSlug}/enter?action=${newToken}`
    });
}
```

#### Token Clearing
```javascript
// When workflow reaches terminal status
await request.update({
    currentStage: 'Completed',
    currentStageToken: null,  // Clear token (no longer needed)
    completedAt: new Date()
});
```

### Why This Matters
- **Single-Use**: Prevents token reuse if email is forwarded
- **Email Binding**: Only the intended recipient can use the token
- **Lifecycle Management**: Tokens are scoped to one workflow stage

### Common Violations
❌ Not validating requester email matches `currentStageAssigneeEmail`
❌ Reusing tokens across multiple stages
❌ Not clearing token when workflow completes
❌ Not generating new token when advancing to next stage

### Testing
```javascript
// Test case: Token should be single-use
const request = await createTestRequest();
const token = request.currentStageToken;

// First use should succeed
await handleApproval({ query: { token }, user: { email: request.currentStageAssigneeEmail } });

// Second use should fail (token cleared)
await handleApproval({ query: { token }, user: { email: request.currentStageAssigneeEmail } });
// Should return 404 (token no longer exists)
```

---

## Domain Normalization

### Pattern Description
All identity sources (sidecar token, proxy header, database lookups) must strip domain prefixes like "DOMAIN\" and normalize to lowercase.

### Implementation
```javascript
function stripDomain(username) {
    if (!username) return '';

    const parts = String(username).split('\\');
    const normalized = (parts.length > 1 ? parts[1] : parts[0])
        .trim()
        .toLowerCase();

    return normalized;
}

// Usage examples
stripDomain('IBRAHIM1_NT\\israr.haq')  // → 'israr.haq'
stripDomain('israr.haq')                // → 'israr.haq'
stripDomain('ISRAR.HAQ')                // → 'israr.haq'
```

### Why This Matters
- **Consistency**: Database stores usernames without domain prefixes
- **Case Sensitivity**: SQL may be case-insensitive, but JavaScript isn't
- **Multiple Domains**: System supports IBRAHIM1_NT, IBRAHIM5_NT, etc.

### Common Violations
❌ Not stripping domain prefix before database lookups
❌ Case-sensitive comparisons (israr.haq ≠ ISRAR.HAQ)
❌ Not handling cases where domain prefix is absent

---

## Location-Aware Authorization

### Pattern Description
Some roles (IT_OPS, HR_INITIATOR) have different approvers per location. Authorization lookup checks location overrides first, then falls back to global config.

### Implementation
```javascript
async function resolveAccess(username, email, roleKey) {
    const accesses = [];

    // For location-aware roles, check per-location overrides
    if (roleKey === 'IT_OPS' || roleKey === 'HR_INITIATOR') {
        const overrides = await WorkflowApproverLocationOverride.findAll({
            where: {
                roleKey,
                [Op.or]: [
                    { approverUsername: username },
                    { approverEmail: { [Op.like]: `${username}@%` } },
                    { secondaryUsername: username },
                    { secondaryEmail: { [Op.like]: `${username}@%` } }
                ]
            }
        });

        for (const override of overrides) {
            accesses.push({
                location: override.location,
                isPrimary: override.approverUsername === username,
                isOriginalDelegator: override.isDelegatedTemporarily &&
                                    override.previousApproverUsername === username
            });
        }
    }

    // Fallback to global config
    if (accesses.length === 0) {
        const globalConfig = await WorkflowApproverConfig.findOne({
            where: {
                roleKey,
                [Op.or]: [
                    { approverUsername: username },
                    { approverEmail: { [Op.like]: `${username}@%` } }
                ]
            }
        });

        if (globalConfig) {
            accesses.push({ location: null, isPrimary: true });
        }
    }

    return accesses;
}
```

### Why This Matters
- **Scalability**: Different locations have different IT/HR teams
- **Delegation**: Tracks when approver is temporarily replaced
- **Escalation**: Primary approvers have 48-hour window before escalation to secondary

### Common Violations
❌ Not checking location overrides for IT_OPS/HR_INITIATOR
❌ Not tracking original delegator when temporary delegation is active
❌ Not falling back to global config when no location match found

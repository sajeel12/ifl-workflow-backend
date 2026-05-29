# SSO & Authentication Guardian

A comprehensive skill for auditing, verifying, and enforcing SSO, session management, and authentication rules in the IFL Workflow application.

## What This Skill Does

This skill helps ensure your authentication implementation is secure, compliant, and follows established patterns. It:

1. **Audits current authentication** - Analyzes SSO middleware, session management, and route protection
2. **Validates new code** - Ensures new routes and features follow security patterns
3. **Identifies violations** - Flags security risks and pattern violations by severity
4. **Provides fixes** - Offers actionable code examples and remediation steps
5. **Generates reports** - Creates comprehensive compliance reports with recommendations

## When to Use This Skill

Invoke this skill when you need to:

- ✅ Add new API routes or endpoints
- ✅ Modify authentication or authorization code
- ✅ Review security before production deployment
- ✅ Add new portal roles or workflow stages
- ✅ Investigate authentication issues
- ✅ Perform periodic security audits
- ✅ Onboard new developers (understand auth architecture)

## How to Use

### Method 1: Direct Invocation

In your conversation with Claude Code, simply type:

```
/sso-auth-guardian
```

Or invoke via the Skill tool:

```
Use the sso-auth-guardian skill to audit authentication
```

### Method 2: Specific Request

Ask Claude Code to verify authentication for specific changes:

```
I'm adding a new route /api/workflow/approve. Can you verify it follows auth rules?
```

```
Use sso-auth-guardian to check if my new admin endpoint is secure
```

### Method 3: General Audit

Request a full authentication audit:

```
Run a complete authentication audit with sso-auth-guardian
```

```
Use sso-auth-guardian to verify all routes are properly protected
```

## What You'll Get

### Audit Report Structure

1. **Executive Summary** - Quick overview of compliance status
2. **Authentication Status** - Compliant or issues found
3. **Critical Issues** - Security risks requiring immediate fix (with code examples)
4. **High Priority Issues** - Important problems to address soon
5. **Medium Priority Issues** - Improvements to consider
6. **Low Priority Issues** - Nice-to-have optimizations
7. **Verification Steps** - How to test the fixes
8. **Future Recommendations** - Long-term improvements

### Example Output

```markdown
## Authentication Audit Report

### Executive Summary
Analyzed 47 routes across 3 route files. Found 2 critical issues requiring
immediate attention and 3 high-priority improvements.

### Critical Issues ❌

**Issue 1: Admin route returning 401**
File: src/routes/admin.js:42
Risk: Triggers IIS Windows Auth popup loop on AJAX requests

Current Code:
```javascript
if (!isAdmin) {
    return res.status(401).json({ error: 'Unauthorized' });
}
```

Fix:
```javascript
if (!isAdmin) {
    return res.status(403).json({ error: 'Forbidden - admin access required' });
}
```

**Issue 2: ssoMiddleware before multer on file upload**
File: src/routes/api.js:67
Risk: req.body is empty, sidecar token validation fails

Current Code:
```javascript
router.post('/upload', ssoMiddleware, upload.array('files'), handler);
```

Fix:
```javascript
router.post('/upload', upload.array('files'), ssoMiddleware, handler);
```

[... additional details ...]
```

## Reference Documentation

This skill includes comprehensive reference documentation:

### 1. `references/security-patterns.md`
Detailed explanations of all security patterns:
- HMAC Token Validation
- Loopback-Only Proxy Trust
- Admin Route Protection
- Multer Ordering
- Portal Session Management
- Request Token Lifecycle
- Domain Normalization
- Location-Aware Authorization

Each pattern includes:
- Implementation details
- Security rationale
- Common violations
- Testing strategies

### 2. `references/audit-checklist.md`
Quick compliance checklist covering:
- SSO middleware validation
- Route protection analysis
- File upload routes
- Portal session management
- Request token authentication
- Security pattern compliance
- Environment configuration
- Common violation patterns

### 3. `references/architecture-overview.md`
Complete authentication architecture guide:
- System architecture diagram
- All authentication flows (4 types)
- Token types and formats
- Middleware stack patterns
- Role configuration
- Authorization resolution
- Environment variables
- Security best practices
- Troubleshooting guide

## Key Security Patterns Enforced

This skill verifies compliance with these critical patterns:

### 1. Timing-Safe HMAC Comparison
✅ Uses `crypto.timingSafeEqual()` to prevent timing attacks
❌ Never uses `===` for signature comparison

### 2. Loopback-Only Proxy Trust
✅ Only trusts `X-Auth-User` from 127.0.0.1 or ::1
❌ Never trusts proxy headers from external IPs

### 3. No 401 on Admin Routes
✅ Returns 403 (Forbidden) to prevent IIS popup loops
❌ Never returns 401 (Unauthorized) from admin endpoints

### 4. Multer Before ssoMiddleware
✅ File upload: `upload.array()` → `ssoMiddleware` → `controller`
❌ Never runs ssoMiddleware before multer (breaks auth)

### 5. Portal Session Validation
✅ Validates token exists, hasn't expired, and role matches
❌ Never trusts session token without validation

### 6. Single-Use Action Tokens
✅ Clears `currentStageToken` after processing action
❌ Never reuses tokens across workflow stages

## Files Monitored

The skill pays special attention to these critical files:

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

**Configuration:**
- `web.config`
- `.env`
- `server.js`

## Common Issues Detected

### Critical Violations
- Admin routes returning 401 (triggers IIS popup loop)
- ssoMiddleware before multer on uploads (breaks auth)
- Portal routes using ssoMiddleware (breaks IIS proxy)
- Unsafe HMAC comparison (timing attack vulnerability)
- Trusting proxy headers from non-loopback IPs

### High Priority
- Protected routes missing ssoMiddleware
- Token validation missing email match check
- Session tokens not validated
- Missing token age checks

### Medium Priority
- Inconsistent domain stripping
- Missing v1/v2 HMAC signature support
- Email-only matching without username fallback

### Low Priority
- Inconsistent error messages
- Missing audit logging
- Suboptimal session cleanup

## Integration with Development Workflow

### Before Code Review
```bash
# In Claude Code chat:
Use sso-auth-guardian to audit my authentication changes before code review
```

### Before Deployment
```bash
# In Claude Code chat:
Run a full authentication audit with sso-auth-guardian before we deploy to production
```

### After Adding Routes
```bash
# In Claude Code chat:
I just added 3 new API endpoints. Use sso-auth-guardian to verify they're secure.
```

### Investigating Issues
```bash
# In Claude Code chat:
Users are seeing Windows Auth popups on the admin panel. Use sso-auth-guardian to diagnose.
```

## Compliance Scoring

The skill generates a compliance score based on checks passed:

- **95-100%** - Excellent, production-ready
- **85-94%** - Good, minor improvements needed
- **75-84%** - Fair, address high-priority issues
- **Below 75%** - Needs work, security risks present

## Future Improvements Suggested

The skill may recommend these long-term improvements:

1. **Centralized Route Registry** - Declare auth requirements in config
2. **Automated Testing** - Expand integration test coverage
3. **Enhanced Documentation** - In-code comments for patterns
4. **Monitoring & Logging** - Track auth events and failures
5. **Session Store Migration** - Move from in-memory to Redis/database

## Contributing

To improve this skill:

1. Edit `SKILL.md` for instructions and logic
2. Update `references/` for pattern documentation
3. Add new patterns to the audit checklist
4. Expand troubleshooting guide with new scenarios

### 4. `references/windows-auth-intranet-zone-issues.md` (NEW - May 29, 2026)
Comprehensive troubleshooting guide for Windows Authentication popup issues:
- Current status: Working with IP, pending fix for hostname
- Root cause analysis: Port 3333 not in Intranet zone for hostname entries
- Windows Intranet zone matching rules (domains vs IP ranges)
- IIS log analysis patterns
- Solution options (immediate, short-term, long-term)
- Built-in diagnostic tools documentation
- AD admin instructions for Group Policy updates
- Pending action checklist

## Diagnostic Tools (Added May 29, 2026)

The skill now includes built-in diagnostic tools for troubleshooting Windows Authentication:

### 1. Full Diagnostic UI
**URL:** `/diagnostics/auth-ui`

Tests all 5 authentication layers:
- BROWSER: Connection and request capabilities
- IIS: Windows Authentication and X-Auth-User header
- token.aspx: HMAC token generation with AD lookup
- NETWORK: Loopback trust validation
- NODE.JS: HMAC signature validation (timing-safe)

### 2. Simple Test Page
**URL:** `/test-auth.html`

Quick authentication validation:
- Connection test
- token.aspx authentication check
- Diagnostics API call

### 3. Browser Fix Guide
**URL:** `/fix-windows-auth.html`

Interactive troubleshooting guide:
- URL validation
- Browser configuration checks
- Registry verification
- Step-by-step fixes

### 4. Documentation
- `DIAGNOSTICS.md` - How to use diagnostic tools
- `TROUBLESHOOTING_POPUP.md` - Windows Auth popup troubleshooting
- `EDGE_POPUP_FIX.md` - Edge-specific SSO fixes
- `NEXT_STEPS.md` - Step-by-step fix instructions

## Current Known Issues (May 29, 2026)

### Windows Authentication with Hostname
**Status:** ⏳ Pending AD admin fix

**Issue:**
- ✅ SSO works: `http://192.168.1.92:3333` (IP address)
- ❌ Popup shown: `http://hosppdevsrv.ifl.net:3333` (hostname with port)

**Root Cause:**
Windows Intranet zone matches domain entries only on default ports (80/443). Custom port 3333 requires explicit Group Policy registry entry.

**Workaround:**
Use IP address until AD admin adds port 3333 to Group Policy.

**Pending:**
AD admin to add:
```powershell
HKLM:\...\ZoneMap\Domains\hosppdevsrv
  3333 = 1

HKLM:\...\ZoneMap\Domains\ifl.net\hosppdevsrv
  3333 = 1
```

## Version History

- **v1.1** (2026-05-29) - Added Windows Authentication diagnostics, Intranet zone troubleshooting, and comprehensive diagnostic tools
- **v1.0** (2026-05-29) - Initial release with comprehensive audit capabilities

## Support

For issues or questions about this skill:
1. Check the reference documentation in `references/`
2. Review the troubleshooting guide in `architecture-overview.md`
3. Ask Claude Code for help interpreting audit results

---

**Maintained By:** Claude Code Skill Creator
**License:** MIT
**Last Updated:** 2026-05-29

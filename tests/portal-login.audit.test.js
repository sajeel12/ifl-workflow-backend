import { jest, describe, test, expect, afterEach } from '@jest/globals';

/**
 * Portal login flow audit — two entry scenarios
 *
 * Scenario 1 — Direct portal link  /portal/it-ops
 *   User navigates to the portal without an action token (bookmark, admin link, etc.)
 *   showLogin renders portal_loading.ejs; client JS then calls
 *   /api/portal-auth/it-ops via window.iflFetch (sidecar token from token.aspx).
 *   Fast path: if IIS has already resolved Windows identity and set X-Auth-User,
 *   showLogin skips the loading page and redirects straight to the dashboard.
 *
 * Scenario 2 — Email action link  /portal/it-ops/enter?action=TOKEN
 *   User clicks the CTA button in their notification email.
 *   enterViaActionToken validates the token, then renders portal_loading.ejs;
 *   client JS calls /api/portal-auth/it-ops?action=TOKEN so the dashboard
 *   opens with that specific request expanded.
 *
 * In both scenarios the final common step is apiPortalAuth:
 *   - resolves access from config tables (location override → global fallback)
 *   - issues an 8-hour session token
 *   - returns { redirect: '/portal/it-ops/view?token=SESSION[&expand=ID]' }
 *
 * Key difference between the two scenarios:
 *   Scenario 1 → authUrl has NO action token → redirect has NO &expand
 *   Scenario 2 → authUrl carries the action token → redirect includes &expand=<requestId>
 */

afterEach(() => { jest.resetModules(); });

// ── Shared fixtures ────────────────────────────────────────────────────────────

const ACTION_TOKEN  = 'email-action-tok-abc';
const SESSION_TOKEN = 'portal-session-tok-xyz';
const REQUEST_ID    = 42;

function makeOverride(overrides = {}) {
    return {
        roleKey:          'IT_OPS',
        location:         'KHI',
        approverEmail:    'itops.khi@ifl.com',
        approverUsername: 'itops.khi',
        approverName:     'IT Ops KHI',
        secondaryEmail:   'itops.khi2@ifl.com',
        secondaryUsername:'itops.khi2',
        secondaryName:    'IT Ops KHI Secondary',
        primaryExpiredAt: null,
        isActive:         true,
        ...overrides
    };
}

function makeDbRequest(overrides = {}) {
    return {
        id:                REQUEST_ID,
        status:            'PendingIT',
        location:          'KHI',
        currentStageToken: ACTION_TOKEN,
        ...overrides
    };
}

function mockRes() {
    return {
        status:   jest.fn().mockReturnThis(),
        json:     jest.fn().mockReturnThis(),
        render:   jest.fn().mockReturnThis(),
        redirect: jest.fn().mockReturnThis(),
        send:     jest.fn().mockReturnThis(),
    };
}

async function loadController({
    overrideRows    = [makeOverride()],
    globalCfg       = null,
    dbRequest       = makeDbRequest(),
    pendingRequests = [],
} = {}) {
    jest.resetModules();

    const issueToken   = jest.fn().mockReturnValue(SESSION_TOKEN);
    const validateToken = jest.fn().mockReturnValue(null);

    await jest.unstable_mockModule('../src/models/OnboardingRequest.js', () => ({
        default: {
            findOne: jest.fn().mockImplementation(({ where } = {}) => {
                if (where?.currentStageToken === ACTION_TOKEN) return Promise.resolve(dbRequest);
                return Promise.resolve(null);
            }),
            // First findAll call = pending queue; subsequent calls = history (empty)
            findAll: jest.fn()
                .mockResolvedValueOnce(pendingRequests)
                .mockResolvedValue([]),
        }
    }));
    await jest.unstable_mockModule('../src/models/WorkflowApproverLocationOverride.js', () => ({
        default: {
            findAll: jest.fn().mockResolvedValue(overrideRows),
            findOne: jest.fn().mockResolvedValue(null),
        }
    }));
    await jest.unstable_mockModule('../src/models/WorkflowApproverConfig.js', () => ({
        default: {
            findOne: jest.fn().mockResolvedValue(globalCfg),
            findAll: jest.fn().mockResolvedValue([]),
        }
    }));
    await jest.unstable_mockModule('../src/services/portalTokenService.js', () => ({
        issueToken,
        validateToken,
    }));
    await jest.unstable_mockModule('../src/utils/emailMatch.js', () => ({
        emailsMatch: (a, b) => (a || '').toLowerCase() === (b || '').toLowerCase(),
    }));
    await jest.unstable_mockModule('../src/utils/locationGroups.js', () => ({
        groupLabel: jest.fn().mockReturnValue('KHI'),
    }));
    await jest.unstable_mockModule('../src/utils/logger.js', () => ({
        default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    }));
    await jest.unstable_mockModule('sequelize', () => ({
        Op: { in: Symbol('in'), notIn: Symbol('notIn') }
    }));

    const { showLogin, enterViaActionToken, apiPortalAuth, showDashboard } =
        await import('../src/controllers/portalController.js');

    return { showLogin, enterViaActionToken, apiPortalAuth, showDashboard, issueToken, validateToken };
}

// ══════════════════════════════════════════════════════════════════════════════
// Scenario 1 — Direct portal link  /portal/it-ops  (no action token)
// ══════════════════════════════════════════════════════════════════════════════

describe('Scenario 1 — Direct portal link (/portal/it-ops)', () => {

    // ── showLogin ──────────────────────────────────────────────────────────────

    describe('showLogin — GET /portal/it-ops', () => {

        test('normal case: no X-Auth-User → renders portal_loading with authUrl pointing to /api/portal-auth/it-ops (no action token in URL)', async () => {
            const { showLogin } = await loadController();
            const req = { params: { roleSlug: 'it-ops' }, query: {}, headers: {} };
            const res = mockRes();

            await showLogin(req, res);

            // Must render the loading spinner — NOT redirect
            expect(res.render).toHaveBeenCalledWith('pages/portal_loading', expect.objectContaining({
                roleSlug: 'it-ops',
                authUrl:  '/api/portal-auth/it-ops',   // no ?action= appended
            }));
            expect(res.redirect).not.toHaveBeenCalled();
        });

        test('fast path: X-Auth-User present and configured → redirects straight to /portal/it-ops/view (no loading page)', async () => {
            const { showLogin, issueToken } = await loadController();
            const req = {
                params:  { roleSlug: 'it-ops' },
                query:   {},
                headers: { 'x-auth-user': 'IFL\\itops.khi' },   // IIS sets this post-auth
            };
            const res = mockRes();

            await showLogin(req, res);

            // Loading page skipped — goes directly to dashboard
            expect(res.render).not.toHaveBeenCalled();
            expect(res.redirect).toHaveBeenCalledWith(
                expect.stringContaining(`/portal/it-ops/view?token=${SESSION_TOKEN}`)
            );
            // No &expand= because there is no action token
            const redirectArg = res.redirect.mock.calls[0][0];
            expect(redirectArg).not.toContain('expand');
            expect(issueToken).toHaveBeenCalledWith(expect.objectContaining({
                roleKey:  'IT_OPS',
                username: 'itops.khi',
            }));
        });

        test('fast path: X-Auth-User present but user not in any config → falls through to loading page (no 403 from showLogin itself)', async () => {
            const { showLogin } = await loadController({ overrideRows: [makeOverride()] });
            const req = {
                params:  { roleSlug: 'it-ops' },
                query:   {},
                headers: { 'x-auth-user': 'IFL\\stranger.user' },  // not configured
            };
            const res = mockRes();

            await showLogin(req, res);

            // Falls through to loading page — showLogin does NOT 403; auth enforced at apiPortalAuth
            expect(res.render).toHaveBeenCalledWith('pages/portal_loading', expect.objectContaining({
                authUrl: '/api/portal-auth/it-ops',
            }));
            expect(res.redirect).not.toHaveBeenCalled();
        });

        test('unknown roleSlug → 404', async () => {
            const { showLogin } = await loadController();
            const req = { params: { roleSlug: 'unknown-role' }, query: {}, headers: {} };
            const res = mockRes();

            await showLogin(req, res);

            expect(res.status).toHaveBeenCalledWith(404);
        });
    });

    // ── apiPortalAuth (called by client JS after sidecar token acquired) ────────

    describe('apiPortalAuth — GET /api/portal-auth/it-ops  (no action token)', () => {

        test('configured primary user → issues session token → returns redirect to /portal/it-ops/view (no &expand)', async () => {
            const { apiPortalAuth, issueToken } = await loadController();
            const req = {
                params: { roleSlug: 'it-ops' },
                query:  { action: '' },
                user:   { username: 'itops.khi', email: 'itops.khi@ifl.com' },
            };
            const res = mockRes();

            await apiPortalAuth(req, res);

            expect(issueToken).toHaveBeenCalledWith(expect.objectContaining({
                roleKey:  'IT_OPS',
                username: 'itops.khi',
            }));
            const payload = res.json.mock.calls[0][0];
            expect(payload.redirect).toBe(`/portal/it-ops/view?token=${SESSION_TOKEN}`);
            // No expand — user landed on portal directly, no specific request to open
            expect(payload.redirect).not.toContain('expand');
        });

        test('configured secondary user → also granted access (not blocked)', async () => {
            const { apiPortalAuth, issueToken } = await loadController();
            const req = {
                params: { roleSlug: 'it-ops' },
                query:  { action: '' },
                user:   { username: 'itops.khi2', email: 'itops.khi2@ifl.com' },
            };
            const res = mockRes();

            await apiPortalAuth(req, res);

            expect(res.status).not.toHaveBeenCalledWith(403);
            expect(issueToken).toHaveBeenCalled();
            const payload = res.json.mock.calls[0][0];
            expect(payload.redirect).toContain('/portal/it-ops/view?token=');
        });

        test('user not in any config row → 403 with clear message', async () => {
            const { apiPortalAuth } = await loadController({ overrideRows: [makeOverride()], globalCfg: null });
            const req = {
                params: { roleSlug: 'it-ops' },
                query:  { action: '' },
                user:   { username: 'stranger.user', email: 'stranger@ifl.com' },
            };
            const res = mockRes();

            await apiPortalAuth(req, res);

            expect(res.status).toHaveBeenCalledWith(403);
            const body = res.json.mock.calls[0][0];
            expect(body.error).toMatch(/not configured/i);
        });

        test('no username in sidecar token (identity resolution failed) → 403', async () => {
            const { apiPortalAuth } = await loadController();
            const req = {
                params: { roleSlug: 'it-ops' },
                query:  { action: '' },
                user:   { username: '', email: '' },    // token.aspx returned no identity
            };
            const res = mockRes();

            await apiPortalAuth(req, res);

            expect(res.status).toHaveBeenCalledWith(403);
        });

        test('unknown roleSlug → 404', async () => {
            const { apiPortalAuth } = await loadController();
            const req = {
                params: { roleSlug: 'not-a-real-portal' },
                query:  { action: '' },
                user:   { username: 'itops.khi' },
            };
            const res = mockRes();

            await apiPortalAuth(req, res);

            expect(res.status).toHaveBeenCalledWith(404);
        });
    });
});

// ══════════════════════════════════════════════════════════════════════════════
// Scenario 2 — Email action link  /portal/it-ops/enter?action=TOKEN
// ══════════════════════════════════════════════════════════════════════════════

describe('Scenario 2 — Email action link (/portal/it-ops/enter?action=TOKEN)', () => {

    // ── enterViaActionToken ────────────────────────────────────────────────────

    describe('enterViaActionToken — GET /portal/it-ops/enter?action=TOKEN', () => {

        test('valid token, no X-Auth-User → renders portal_loading with authUrl carrying the action token', async () => {
            const { enterViaActionToken } = await loadController();
            const req = {
                params:  { roleSlug: 'it-ops' },
                query:   { action: ACTION_TOKEN },
                headers: {},
            };
            const res = mockRes();

            await enterViaActionToken(req, res);

            // Loading page rendered — client JS will call /api/portal-auth with the action token
            expect(res.render).toHaveBeenCalledWith('pages/portal_loading', expect.objectContaining({
                roleSlug: 'it-ops',
                authUrl:  expect.stringContaining(`/api/portal-auth/it-ops?action=${encodeURIComponent(ACTION_TOKEN)}`),
            }));
            expect(res.redirect).not.toHaveBeenCalled();
        });

        test('valid token, X-Auth-User present, configured user → skips loading page, redirects to view WITH expand=requestId', async () => {
            const { enterViaActionToken, issueToken } = await loadController();
            const req = {
                params:  { roleSlug: 'it-ops' },
                query:   { action: ACTION_TOKEN },
                headers: { 'x-auth-user': 'IFL\\itops.khi' },
            };
            const res = mockRes();

            await enterViaActionToken(req, res);

            expect(res.render).not.toHaveBeenCalled();
            const target = res.redirect.mock.calls[0][0];
            expect(target).toContain(`/portal/it-ops/view?token=${SESSION_TOKEN}`);
            // expand IS present — this is the email-link scenario
            expect(target).toContain(`expand=${REQUEST_ID}`);
        });

        test('action token not found in DB (link expired / already used) → redirects to portal with ?expired=1', async () => {
            const { enterViaActionToken } = await loadController({ dbRequest: null });
            // Override findOne to return null for any token
            jest.resetModules();
            const { enterViaActionToken: handler } = await (async () => {
                await jest.unstable_mockModule('../src/models/OnboardingRequest.js', () => ({
                    default: { findOne: jest.fn().mockResolvedValue(null), findAll: jest.fn().mockResolvedValue([]) }
                }));
                await jest.unstable_mockModule('../src/models/WorkflowApproverLocationOverride.js', () => ({
                    default: { findAll: jest.fn().mockResolvedValue([]), findOne: jest.fn().mockResolvedValue(null) }
                }));
                await jest.unstable_mockModule('../src/models/WorkflowApproverConfig.js', () => ({
                    default: { findOne: jest.fn().mockResolvedValue(null) }
                }));
                await jest.unstable_mockModule('../src/services/portalTokenService.js', () => ({
                    issueToken: jest.fn().mockReturnValue(SESSION_TOKEN), validateToken: jest.fn()
                }));
                await jest.unstable_mockModule('../src/utils/emailMatch.js', () => ({ emailsMatch: (a, b) => a === b }));
                await jest.unstable_mockModule('../src/utils/locationGroups.js', () => ({ groupLabel: jest.fn() }));
                await jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
                await jest.unstable_mockModule('sequelize', () => ({ Op: { in: Symbol(), notIn: Symbol() } }));
                return import('../src/controllers/portalController.js');
            })();

            const req = { params: { roleSlug: 'it-ops' }, query: { action: 'stale-token' }, headers: {} };
            const res = mockRes();

            await handler(req, res);

            expect(res.redirect).toHaveBeenCalledWith('/portal/it-ops?expired=1');
        });

        test('missing action token in URL → redirects to portal root (strips to login page)', async () => {
            const { enterViaActionToken } = await loadController();
            const req = {
                params:  { roleSlug: 'it-ops' },
                query:   { action: '' },        // no token
                headers: {},
            };
            const res = mockRes();

            await enterViaActionToken(req, res);

            expect(res.redirect).toHaveBeenCalledWith('/portal/it-ops');
            expect(res.render).not.toHaveBeenCalled();
        });

        test('request has moved to a different stage → redirects to the correct portal entry (auto-correct)', async () => {
            // Token was issued for it-ops but request is now PendingDCI
            const movedRequest = makeDbRequest({ status: 'PendingDCI' });
            const { enterViaActionToken } = await loadController({ dbRequest: movedRequest });
            const req = {
                params:  { roleSlug: 'it-ops' },      // original (now wrong) portal
                query:   { action: ACTION_TOKEN },
                headers: {},
            };
            const res = mockRes();

            await enterViaActionToken(req, res);

            // Redirects to the correct portal with the same token — NOT renders loading page
            expect(res.redirect).toHaveBeenCalledWith(
                `/portal/dci-team/enter?action=${ACTION_TOKEN}`
            );
            expect(res.render).not.toHaveBeenCalled();
        });
    });

    // ── apiPortalAuth (called by client JS with action token) ──────────────────

    describe('apiPortalAuth — GET /api/portal-auth/it-ops?action=TOKEN', () => {

        test('configured user with valid action token → redirect includes &expand=requestId', async () => {
            const { apiPortalAuth, issueToken } = await loadController();
            const req = {
                params: { roleSlug: 'it-ops' },
                query:  { action: ACTION_TOKEN },
                user:   { username: 'itops.khi', email: 'itops.khi@ifl.com' },
            };
            const res = mockRes();

            await apiPortalAuth(req, res);

            expect(issueToken).toHaveBeenCalledWith(expect.objectContaining({ roleKey: 'IT_OPS' }));
            const payload = res.json.mock.calls[0][0];
            // Both the session token AND the specific request ID are in the redirect
            expect(payload.redirect).toContain(`token=${SESSION_TOKEN}`);
            expect(payload.redirect).toContain(`expand=${REQUEST_ID}`);
        });

        test('secondary IT Ops user with valid action token → granted access (secondary is a valid seat)', async () => {
            const { apiPortalAuth } = await loadController();
            const req = {
                params: { roleSlug: 'it-ops' },
                query:  { action: ACTION_TOKEN },
                user:   { username: 'itops.khi2', email: 'itops.khi2@ifl.com' },
            };
            const res = mockRes();

            await apiPortalAuth(req, res);

            expect(res.status).not.toHaveBeenCalledWith(403);
            const payload = res.json.mock.calls[0][0];
            expect(payload.redirect).toContain(`expand=${REQUEST_ID}`);
        });

        test('user not configured for this role → 403, no session token issued', async () => {
            const { apiPortalAuth, issueToken } = await loadController({ overrideRows: [makeOverride()], globalCfg: null });
            const req = {
                params: { roleSlug: 'it-ops' },
                query:  { action: ACTION_TOKEN },
                user:   { username: 'wrong.person', email: 'wrong@ifl.com' },
            };
            const res = mockRes();

            await apiPortalAuth(req, res);

            expect(res.status).toHaveBeenCalledWith(403);
            expect(issueToken).not.toHaveBeenCalled();
        });

        test('action token not found in DB → treated as direct portal access, still logs in if configured (no expand)', async () => {
            const { apiPortalAuth } = await loadController({ dbRequest: null });
            // Simulate token not found: override findOne to return null
            jest.resetModules();
            const { apiPortalAuth: handler } = await (async () => {
                await jest.unstable_mockModule('../src/models/OnboardingRequest.js', () => ({
                    default: { findOne: jest.fn().mockResolvedValue(null), findAll: jest.fn().mockResolvedValue([]) }
                }));
                await jest.unstable_mockModule('../src/models/WorkflowApproverLocationOverride.js', () => ({
                    default: { findAll: jest.fn().mockResolvedValue([makeOverride()]), findOne: jest.fn().mockResolvedValue(null) }
                }));
                await jest.unstable_mockModule('../src/models/WorkflowApproverConfig.js', () => ({
                    default: { findOne: jest.fn().mockResolvedValue(null) }
                }));
                await jest.unstable_mockModule('../src/services/portalTokenService.js', () => ({
                    issueToken: jest.fn().mockReturnValue(SESSION_TOKEN), validateToken: jest.fn()
                }));
                await jest.unstable_mockModule('../src/utils/emailMatch.js', () => ({ emailsMatch: (a, b) => a === b }));
                await jest.unstable_mockModule('../src/utils/locationGroups.js', () => ({ groupLabel: jest.fn() }));
                await jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
                await jest.unstable_mockModule('sequelize', () => ({ Op: { in: Symbol(), notIn: Symbol() } }));
                return import('../src/controllers/portalController.js');
            })();

            const req = {
                params: { roleSlug: 'it-ops' },
                query:  { action: 'expired-or-wrong-token' },
                user:   { username: 'itops.khi', email: 'itops.khi@ifl.com' },
            };
            const res = mockRes();

            await handler(req, res);

            // User is still authenticated — just no expand
            const payload = res.json.mock.calls[0][0];
            expect(payload.redirect).toContain(`/portal/it-ops/view?token=${SESSION_TOKEN}`);
            expect(payload.redirect).not.toContain('expand');
        });

        test('action token found but request has moved stages → issues token for correct portal, redirect is to correct portal', async () => {

            const movedRequest = makeDbRequest({ status: 'PendingDCI' });

            jest.resetModules();
            const { apiPortalAuth: handler } = await (async () => {
                const issueToken = jest.fn().mockReturnValue(SESSION_TOKEN);
                await jest.unstable_mockModule('../src/models/OnboardingRequest.js', () => ({
                    default: {
                        findOne: jest.fn().mockImplementation(({ where } = {}) => {
                            if (where?.currentStageToken === ACTION_TOKEN) return Promise.resolve(movedRequest);
                            return Promise.resolve(null);
                        }),
                        findAll: jest.fn().mockResolvedValue([])
                    }
                }));
                // DCI_TEAM uses global config (not location-aware)
                await jest.unstable_mockModule('../src/models/WorkflowApproverLocationOverride.js', () => ({
                    default: { findAll: jest.fn().mockResolvedValue([]), findOne: jest.fn().mockResolvedValue(null) }
                }));
                await jest.unstable_mockModule('../src/models/WorkflowApproverConfig.js', () => ({
                    default: {
                        findOne: jest.fn().mockResolvedValue({
                            roleKey:          'DCI_TEAM',
                            approverEmail:    'dci.team@ifl.com',
                            approverUsername: 'dci.team',
                            approverName:     'DCI Team',
                            secondaryEmail:   null,
                            secondaryUsername:null,
                            primaryExpiredAt: null,
                            isDelegatedTemporarily: false,
                            isActive:         true,
                        })
                    }
                }));
                await jest.unstable_mockModule('../src/services/portalTokenService.js', () => ({
                    issueToken, validateToken: jest.fn()
                }));
                await jest.unstable_mockModule('../src/utils/emailMatch.js', () => ({ emailsMatch: (a, b) => a === b }));
                await jest.unstable_mockModule('../src/utils/locationGroups.js', () => ({ groupLabel: jest.fn() }));
                await jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
                await jest.unstable_mockModule('sequelize', () => ({ Op: { in: Symbol(), notIn: Symbol() } }));
                return import('../src/controllers/portalController.js');
            })();

            const req = {
                params: { roleSlug: 'it-ops' },    // original (stale) portal slug
                query:  { action: ACTION_TOKEN },
                user:   { username: 'dci.team', email: 'dci.team@ifl.com' },
            };
            const res = mockRes();

            await handler(req, res);

            // Auth for the CORRECT role, redirect to correct portal
            const payload = res.json.mock.calls[0][0];
            expect(payload.redirect).toContain('/portal/dci-team/view');
            expect(payload.redirect).toContain(`expand=${REQUEST_ID}`);
        });
    });
});

// ══════════════════════════════════════════════════════════════════════════════
// Scenario 3 — Concurrent primary + secondary sessions with mixed canAct state
//
// Business rule: both primary and secondary persons can log into the portal
// simultaneously. Each sees ALL pending requests for their location. Whether
// they can act on a specific request is controlled per-row by
// currentStageAssigneeEmail — not by who is primary vs secondary.
//
// Setup: 5 PendingIT requests at KHI
//   • Requests #1 and #2 still assigned to primary (itops.khi@ifl.com)
//   • Requests #3, #4, #5 escalated to secondary (itops.khi2@ifl.com)
//
// Expected behaviour:
//   Primary session   → pendingCount 5, actionCount 2, canAct true only for #1 & #2
//   Secondary session → pendingCount 5, actionCount 3, canAct true only for #3 #4 #5
//   Delegator session → pendingCount 5, actionCount 0  (read-only regardless of assignee)
// ══════════════════════════════════════════════════════════════════════════════

describe('Scenario 3 — Concurrent primary + secondary sessions (mixed canAct)', () => {

    // 5 PendingIT requests: 2 at primary, 3 escalated to secondary
    function makeMixedRequests() {
        const makeReq = (id, assigneeEmail) => {
            const data = {
                id,
                status:                    'PendingIT',
                location:                  'KHI',
                currentStageToken:         `tok-req-${id}`,
                currentStageAssigneeEmail: assigneeEmail,
            };
            return { ...data, toJSON: () => ({ ...data }) };
        };
        return [
            makeReq(1, 'itops.khi@ifl.com'),   // primary
            makeReq(2, 'itops.khi@ifl.com'),   // primary
            makeReq(3, 'itops.khi2@ifl.com'),  // escalated → secondary
            makeReq(4, 'itops.khi2@ifl.com'),  // escalated → secondary
            makeReq(5, 'itops.khi2@ifl.com'),  // escalated → secondary
        ];
    }

    const primarySession = {
        roleKey:  'IT_OPS',
        username: 'itops.khi',
        email:    'itops.khi@ifl.com',
        accesses: [{ location: 'KHI', isPrimary: true }],
        roleName: 'IT Operations',
    };

    const secondarySession = {
        roleKey:  'IT_OPS',
        username: 'itops.khi2',
        email:    'itops.khi2@ifl.com',
        accesses: [{ location: 'KHI', isPrimary: false }],
        roleName: 'IT Operations',
    };

    const delegatorSession = {
        ...primarySession,
        isDelegator:   true,
        delegateName:  'Temp Delegate',
        delegateEmail: 'delegate@ifl.com',
    };

    test('primary user sees all 5 requests but canAct only on the 2 still assigned to primary', async () => {
        const mixed = makeMixedRequests();
        const { showDashboard, validateToken } = await loadController({ pendingRequests: mixed });
        validateToken.mockReturnValue(primarySession);

        const req = { params: { roleSlug: 'it-ops' }, query: { token: 'primary-session-tok' } };
        const res = mockRes();

        await showDashboard(req, res);

        expect(res.render).toHaveBeenCalledWith('pages/portal_dashboard', expect.any(Object));
        const { pending, pendingCount, actionCount } = res.render.mock.calls[0][1];

        expect(pendingCount).toBe(5);
        expect(actionCount).toBe(2);

        const actable = pending.filter(r => r.canAct).map(r => r.id);
        const blocked = pending.filter(r => !r.canAct).map(r => r.id);
        expect(actable).toEqual([1, 2]);
        expect(blocked).toEqual([3, 4, 5]);
    });

    test('secondary user sees all 5 requests but canAct only on the 3 escalated to secondary', async () => {
        const mixed = makeMixedRequests();
        const { showDashboard, validateToken } = await loadController({ pendingRequests: mixed });
        validateToken.mockReturnValue(secondarySession);

        const req = { params: { roleSlug: 'it-ops' }, query: { token: 'secondary-session-tok' } };
        const res = mockRes();

        await showDashboard(req, res);

        expect(res.render).toHaveBeenCalledWith('pages/portal_dashboard', expect.any(Object));
        const { pending, pendingCount, actionCount } = res.render.mock.calls[0][1];

        expect(pendingCount).toBe(5);
        expect(actionCount).toBe(3);

        const actable = pending.filter(r => r.canAct).map(r => r.id);
        const blocked = pending.filter(r => !r.canAct).map(r => r.id);
        expect(actable).toEqual([3, 4, 5]);
        expect(blocked).toEqual([1, 2]);
    });

    test('original delegator session (isDelegator: true) sees all 5 requests but actionCount is 0 — read-only', async () => {
        const mixed = makeMixedRequests();
        const { showDashboard, validateToken } = await loadController({ pendingRequests: mixed });
        validateToken.mockReturnValue(delegatorSession);

        const req = { params: { roleSlug: 'it-ops' }, query: { token: 'delegator-session-tok' } };
        const res = mockRes();

        await showDashboard(req, res);

        expect(res.render).toHaveBeenCalledWith('pages/portal_dashboard', expect.any(Object));
        const { pending, pendingCount, actionCount, isDelegator } = res.render.mock.calls[0][1];

        expect(pendingCount).toBe(5);
        expect(actionCount).toBe(0);
        expect(isDelegator).toBe(true);
        expect(pending.every(r => r.canAct === false)).toBe(true);
    });
});

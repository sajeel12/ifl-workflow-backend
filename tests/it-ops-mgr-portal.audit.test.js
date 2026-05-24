import { jest, describe, test, expect, afterEach } from '@jest/globals';

/**
 * IT Operations Manager portal audit
 *
 * Business rules under test:
 *  - The IT_OPS_MGR role uses the same SSO / sidecar-token auth as all other portals.
 *  - Delegation works identically to DCI_MANAGER / IT_HOD: original manager gets
 *    read-only access (isDelegator=true) when temporarily delegated.
 *  - showDashboard for IT_OPS_MGR queries IT_OPS location overrides + all
 *    PendingIT / PendingOPSAction requests and builds:
 *      - locationSummary (per-location: primary, secondary, isEscalated, activeCount)
 *      - enrichedRequests (stageAgeHours, isStale, isEscalated, primaryName, secondaryName)
 *  - isEscalated=true when the location config has primaryExpiredAt set.
 *  - isStale=true when stageAgeHours > 48.
 *  - stageAgeHours measured from hrSubmittedAt for PendingIT,
 *    dciImplementedAt for PendingOPSAction.
 *  - pendingRequests rendered without canAct (pure monitoring — no action buttons).
 */

afterEach(() => {
    jest.resetModules();
    delete process.env.APP_URL;
});

// ── Data factories ─────────────────────────────────────────────────────────────

function makeMgrCfg(overrides = {}) {
    return {
        roleKey:                  'IT_OPS_MGR',
        isActive:                 true,
        approverEmail:            'ops.manager@ifl.com.pk',
        approverName:             'IT Ops Manager',
        approverUsername:         'ops.manager',
        isDelegatedTemporarily:   false,
        previousApproverEmail:    null,
        previousApproverName:     null,
        previousApproverUsername: null,
        secondaryEmail:           null,
        secondaryUsername:        null,
        primaryExpiredAt:         null,
        ...overrides,
    };
}

function makeLocCfg(overrides = {}) {
    return {
        location:         'Karachi',
        roleKey:          'IT_OPS',
        isActive:         true,
        approverName:     'KHI Primary',
        approverEmail:    'khi.primary@ifl.com.pk',
        secondaryName:    'KHI Secondary',
        secondaryEmail:   'khi.secondary@ifl.com.pk',
        primaryExpiredAt: null,
        ...overrides,
    };
}

function makeRequest(overrides = {}) {
    const base = {
        id:                        1,
        fullName:                  'Test Employee',
        designation:               'Software Engineer',
        department:                'IT',
        location:                  'Karachi',
        status:                    'PendingIT',
        currentStageAssigneeEmail: 'khi.primary@ifl.com.pk',
        currentStageToken:         'stage-tok-1',
        hrSubmittedAt:             new Date(Date.now() - 2 * 3600 * 1000).toISOString(), // 2h ago
        dciImplementedAt:          null,
        updatedAt:                 new Date().toISOString(),
        ...overrides,
    };
    return { ...base, toJSON: function () { return { ...this }; } };
}

// ── Auth test loader ───────────────────────────────────────────────────────────

async function loadForAuth({ mgrCfg }) {
    jest.resetModules();
    process.env.APP_URL = 'http://localhost:3000';

    const issuedTokens = {};
    await jest.unstable_mockModule('../src/services/portalTokenService.js', () => ({
        issueToken: jest.fn(payload => {
            const tok = 'tok-' + Math.random().toString(36).slice(2);
            issuedTokens[tok] = payload;
            return tok;
        }),
        validateToken: jest.fn(tok => issuedTokens[tok] || null),
    }));

    // findOne called with roleKey: 'IT_OPS_MGR' during resolveAccess
    await jest.unstable_mockModule('../src/models/WorkflowApproverConfig.js', () => ({
        default: { findOne: jest.fn().mockResolvedValue(mgrCfg) }
    }));
    // IT_OPS_MGR is not location-aware — findAll never called during auth
    await jest.unstable_mockModule('../src/models/WorkflowApproverLocationOverride.js', () => ({
        default: { findAll: jest.fn().mockResolvedValue([]) }
    }));
    await jest.unstable_mockModule('../src/models/OnboardingRequest.js', () => ({
        default: {
            findOne: jest.fn().mockResolvedValue(null),
            findAll: jest.fn().mockResolvedValue([]),
        }
    }));
    await jest.unstable_mockModule('../src/utils/emailMatch.js', () => ({
        emailsMatch: (a, b) =>
            (a || '').split('@')[0].toLowerCase() === (b || '').split('@')[0].toLowerCase()
    }));
    await jest.unstable_mockModule('../src/utils/locationGroups.js', () => ({
        LOCATION_GROUPS: [], groupByKey: jest.fn(), groupLabel: jest.fn().mockReturnValue('All')
    }));
    await jest.unstable_mockModule('../src/utils/logger.js', () => ({
        default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    }));
    await jest.unstable_mockModule('sequelize', () => ({
        Op: { in: Symbol('in'), notIn: Symbol('notIn'), ne: Symbol('ne') }
    }));

    const portalController = await import('../src/controllers/portalController.js');
    return { portalController, issuedTokens };
}

// ── Dashboard test loader ──────────────────────────────────────────────────────

async function loadForDashboard({ sessionPayload, locationOverrides = [], itOpsGlobalCfg = null, pendingRequests = [] }) {
    jest.resetModules();
    process.env.APP_URL = 'http://localhost:3000';

    const rendered = {};
    await jest.unstable_mockModule('../src/services/portalTokenService.js', () => ({
        issueToken:    jest.fn(),
        validateToken: jest.fn().mockReturnValue(sessionPayload),
    }));
    await jest.unstable_mockModule('../src/models/WorkflowApproverConfig.js', () => ({
        default: { findOne: jest.fn().mockResolvedValue(itOpsGlobalCfg) }
    }));
    // findAll returns IT_OPS location overrides (IT_OPS_MGR dashboard branch queries these)
    await jest.unstable_mockModule('../src/models/WorkflowApproverLocationOverride.js', () => ({
        default: { findAll: jest.fn().mockResolvedValue(locationOverrides) }
    }));
    await jest.unstable_mockModule('../src/models/OnboardingRequest.js', () => ({
        default: { findAll: jest.fn().mockResolvedValue(pendingRequests) }
    }));
    await jest.unstable_mockModule('../src/utils/emailMatch.js', () => ({
        emailsMatch: (a, b) =>
            (a || '').split('@')[0].toLowerCase() === (b || '').split('@')[0].toLowerCase()
    }));
    await jest.unstable_mockModule('../src/utils/locationGroups.js', () => ({
        LOCATION_GROUPS: [], groupByKey: jest.fn(), groupLabel: jest.fn().mockReturnValue('All')
    }));
    await jest.unstable_mockModule('../src/utils/logger.js', () => ({
        default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    }));
    await jest.unstable_mockModule('sequelize', () => ({
        Op: { in: Symbol('in'), notIn: Symbol('notIn'), ne: Symbol('ne') }
    }));

    const { showDashboard } = await import('../src/controllers/portalController.js');

    const req = { params: { roleSlug: 'it-ops-mgr' }, query: { token: 'mgr-tok' } };
    const res = {
        status:   jest.fn().mockReturnThis(),
        redirect: jest.fn(),
        send:     jest.fn(),
        render:   jest.fn((view, vars) => Object.assign(rendered, { _view: view, ...vars })),
    };

    await showDashboard(req, res);
    return rendered;
}

function mockApiRes() {
    const res = { status: jest.fn(), json: jest.fn(), redirect: jest.fn() };
    res.status.mockReturnValue(res);
    return res;
}

function mgrSession(overrides = {}) {
    return {
        roleKey:       'IT_OPS_MGR',
        username:      'ops.manager',
        email:         'ops.manager@ifl.com.pk',
        accesses:      [{ location: null, isPrimary: true }],
        roleName:      'IT Operations Manager',
        isDelegator:   false,
        delegateName:  '',
        delegateEmail: '',
        expiresAt:     Date.now() + 9_999_999,
        ...overrides,
    };
}

// ══ Auth tests ════════════════════════════════════════════════════════════════

describe('IT Ops Manager portal — auth (apiPortalAuth)', () => {

    test('configured manager gets a token — no 403', async () => {
        const { portalController, issuedTokens } = await loadForAuth({ mgrCfg: makeMgrCfg() });

        const req = {
            params:  { roleSlug: 'it-ops-mgr' },
            query:   { action: '' },
            user:    { username: 'ops.manager', email: 'ops.manager@ifl.com.pk' },
            headers: {},
        };
        const res = mockApiRes();
        await portalController.apiPortalAuth(req, res);

        expect(res.status).not.toHaveBeenCalledWith(403);
        const payload = res.json.mock.calls[0]?.[0];
        expect(payload?.redirect).toContain('/portal/it-ops-mgr/view?token=');

        const token = Object.values(issuedTokens)[0];
        expect(token.roleKey).toBe('IT_OPS_MGR');
        expect(token.isDelegator).toBeUndefined();
    });

    test('non-configured user gets 403', async () => {
        const { portalController } = await loadForAuth({ mgrCfg: makeMgrCfg() });

        const req = {
            params:  { roleSlug: 'it-ops-mgr' },
            query:   { action: '' },
            user:    { username: 'someone.else', email: 'someone.else@ifl.com' },
            headers: {},
        };
        const res = mockApiRes();
        await portalController.apiPortalAuth(req, res);

        expect(res.status).toHaveBeenCalledWith(403);
    });

    test('temp delegate (current approverUsername after delegation) gets normal access', async () => {
        const cfg = makeMgrCfg({
            approverUsername:         'delegate.mgr',
            approverEmail:            'delegate.mgr@ifl.com.pk',
            isDelegatedTemporarily:   true,
            previousApproverUsername: 'ops.manager',
            previousApproverEmail:    'ops.manager@ifl.com.pk',
        });
        const { portalController, issuedTokens } = await loadForAuth({ mgrCfg: cfg });

        const req = {
            params:  { roleSlug: 'it-ops-mgr' },
            query:   { action: '' },
            user:    { username: 'delegate.mgr', email: 'delegate.mgr@ifl.com.pk' },
            headers: {},
        };
        const res = mockApiRes();
        await portalController.apiPortalAuth(req, res);

        expect(res.status).not.toHaveBeenCalledWith(403);
        const token = Object.values(issuedTokens)[0];
        expect(token.isDelegator).toBeUndefined();
    });

    test('original delegator allowed in with isDelegator=true token', async () => {
        const cfg = makeMgrCfg({
            approverUsername:         'delegate.mgr',
            approverEmail:            'delegate.mgr@ifl.com.pk',
            approverName:             'Delegate Manager',
            isDelegatedTemporarily:   true,
            previousApproverUsername: 'ops.manager',
            previousApproverEmail:    'ops.manager@ifl.com.pk',
            previousApproverName:     'IT Ops Manager',
        });
        const { portalController, issuedTokens } = await loadForAuth({ mgrCfg: cfg });

        const req = {
            params:  { roleSlug: 'it-ops-mgr' },
            query:   { action: '' },
            user:    { username: 'ops.manager', email: 'ops.manager@ifl.com.pk' },
            headers: {},
        };
        const res = mockApiRes();
        await portalController.apiPortalAuth(req, res);

        expect(res.status).not.toHaveBeenCalledWith(403);
        const token = Object.values(issuedTokens)[0];
        expect(token.isDelegator).toBe(true);
        expect(token.delegateEmail).toBe('delegate.mgr@ifl.com.pk');
        expect(token.delegateName).toBe('Delegate Manager');
    });

    test('original holder gets 403 when isDelegatedTemporarily=false (no delegation active)', async () => {
        // Config is normal — ops.manager IS the primary, no delegation
        const cfg = makeMgrCfg({
            approverUsername:       'ops.manager',
            isDelegatedTemporarily: false,
        });
        // Now call with a DIFFERENT user who is not configured at all
        const { portalController } = await loadForAuth({ mgrCfg: cfg });

        const req = {
            params:  { roleSlug: 'it-ops-mgr' },
            query:   { action: '' },
            user:    { username: 'former.manager', email: 'former.manager@ifl.com.pk' },
            headers: {},
        };
        const res = mockApiRes();
        await portalController.apiPortalAuth(req, res);

        expect(res.status).toHaveBeenCalledWith(403);
    });

});

// ══ Dashboard — location summary ═════════════════════════════════════════════

describe('IT Ops Manager portal — dashboard location summary', () => {

    test('locationSummary is built from IT_OPS WorkflowApproverLocationOverride rows', async () => {
        const locCfgs = [
            makeLocCfg({ location: 'Karachi',   primaryExpiredAt: null }),
            makeLocCfg({ location: 'Lahore',    primaryExpiredAt: null }),
        ];
        const requests = [
            makeRequest({ location: 'Karachi', status: 'PendingIT' }),
            makeRequest({ id: 2, location: 'Karachi', status: 'PendingOPSAction', dciImplementedAt: new Date().toISOString() }),
            makeRequest({ id: 3, location: 'Lahore',  status: 'PendingIT' }),
        ];

        const rendered = await loadForDashboard({
            sessionPayload:    mgrSession(),
            locationOverrides: locCfgs,
            pendingRequests:   requests,
        });

        expect(rendered.locationSummary).toHaveLength(2);
        const khi = rendered.locationSummary.find(l => l.location === 'Karachi');
        expect(khi).toBeDefined();
        expect(khi.primaryName).toBe('KHI Primary');
        expect(khi.secondaryName).toBe('KHI Secondary');
        expect(khi.activeCount).toBe(2);
        expect(khi.isEscalated).toBe(false);

        const lhe = rendered.locationSummary.find(l => l.location === 'Lahore');
        expect(lhe.activeCount).toBe(1);
    });

    test('isEscalated=true on location where primaryExpiredAt is set', async () => {
        const escalatedAt = new Date(Date.now() - 50 * 3600 * 1000).toISOString();
        const locCfgs = [
            makeLocCfg({ location: 'Karachi', primaryExpiredAt: escalatedAt }),
            makeLocCfg({ location: 'Lahore',  primaryExpiredAt: null }),
        ];

        const rendered = await loadForDashboard({
            sessionPayload:    mgrSession(),
            locationOverrides: locCfgs,
            pendingRequests:   [],
        });

        const khi = rendered.locationSummary.find(l => l.location === 'Karachi');
        expect(khi.isEscalated).toBe(true);

        const lhe = rendered.locationSummary.find(l => l.location === 'Lahore');
        expect(lhe.isEscalated).toBe(false);
    });

    test('empty locationSummary when no IT_OPS overrides are configured', async () => {
        const rendered = await loadForDashboard({
            sessionPayload:    mgrSession(),
            locationOverrides: [],
            pendingRequests:   [],
        });

        expect(rendered.locationSummary).toHaveLength(0);
        expect(rendered.pendingCount).toBe(0);
    });

});

// ══ Dashboard — request enrichment ═══════════════════════════════════════════

describe('IT Ops Manager portal — request enrichment', () => {

    test('stageAgeHours calculated from hrSubmittedAt for PendingIT', async () => {
        const ageMs = 10 * 3600 * 1000; // 10 hours
        const req = makeRequest({
            status:        'PendingIT',
            hrSubmittedAt: new Date(Date.now() - ageMs).toISOString(),
        });

        const rendered = await loadForDashboard({
            sessionPayload:    mgrSession(),
            locationOverrides: [makeLocCfg()],
            pendingRequests:   [req],
        });

        expect(rendered.pendingRequests[0].stageAgeHours).toBe(10);
        expect(rendered.pendingRequests[0].isStale).toBe(false);
    });

    test('stageAgeHours calculated from dciImplementedAt for PendingOPSAction', async () => {
        const ageMs = 52 * 3600 * 1000; // 52 hours — past 48h threshold
        const req = makeRequest({
            status:           'PendingOPSAction',
            hrSubmittedAt:    new Date(Date.now() - 100 * 3600 * 1000).toISOString(), // should NOT be used
            dciImplementedAt: new Date(Date.now() - ageMs).toISOString(),
        });

        const rendered = await loadForDashboard({
            sessionPayload:    mgrSession(),
            locationOverrides: [makeLocCfg()],
            pendingRequests:   [req],
        });

        expect(rendered.pendingRequests[0].stageAgeHours).toBe(52);
        expect(rendered.pendingRequests[0].isStale).toBe(true);
    });

    test('isStale=true when stageAgeHours > 48', async () => {
        const staleReq = makeRequest({
            id:            1,
            hrSubmittedAt: new Date(Date.now() - 49 * 3600 * 1000).toISOString(),
        });
        const freshReq = makeRequest({
            id:            2,
            hrSubmittedAt: new Date(Date.now() -  5 * 3600 * 1000).toISOString(),
        });

        const rendered = await loadForDashboard({
            sessionPayload:    mgrSession(),
            locationOverrides: [makeLocCfg()],
            pendingRequests:   [staleReq, freshReq],
        });

        expect(rendered.pendingRequests[0].isStale).toBe(true);
        expect(rendered.pendingRequests[1].isStale).toBe(false);
    });

    test('primaryName and secondaryName resolved from matching location override', async () => {
        const locCfg = makeLocCfg({
            location:      'Karachi',
            approverName:  'John Primary',
            secondaryName: 'Jane Secondary',
        });
        const req = makeRequest({ location: 'Karachi', status: 'PendingIT' });

        const rendered = await loadForDashboard({
            sessionPayload:    mgrSession(),
            locationOverrides: [locCfg],
            pendingRequests:   [req],
        });

        expect(rendered.pendingRequests[0].primaryName).toBe('John Primary');
        expect(rendered.pendingRequests[0].secondaryName).toBe('Jane Secondary');
    });

    test('isEscalated=true on request whose location config has primaryExpiredAt set', async () => {
        const escalatedAt = new Date(Date.now() - 50 * 3600 * 1000).toISOString();
        const locCfg = makeLocCfg({ location: 'Karachi', primaryExpiredAt: escalatedAt });
        const req    = makeRequest({ location: 'Karachi' });

        const rendered = await loadForDashboard({
            sessionPayload:    mgrSession(),
            locationOverrides: [locCfg],
            pendingRequests:   [req],
        });

        expect(rendered.pendingRequests[0].isEscalated).toBe(true);
    });

    test('pendingCount matches total requests across all locations', async () => {
        const locCfgs = [
            makeLocCfg({ location: 'Karachi' }),
            makeLocCfg({ location: 'Lahore' }),
        ];
        const requests = [
            makeRequest({ id: 1, location: 'Karachi' }),
            makeRequest({ id: 2, location: 'Karachi' }),
            makeRequest({ id: 3, location: 'Lahore' }),
        ];

        const rendered = await loadForDashboard({
            sessionPayload:    mgrSession(),
            locationOverrides: locCfgs,
            pendingRequests:   requests,
        });

        expect(rendered.pendingCount).toBe(3);
    });

    test('requests use global IT_OPS config as fallback for locations without an override', async () => {
        const globalITOPS = {
            roleKey:       'IT_OPS',
            isActive:      true,
            approverName:  'Global Primary',
            approverEmail: 'global.primary@ifl.com.pk',
            secondaryName: 'Global Secondary',
            primaryExpiredAt: null,
        };
        // No location overrides — request should resolve to global config
        const req = makeRequest({ location: 'Islamabad', status: 'PendingIT' });

        const rendered = await loadForDashboard({
            sessionPayload:    mgrSession(),
            locationOverrides: [],
            itOpsGlobalCfg:    globalITOPS,
            pendingRequests:   [req],
        });

        expect(rendered.pendingRequests[0].primaryName).toBe('Global Primary');
        expect(rendered.pendingRequests[0].secondaryName).toBe('Global Secondary');
    });

});

// ══ Dashboard — delegation / read-only ═══════════════════════════════════════

describe('IT Ops Manager portal — delegation behaviour in dashboard', () => {

    test('isDelegator=true is passed through to rendered view', async () => {
        const rendered = await loadForDashboard({
            sessionPayload: mgrSession({
                isDelegator:   true,
                delegateName:  'Delegate Manager',
                delegateEmail: 'delegate.mgr@ifl.com.pk',
            }),
            locationOverrides: [],
            pendingRequests:   [],
        });

        expect(rendered.isDelegator).toBe(true);
        expect(rendered.delegateName).toBe('Delegate Manager');
        expect(rendered.delegateEmail).toBe('delegate.mgr@ifl.com.pk');
    });

    test('pendingCount is correct even when isDelegator=true (read-only view)', async () => {
        const requests = [
            makeRequest({ id: 1 }),
            makeRequest({ id: 2 }),
        ];

        const rendered = await loadForDashboard({
            sessionPayload: mgrSession({ isDelegator: true }),
            locationOverrides: [makeLocCfg()],
            pendingRequests: requests,
        });

        expect(rendered.pendingCount).toBe(2);
    });

    test('renders portal_it_ops_mgr template (not portal_dashboard)', async () => {
        const rendered = await loadForDashboard({
            sessionPayload:    mgrSession(),
            locationOverrides: [],
            pendingRequests:   [],
        });

        // The render helper sets _view to the template name
        expect(rendered._view).toBe('pages/portal_it_ops_mgr');
    });

});

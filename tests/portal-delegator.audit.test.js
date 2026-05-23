import { jest, describe, test, expect, afterEach } from '@jest/globals';

/**
 * Portal access for the original delegator audit
 *
 * Business rules under test:
 *  - When DCI_MANAGER or IT_HOD is temporarily delegated, the original holder
 *    (matching previousApproverUsername / previousApproverEmail) MUST be allowed
 *    into the portal (not 403'd) via resolveAccess → isOriginalDelegator path.
 *  - The portal token issued to the original delegator carries isDelegator=true,
 *    delegateName, and delegateEmail.
 *  - In showDashboard, every request has canAct=false when isDelegator=true,
 *    regardless of currentStageAssigneeEmail.
 *  - The temp delegate (current approverUsername) gets normal access.
 *  - A non-configured user still gets 403.
 *  - After revert (isDelegatedTemporarily=false), the original holder gets normal
 *    primary access again and the temp delegate gets 403.
 */

afterEach(() => {
    jest.resetModules();
    delete process.env.APP_URL;
});

// ── helpers ────────────────────────────────────────────────────────────────────

function makeGlobalCfg(overrides = {}) {
    return {
        roleKey:                  'DCI_MANAGER',
        isActive:                 true,
        approverEmail:            'temp.mgr@ifl.com',
        approverName:             'Temp Manager',
        approverUsername:         'temp.mgr',
        isDelegatedTemporarily:   false,
        previousApproverEmail:    null,
        previousApproverName:     null,
        previousApproverUsername: null,
        secondaryEmail:           null,
        secondaryUsername:        null,
        primaryExpiredAt:         null,
        ...overrides
    };
}

async function loadPortalController({ globalCfg, pendingRequests = [] }) {
    jest.resetModules();
    process.env.APP_URL = 'http://localhost:3000';

    // Minimal token store mock that records what was stored
    const issuedTokens = {};
    await jest.unstable_mockModule('../src/services/portalTokenService.js', () => ({
        issueToken: jest.fn(payload => {
            const tok = 'tok-' + Math.random().toString(36).slice(2);
            issuedTokens[tok] = payload;
            return tok;
        }),
        validateToken: jest.fn(tok => issuedTokens[tok] || null),
    }));
    await jest.unstable_mockModule('../src/models/WorkflowApproverConfig.js', () => ({
        default: { findOne: jest.fn().mockResolvedValue(globalCfg) }
    }));
    await jest.unstable_mockModule('../src/models/WorkflowApproverLocationOverride.js', () => ({
        default: { findAll: jest.fn().mockResolvedValue([]) }
    }));
    await jest.unstable_mockModule('../src/models/OnboardingRequest.js', () => ({
        default: {
            findOne: jest.fn().mockResolvedValue(null),
            findAll: jest.fn().mockResolvedValue(pendingRequests),
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
    await jest.unstable_mockModule('sequelize', () => ({ Op: { in: Symbol('in'), notIn: Symbol('notIn'), ne: Symbol('ne') } }));

    const portalController = await import('../src/controllers/portalController.js');
    return { portalController, issuedTokens };
}

function mockApiRes() {
    const res = { status: jest.fn(), json: jest.fn(), redirect: jest.fn() };
    res.status.mockReturnValue(res);
    return res;
}

// ── resolveAccess / apiPortalAuth — original delegator path ───────────────────

describe('Portal auth — original delegator read-only access', () => {

    test('original delegator (username match) is allowed in and token carries isDelegator=true', async () => {
        const cfg = makeGlobalCfg({
            isDelegatedTemporarily:   true,
            previousApproverEmail:    'original.mgr@ifl.com',
            previousApproverName:     'Original Manager',
            previousApproverUsername: 'original.mgr',
        });
        const { portalController, issuedTokens } = await loadPortalController({ globalCfg: cfg });

        const req = {
            params: { roleSlug: 'dci-manager' },
            query:  { action: '' },
            user:   { username: 'original.mgr', email: 'original.mgr@ifl.com' },
            headers: {}
        };
        const res = mockApiRes();
        await portalController.apiPortalAuth(req, res);

        // Must not 403
        expect(res.status).not.toHaveBeenCalledWith(403);

        // Redirect returned
        const redirectCall = res.json.mock.calls[0]?.[0];
        expect(redirectCall).toBeDefined();
        expect(redirectCall.redirect).toContain('/portal/dci-manager/view?token=');

        // Token payload carries delegator info
        const tokenValue = Object.values(issuedTokens)[0];
        expect(tokenValue.isDelegator).toBe(true);
        expect(tokenValue.delegateEmail).toBe('temp.mgr@ifl.com');
        expect(tokenValue.delegateName).toBe('Temp Manager');
    });

    test('original delegator matched by email local-part when no previousApproverUsername stored', async () => {
        const cfg = makeGlobalCfg({
            isDelegatedTemporarily:   true,
            previousApproverEmail:    'original.mgr@ifl.com',
            previousApproverUsername: null,
        });
        const { portalController } = await loadPortalController({ globalCfg: cfg });

        const req = {
            params: { roleSlug: 'dci-manager' },
            query:  { action: '' },
            user:   { username: 'original.mgr', email: 'original.mgr@ifl.com' },
            headers: {}
        };
        const res = mockApiRes();
        await portalController.apiPortalAuth(req, res);

        expect(res.status).not.toHaveBeenCalledWith(403);
        const redirectCall = res.json.mock.calls[0]?.[0];
        expect(redirectCall?.redirect).toContain('/portal/dci-manager/view?token=');
    });

    test('temp delegate (current approverUsername) gets normal access — no isDelegator in token', async () => {
        const cfg = makeGlobalCfg({
            isDelegatedTemporarily:   true,
            previousApproverEmail:    'original.mgr@ifl.com',
            previousApproverUsername: 'original.mgr',
        });
        const { portalController, issuedTokens } = await loadPortalController({ globalCfg: cfg });

        const req = {
            params: { roleSlug: 'dci-manager' },
            query:  { action: '' },
            user:   { username: 'temp.mgr', email: 'temp.mgr@ifl.com' },
            headers: {}
        };
        const res = mockApiRes();
        await portalController.apiPortalAuth(req, res);

        expect(res.status).not.toHaveBeenCalledWith(403);
        const tokenValue = Object.values(issuedTokens)[0];
        expect(tokenValue.isDelegator).toBeUndefined();
    });

    test('non-configured user still gets 403 even when delegation is active', async () => {
        const cfg = makeGlobalCfg({
            isDelegatedTemporarily:   true,
            previousApproverEmail:    'original.mgr@ifl.com',
            previousApproverUsername: 'original.mgr',
        });
        const { portalController } = await loadPortalController({ globalCfg: cfg });

        const req = {
            params: { roleSlug: 'dci-manager' },
            query:  { action: '' },
            user:   { username: 'someone.else', email: 'someone.else@ifl.com' },
            headers: {}
        };
        const res = mockApiRes();
        await portalController.apiPortalAuth(req, res);

        expect(res.status).toHaveBeenCalledWith(403);
    });

    test('original holder gets 403 when isDelegatedTemporarily=false (delegation ended or never set)', async () => {
        const cfg = makeGlobalCfg({
            isDelegatedTemporarily:   false,
            previousApproverEmail:    null,
            previousApproverUsername: null,
        });
        const { portalController } = await loadPortalController({ globalCfg: cfg });

        const req = {
            params: { roleSlug: 'dci-manager' },
            query:  { action: '' },
            // This user is NOT the current approver (temp.mgr) — they'd be the original
            // but since isDelegatedTemporarily is false, no special path applies.
            user:   { username: 'original.mgr', email: 'original.mgr@ifl.com' },
            headers: {}
        };
        const res = mockApiRes();
        await portalController.apiPortalAuth(req, res);

        expect(res.status).toHaveBeenCalledWith(403);
    });

});

// ── showDashboard — canAct forced false for isDelegator ───────────────────────

describe('Portal dashboard — canAct=false for original delegator', () => {

    async function loadDashboard({ sessionPayload, pendingRequests }) {
        jest.resetModules();
        process.env.APP_URL = 'http://localhost:3000';

        const rendered = {};
        await jest.unstable_mockModule('../src/services/portalTokenService.js', () => ({
            issueToken: jest.fn(),
            validateToken: jest.fn().mockReturnValue(sessionPayload),
        }));
        await jest.unstable_mockModule('../src/models/WorkflowApproverConfig.js', () => ({
            default: { findOne: jest.fn().mockResolvedValue(null) }
        }));
        await jest.unstable_mockModule('../src/models/WorkflowApproverLocationOverride.js', () => ({
            default: { findAll: jest.fn().mockResolvedValue([]) }
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
        await jest.unstable_mockModule('sequelize', () => ({ Op: { in: Symbol('in'), notIn: Symbol('notIn'), ne: Symbol('ne') } }));

        const { showDashboard } = await import('../src/controllers/portalController.js');

        const req = { params: { roleSlug: 'dci-manager' }, query: { token: 'tok', expand: '' } };
        const res = {
            status: jest.fn().mockReturnThis(),
            redirect: jest.fn(),
            send: jest.fn(),
            render: jest.fn((view, vars) => Object.assign(rendered, vars)),
        };

        await showDashboard(req, res);
        return rendered;
    }

    test('all requests have canAct=false when session isDelegator=true', async () => {
        const pendingRequests = [
            { id: 1, status: 'PendingDCIManager', currentStageAssigneeEmail: 'temp.mgr@ifl.com', currentStageToken: 'tok1', toJSON: function() { return { ...this }; } },
            { id: 2, status: 'PendingDCIManager', currentStageAssigneeEmail: 'temp.mgr@ifl.com', currentStageToken: 'tok2', toJSON: function() { return { ...this }; } },
        ];

        const rendered = await loadDashboard({
            sessionPayload: {
                roleKey:       'DCI_MANAGER',
                username:      'original.mgr',
                email:         'original.mgr@ifl.com',
                accesses:      [{ location: null, isPrimary: false, isOriginalDelegator: true }],
                roleName:      'DCI Manager',
                isDelegator:   true,
                delegateName:  'Temp Manager',
                delegateEmail: 'temp.mgr@ifl.com',
                expiresAt:     Date.now() + 9999999,
            },
            pendingRequests
        });

        expect(rendered.isDelegator).toBe(true);
        expect(rendered.delegateName).toBe('Temp Manager');
        expect(rendered.delegateEmail).toBe('temp.mgr@ifl.com');
        expect(rendered.actionCount).toBe(0);
        rendered.pending.forEach(r => expect(r.canAct).toBe(false));
    });

    test('requests have normal canAct when session has no isDelegator (temp delegate view)', async () => {
        const pendingRequests = [
            { id: 1, status: 'PendingDCIManager', currentStageAssigneeEmail: 'temp.mgr@ifl.com', currentStageToken: 'tok1', toJSON: function() { return { ...this }; } },
        ];

        const rendered = await loadDashboard({
            sessionPayload: {
                roleKey:   'DCI_MANAGER',
                username:  'temp.mgr',
                email:     'temp.mgr@ifl.com',
                accesses:  [{ location: null, isPrimary: true }],
                roleName:  'DCI Manager',
                expiresAt: Date.now() + 9999999,
            },
            pendingRequests
        });

        expect(rendered.isDelegator).toBe(false);
        expect(rendered.actionCount).toBe(1);
        expect(rendered.pending[0].canAct).toBe(true);
    });

});

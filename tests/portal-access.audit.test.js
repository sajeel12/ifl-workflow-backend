/**
 * portal-access.audit.test.js
 *
 * Verifies the username-based portal access control introduced in the
 * "AD login name as identity" refactor.
 *
 * Key rules this file verifies:
 *   - Identity = Windows AD login name from IIS X-Auth-User header (DOMAIN\user → "user")
 *   - resolveAccess() matches by approverUsername first, falls back to email local-part
 *     for rows that predate the username field (backward compat)
 *   - enterViaActionToken: action token proves receipt; Windows identity proves who you are
 *   - showLogin: auto-login — if x-auth-user matches an approver, redirect straight to /view
 *   - Never returns 401 — no IIS Windows-Auth popup-loop risk
 *   - Portal session token carries { username, email } — email kept for canAct comparison
 */

import { jest } from '@jest/globals';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const PRIMARY_USER    = 'primary.approver';          // AD login name
const SECONDARY_USER  = 'secondary.approver';
const PRIMARY_EMAIL   = 'primary.approver@ifl.com.pk';
const SECONDARY_EMAIL = 'secondary.approver@ifl.com.pk';
const ACTION_TOKEN    = 'test-action-token-abc';
const PORTAL_SESSION  = 'test-portal-session-xyz';
const REQUEST_ID      = 42;

// IIS injects header as "DOMAIN\username" — verify controller strips domain correctly.
const IIS_PRIMARY_HEADER   = `IBRAHIM\\${PRIMARY_USER}`;
const IIS_SECONDARY_HEADER = `IBRAHIM\\${SECONDARY_USER}`;

// ── Config mocks ───────────────────────────────────────────────────────────────

// New-style config: explicit approverUsername stored.
const mockConfigWithUsername = {
    approverUsername:  PRIMARY_USER,
    approverEmail:     PRIMARY_EMAIL,
    secondaryUsername: SECONDARY_USER,
    secondaryEmail:    SECONDARY_EMAIL,
    isActive: true,
};

// Old-style config: no username stored yet — backward compat via email local-part.
const mockConfigEmailOnly = {
    approverUsername:  null,
    approverEmail:     PRIMARY_EMAIL,   // local part "primary.approver" must still match
    secondaryUsername: null,
    secondaryEmail:    SECONDARY_EMAIL,
    isActive: true,
};

const mockRequest = {
    id: REQUEST_ID,
    status: 'PendingIT',
    location: 'HO_FSD',
    currentStageToken: ACTION_TOKEN,
    currentStageAssigneeEmail: PRIMARY_EMAIL,
    toJSON() { return { ...this }; },
};

// ── Model / service mocks ──────────────────────────────────────────────────────

jest.unstable_mockModule('../src/models/OnboardingRequest.js', () => ({
    default: { findOne: jest.fn(), findAll: jest.fn() },
}));

jest.unstable_mockModule('../src/models/WorkflowApproverConfig.js', () => ({
    default: { findOne: jest.fn() },
}));

jest.unstable_mockModule('../src/models/WorkflowApproverLocationOverride.js', () => ({
    default: { findAll: jest.fn() },
}));

jest.unstable_mockModule('../src/services/portalTokenService.js', () => ({
    issueToken:    jest.fn(() => PORTAL_SESSION),
    validateToken: jest.fn(),
}));

jest.unstable_mockModule('../src/utils/logger.js', () => ({
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// ── Lazy imports ───────────────────────────────────────────────────────────────

let OnboardingRequest, WorkflowApproverConfig, WorkflowApproverLocationOverride;
let issueToken, validateToken;
let enterViaActionToken, showLogin, showDashboard;

beforeAll(async () => {
    OnboardingRequest             = (await import('../src/models/OnboardingRequest.js')).default;
    WorkflowApproverConfig        = (await import('../src/models/WorkflowApproverConfig.js')).default;
    WorkflowApproverLocationOverride = (await import('../src/models/WorkflowApproverLocationOverride.js')).default;
    ({ issueToken, validateToken } = await import('../src/services/portalTokenService.js'));
    ({ enterViaActionToken, showLogin, showDashboard } = await import('../src/controllers/portalController.js'));
});

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeRes() {
    return {
        status:   jest.fn().mockReturnThis(),
        redirect: jest.fn(),
        send:     jest.fn(),
        render:   jest.fn(),
    };
}

function defaultMocks() {
    WorkflowApproverLocationOverride.findAll.mockResolvedValue([]);
    WorkflowApproverConfig.findOne.mockResolvedValue(mockConfigWithUsername);
    OnboardingRequest.findOne.mockResolvedValue(mockRequest);
}

// ── enterViaActionToken ────────────────────────────────────────────────────────

describe('enterViaActionToken', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        process.env.APP_URL = 'http://localhost:3000';
    });

    test('valid token + Windows username in config → issues session and redirects to dashboard', async () => {
        defaultMocks();
        const req = {
            params:  { roleSlug: 'it-ops' },
            query:   { action: ACTION_TOKEN },
            headers: { 'x-auth-user': IIS_PRIMARY_HEADER },
        };
        const res = makeRes();

        await enterViaActionToken(req, res);

        expect(issueToken).toHaveBeenCalledWith(expect.objectContaining({
            username: PRIMARY_USER,
            roleKey:  'IT_OPS',
        }));
        expect(res.redirect).toHaveBeenCalledWith(
            expect.stringContaining(`/portal/it-ops/view?token=${PORTAL_SESSION}&expand=${REQUEST_ID}`)
        );
    });

    test('secondary username → also granted access', async () => {
        defaultMocks();
        const req = {
            params:  { roleSlug: 'it-ops' },
            query:   { action: ACTION_TOKEN },
            headers: { 'x-auth-user': IIS_SECONDARY_HEADER },
        };
        const res = makeRes();

        await enterViaActionToken(req, res);

        expect(issueToken).toHaveBeenCalledWith(expect.objectContaining({
            username: SECONDARY_USER,
        }));
        expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('/portal/it-ops/view'));
    });

    test('backward compat: email-only config → local part match still works', async () => {
        WorkflowApproverLocationOverride.findAll.mockResolvedValue([]);
        WorkflowApproverConfig.findOne.mockResolvedValue(mockConfigEmailOnly);
        OnboardingRequest.findOne.mockResolvedValue(mockRequest);

        // "primary.approver" extracted from email local part = "primary.approver" from header
        const req = {
            params:  { roleSlug: 'it-ops' },
            query:   { action: ACTION_TOKEN },
            headers: { 'x-auth-user': IIS_PRIMARY_HEADER },
        };
        const res = makeRes();

        await enterViaActionToken(req, res);

        expect(issueToken).toHaveBeenCalled();
        expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('/portal/it-ops/view'));
    });

    test('username not in config (reassigned) → loading page for sidecar auth', async () => {
        WorkflowApproverLocationOverride.findAll.mockResolvedValue([]);
        WorkflowApproverConfig.findOne.mockResolvedValue({
            approverUsername:  'new.person',
            approverEmail:     'new.person@ifl.com.pk',
            secondaryUsername: null,
            secondaryEmail:    null,
            isActive: true,
        });
        OnboardingRequest.findOne.mockResolvedValue(mockRequest);

        const req = {
            params:  { roleSlug: 'it-ops' },
            query:   { action: ACTION_TOKEN },
            headers: { 'x-auth-user': IIS_PRIMARY_HEADER }, // old person, no longer configured
        };
        const res = makeRes();

        await enterViaActionToken(req, res);

        // Authorization now happens in apiPortalAuth (sidecar path); showLogin/enter
        // fall through to the loading page so the client can re-authenticate.
        expect(res.render).toHaveBeenCalledWith('pages/portal_loading', expect.objectContaining({
            roleSlug: 'it-ops',
        }));
        expect(issueToken).not.toHaveBeenCalled();
    });

    test('expired / consumed action token → redirect with expired=1', async () => {
        WorkflowApproverLocationOverride.findAll.mockResolvedValue([]);
        WorkflowApproverConfig.findOne.mockResolvedValue(mockConfigWithUsername);
        OnboardingRequest.findOne.mockResolvedValue(null);

        const req = {
            params:  { roleSlug: 'it-ops' },
            query:   { action: ACTION_TOKEN },
            headers: { 'x-auth-user': IIS_PRIMARY_HEADER },
        };
        const res = makeRes();

        await enterViaActionToken(req, res);

        expect(res.redirect).toHaveBeenCalledWith('/portal/it-ops?expired=1');
        expect(issueToken).not.toHaveBeenCalled();
    });

    test('slug mismatch → auto-corrects to the right portal', async () => {
        WorkflowApproverLocationOverride.findAll.mockResolvedValue([]);
        WorkflowApproverConfig.findOne.mockResolvedValue(mockConfigWithUsername);
        OnboardingRequest.findOne.mockResolvedValue({ ...mockRequest, status: 'PendingDCI', toJSON() { return { ...this }; } });

        const req = {
            params:  { roleSlug: 'it-ops' },  // wrong slug — request is PendingDCI
            query:   { action: ACTION_TOKEN },
            headers: { 'x-auth-user': IIS_PRIMARY_HEADER },
        };
        const res = makeRes();

        await enterViaActionToken(req, res);

        expect(res.redirect).toHaveBeenCalledWith(`/portal/dci-team/enter?action=${ACTION_TOKEN}`);
        expect(issueToken).not.toHaveBeenCalled();
    });

    test('no action token in URL → redirects to login', async () => {
        const req = { params: { roleSlug: 'it-ops' }, query: {}, headers: { 'x-auth-user': IIS_PRIMARY_HEADER } };
        const res = makeRes();

        await enterViaActionToken(req, res);

        expect(res.redirect).toHaveBeenCalledWith('/portal/it-ops');
        expect(issueToken).not.toHaveBeenCalled();
    });

    test('no x-auth-user header (not through IIS) → loading page for sidecar auth, no crash', async () => {
        defaultMocks();
        const req = { params: { roleSlug: 'it-ops' }, query: { action: ACTION_TOKEN }, headers: {} };
        const res = makeRes();

        await enterViaActionToken(req, res);

        // X-Auth-User empty → sidecar loading page rather than redirect/error.
        expect(res.render).toHaveBeenCalledWith('pages/portal_loading', expect.objectContaining({
            roleSlug: 'it-ops',
        }));
        expect(issueToken).not.toHaveBeenCalled();
    });

    test('never returns 401 — no IIS Windows-Auth popup-loop risk', async () => {
        defaultMocks();
        const req = {
            params:  { roleSlug: 'it-ops' },
            query:   { action: ACTION_TOKEN },
            headers: { 'x-auth-user': IIS_PRIMARY_HEADER },
        };
        const res = makeRes();

        await enterViaActionToken(req, res);

        const statusCalls = res.status.mock.calls.map(c => c[0]);
        expect(statusCalls).not.toContain(401);
    });
});

// ── showLogin ──────────────────────────────────────────────────────────────────

describe('showLogin', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        process.env.APP_URL = 'http://localhost:3000';
    });

    test('authorised Windows user → auto-login, redirect straight to /view', async () => {
        WorkflowApproverLocationOverride.findAll.mockResolvedValue([]);
        WorkflowApproverConfig.findOne.mockResolvedValue(mockConfigWithUsername);

        const req = {
            params:  { roleSlug: 'it-ops' },
            query:   {},
            headers: { 'x-auth-user': IIS_PRIMARY_HEADER },
        };
        const res = makeRes();

        await showLogin(req, res);

        expect(issueToken).toHaveBeenCalledWith(expect.objectContaining({
            username: PRIMARY_USER,
            roleKey:  'IT_OPS',
        }));
        expect(res.redirect).toHaveBeenCalledWith(
            expect.stringContaining(`/portal/it-ops/view?token=${PORTAL_SESSION}`)
        );
    });

    test('unauthorised Windows user → loading page for sidecar auth', async () => {
        WorkflowApproverLocationOverride.findAll.mockResolvedValue([]);
        WorkflowApproverConfig.findOne.mockResolvedValue({
            approverUsername: 'someone.else',
            approverEmail:    'someone.else@ifl.com.pk',
            secondaryUsername: null,
            secondaryEmail:   null,
            isActive: true,
        });

        const req = {
            params:  { roleSlug: 'it-ops' },
            query:   {},
            headers: { 'x-auth-user': IIS_PRIMARY_HEADER },
        };
        const res = makeRes();

        await showLogin(req, res);

        // X-Auth-User found but not in config → sidecar loading page.
        // The 403 is issued by apiPortalAuth when the client calls it.
        expect(res.render).toHaveBeenCalledWith('pages/portal_loading', expect.objectContaining({
            roleSlug: 'it-ops',
        }));
        expect(issueToken).not.toHaveBeenCalled();
    });

    test('no x-auth-user header → loading page for sidecar auth', async () => {
        const req = { params: { roleSlug: 'it-ops' }, query: {}, headers: {} };
        const res = makeRes();

        await showLogin(req, res);

        // X-Auth-User absent → sidecar loading page (no hard 403 at page level).
        expect(res.render).toHaveBeenCalledWith('pages/portal_loading', expect.objectContaining({
            roleSlug: 'it-ops',
        }));
        expect(issueToken).not.toHaveBeenCalled();
    });

    test('never returns 401', async () => {
        WorkflowApproverLocationOverride.findAll.mockResolvedValue([]);
        WorkflowApproverConfig.findOne.mockResolvedValue(mockConfigWithUsername);

        const req = { params: { roleSlug: 'it-ops' }, query: {}, headers: { 'x-auth-user': IIS_PRIMARY_HEADER } };
        const res = makeRes();

        await showLogin(req, res);

        const statusCalls = res.status.mock.calls.map(c => c[0]);
        expect(statusCalls).not.toContain(401);
    });
});

// ── showDashboard ─────────────────────────────────────────────────────────────

describe('showDashboard', () => {
    const SESSION = {
        roleKey:  'IT_OPS',
        username: PRIMARY_USER,
        email:    PRIMARY_EMAIL,
        accesses: [{ location: null, isPrimary: true }],
        roleName: 'IT Operations',
    };

    beforeEach(() => {
        jest.clearAllMocks();
        validateToken.mockReturnValue(SESSION);
        OnboardingRequest.findAll.mockResolvedValue([]);
        process.env.APP_URL = 'http://hosppdevsrv:3333';
    });

    function dashReq() {
        return { params: { roleSlug: 'it-ops' }, query: { token: PORTAL_SESSION } };
    }

    test('valid session → renders dashboard with correct username and email', async () => {
        const res = makeRes();
        await showDashboard(dashReq(), res);
        expect(res.render).toHaveBeenCalledWith('pages/portal_dashboard', expect.objectContaining({
            userEmail: PRIMARY_EMAIL,
        }));
    });

    test('invalid / expired session → redirect to login', async () => {
        validateToken.mockReturnValue(null);
        const res = makeRes();
        await showDashboard(dashReq(), res);
        expect(res.redirect).toHaveBeenCalledWith('/portal/it-ops?expired=1');
    });

    test('actionUrl points to /api/onboarding/handle (not portal /enter)', async () => {
        OnboardingRequest.findAll
            .mockResolvedValueOnce([{
                ...mockRequest,
                status: 'PendingIT',
                toJSON() { return { ...this, currentStageToken: ACTION_TOKEN }; },
            }])
            .mockResolvedValueOnce([]);

        const res = makeRes();
        await showDashboard(dashReq(), res);

        const { pending } = res.render.mock.calls[0][1];
        expect(pending[0].actionUrl).toMatch(/\/api\/onboarding\/handle\?token=/);
        expect(pending[0].actionUrl).toContain(ACTION_TOKEN);
        expect(pending[0].actionUrl).not.toContain('/portal/it-ops/enter');
    });

    test('canAct true for session owner email, false for others', async () => {
        OnboardingRequest.findAll
            .mockResolvedValueOnce([
                { ...mockRequest, currentStageAssigneeEmail: PRIMARY_EMAIL,   toJSON() { return { ...this }; } },
                { ...mockRequest, id: 99, currentStageAssigneeEmail: 'other@ifl.com.pk', toJSON() { return { ...this }; } },
            ])
            .mockResolvedValueOnce([]);

        const res = makeRes();
        await showDashboard(dashReq(), res);

        const { pending } = res.render.mock.calls[0][1];
        expect(pending[0].canAct).toBe(true);
        expect(pending[1].canAct).toBe(false);
    });
});

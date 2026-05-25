/**
 * SSO Middleware — audit test suite
 *
 * Covers every auth path in ssoMiddleware.js:
 *   - Sidecar HMAC token (primary domain + child domain users)
 *   - IIS proxy-header fallback (browser navigation)
 *   - MOCK / OPTIONAL modes
 *   - Token validation failures (expired, malformed, bad signature)
 *   - No identity → 401
 *
 * Token signing mirrors the logic in token.aspx and ssoMiddleware.js exactly.
 * If either side changes the signature format this suite will catch the mismatch.
 */

import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import crypto from 'crypto';

// ── Shared secret (matches SSO_SHARED_SECRET / web.config SsoSharedSecret) ────
const SECRET = 'IFL_WORKFLOW_SECRET_KEY_2025';

// ── Token factory — mirrors token.aspx ComputeHmacSha256 exactly ──────────────
function makeToken({ username, email = '', displayName = '', secondsAgo = 0, secret = SECRET, version = 2 }) {
    const timestamp = Math.floor(Date.now() / 1000) - secondsAgo;
    const dataToSign = version === 2
        ? `${username}|${timestamp}|${email}|${displayName}`
        : `${username}|${timestamp}`;
    const h = crypto.createHmac('sha256', secret);
    h.update(dataToSign);
    const signature = h.digest('hex');
    return JSON.stringify({ username, email, displayName, timestamp, signature });
}

// ── Minimal req / res / next helpers ─────────────────────────────────────────
function mockReq({ headers = {}, body = {}, query = {}, ip = '127.0.0.1' } = {}) {
    return {
        headers,
        body,
        query,
        method:      'GET',
        originalUrl: '/test',
        socket:      { remoteAddress: ip }
    };
}

function mockRes() {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json   = jest.fn().mockReturnValue(res);
    return res;
}

// ── Load the middleware fresh for each test ───────────────────────────────────
async function loadMiddleware(env = {}) {
    jest.resetModules();

    const saved = {};
    for (const [k, v] of Object.entries(env)) {
        saved[k] = process.env[k];
        process.env[k] = v;
    }

    await jest.unstable_mockModule('../src/utils/logger.js', () => ({
        default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
    }));

    const { ssoMiddleware } = await import('../src/middleware/ssoMiddleware.js');

    return {
        ssoMiddleware,
        restore() {
            for (const [k, v] of Object.entries(saved)) {
                if (v === undefined) delete process.env[k];
                else process.env[k] = v;
            }
        }
    };
}

// ─────────────────────────────────────────────────────────────────────────────
describe('SSO Middleware — sidecar token (PROD mode)', () => {

    test('primary domain user (IBRAHIM1_NT) — token with email resolves correctly', async () => {
        const { ssoMiddleware, restore } = await loadMiddleware({ SSO_MODE: 'PROD' });
        try {
            const token = makeToken({ username: 'IBRAHIM1_NT\\ISRARULHAQ', email: 'israr.haq@igc.com.pk', displayName: 'Israr ul Haq' });
            const req  = mockReq({ headers: { 'x-sidecar-token': token }, ip: '127.0.0.1' });
            const res  = mockRes();
            const next = jest.fn();

            await ssoMiddleware(req, res, next);

            expect(next).toHaveBeenCalledTimes(1);
            expect(req.user.username).toBe('ISRARULHAQ');          // domain prefix stripped
            expect(req.user.email).toBe('israr.haq@igc.com.pk');
            expect(req.user.displayName).toBe('Israr ul Haq');
            expect(req.user.raw.source).toBe('sidecar-token');
        } finally { restore(); }
    });

    test('child domain user (IBRAHIM5_NT / lhr.ifl.net) — token with email resolves correctly', async () => {
        const { ssoMiddleware, restore } = await loadMiddleware({ SSO_MODE: 'PROD' });
        try {
            const token = makeToken({ username: 'IBRAHIM5_NT\\muhammaddaniyal', email: 'Muhammad.Daniyal@igc.com.pk', displayName: 'Muhammad Daniyal' });
            const req  = mockReq({ headers: { 'x-sidecar-token': token }, ip: '127.0.0.1' });
            const res  = mockRes();
            const next = jest.fn();

            await ssoMiddleware(req, res, next);

            expect(next).toHaveBeenCalledTimes(1);
            expect(req.user.username).toBe('muhammaddaniyal');     // domain prefix stripped
            expect(req.user.email).toBe('Muhammad.Daniyal@igc.com.pk');
            expect(req.user.displayName).toBe('Muhammad Daniyal');
            expect(req.user.raw.source).toBe('sidecar-token');
        } finally { restore(); }
    });

    test('token without email — passes through without fabricating an email', async () => {
        const { ssoMiddleware, restore } = await loadMiddleware({ SSO_MODE: 'PROD' });
        try {
            // Simulates what happens if token.aspx GC lookup fails (GC down).
            // Node must NOT invent an email — just forward what it received.
            const token = makeToken({ username: 'IBRAHIM5_NT\\unknownuser', email: '', displayName: '' });
            const req  = mockReq({ headers: { 'x-sidecar-token': token }, ip: '127.0.0.1' });
            const res  = mockRes();
            const next = jest.fn();

            await ssoMiddleware(req, res, next);

            expect(next).toHaveBeenCalledTimes(1);
            expect(req.user.email).toBe('');            // empty — not fabricated
            expect(req.user.displayName).toBe('unknownuser'); // falls back to username
        } finally { restore(); }
    });

    test('token arrives via form body field (not header)', async () => {
        const { ssoMiddleware, restore } = await loadMiddleware({ SSO_MODE: 'PROD' });
        try {
            const raw  = makeToken({ username: 'IFL\\sajeeldilshad', email: 'sajeel.dilshad@ifl.com.pk', displayName: 'Sajeel Dilshad' });
            const req  = mockReq({ body: { 'x-sidecar-token': raw }, ip: '127.0.0.1' });
            const res  = mockRes();
            const next = jest.fn();

            await ssoMiddleware(req, res, next);

            expect(next).toHaveBeenCalledTimes(1);
            expect(req.user.username).toBe('sajeeldilshad');
        } finally { restore(); }
    });

    test('token arrives via query string (last-resort GET)', async () => {
        const { ssoMiddleware, restore } = await loadMiddleware({ SSO_MODE: 'PROD' });
        try {
            const raw  = makeToken({ username: 'IFL\\testuser', email: 'test@igc.com.pk', displayName: 'Test User' });
            const req  = mockReq({ query: { sidecarToken: raw }, ip: '127.0.0.1' });
            const res  = mockRes();
            const next = jest.fn();

            await ssoMiddleware(req, res, next);

            expect(next).toHaveBeenCalledTimes(1);
            expect(req.user.username).toBe('testuser');
        } finally { restore(); }
    });

    test('v1 legacy token (username|timestamp only) is still accepted', async () => {
        const { ssoMiddleware, restore } = await loadMiddleware({ SSO_MODE: 'PROD' });
        try {
            const raw  = makeToken({ username: 'IFL\\legacyuser', email: 'legacy@igc.com.pk', displayName: 'Legacy User', version: 1 });
            const req  = mockReq({ headers: { 'x-sidecar-token': raw }, ip: '127.0.0.1' });
            const res  = mockRes();
            const next = jest.fn();

            await ssoMiddleware(req, res, next);

            expect(next).toHaveBeenCalledTimes(1);
            expect(req.user.username).toBe('legacyuser');
        } finally { restore(); }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('SSO Middleware — token validation failures', () => {

    test('rejects expired token (> 5 minutes old)', async () => {
        const { ssoMiddleware, restore } = await loadMiddleware({ SSO_MODE: 'PROD' });
        try {
            const token = makeToken({ username: 'IFL\\someone', email: 'x@igc.com.pk', displayName: 'X', secondsAgo: 301 });
            const req  = mockReq({ headers: { 'x-sidecar-token': token } });
            const res  = mockRes();
            const next = jest.fn();

            await ssoMiddleware(req, res, next);

            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(401);
            expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized: Token Expired' });
        } finally { restore(); }
    });

    test('rejects token with wrong signature (tampered payload)', async () => {
        const { ssoMiddleware, restore } = await loadMiddleware({ SSO_MODE: 'PROD' });
        try {
            const raw     = makeToken({ username: 'IFL\\attacker', email: 'real@igc.com.pk', displayName: 'Real' });
            const parsed  = JSON.parse(raw);
            parsed.email  = 'hijacked@evil.com';    // tamper after signing
            const req  = mockReq({ headers: { 'x-sidecar-token': JSON.stringify(parsed) } });
            const res  = mockRes();
            const next = jest.fn();

            await ssoMiddleware(req, res, next);

            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(401);
            expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized: Invalid Token' });
        } finally { restore(); }
    });

    test('rejects token signed with wrong secret', async () => {
        const { ssoMiddleware, restore } = await loadMiddleware({ SSO_MODE: 'PROD' });
        try {
            const token = makeToken({ username: 'IFL\\someone', email: 'x@igc.com.pk', displayName: 'X', secret: 'wrong-secret' });
            const req  = mockReq({ headers: { 'x-sidecar-token': token } });
            const res  = mockRes();
            const next = jest.fn();

            await ssoMiddleware(req, res, next);

            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(401);
        } finally { restore(); }
    });

    test('rejects malformed (non-JSON) token', async () => {
        const { ssoMiddleware, restore } = await loadMiddleware({ SSO_MODE: 'PROD' });
        try {
            const req  = mockReq({ headers: { 'x-sidecar-token': 'not-json-at-all' } });
            const res  = mockRes();
            const next = jest.fn();

            await ssoMiddleware(req, res, next);

            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(401);
            expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized: Invalid Token Format' });
        } finally { restore(); }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('SSO Middleware — IIS proxy-header path', () => {

    test('accepts X-Auth-User from loopback IP (IIS proxy)', async () => {
        const { ssoMiddleware, restore } = await loadMiddleware({ SSO_MODE: 'PROD', SSO_TRUST_PROXY_HEADER: 'true' });
        try {
            const req  = mockReq({ headers: { 'x-auth-user': 'IFL\\israrulhaq' }, ip: '127.0.0.1' });
            const res  = mockRes();
            const next = jest.fn();

            await ssoMiddleware(req, res, next);

            expect(next).toHaveBeenCalledTimes(1);
            expect(req.user.username).toBe('israrulhaq');
            expect(req.user.raw.source).toBe('proxy-header');
            expect(req.user.email).toBe('');             // email comes via sidecar token client-side
        } finally { restore(); }
    });

    test('child domain user (IBRAHIM5_NT) accepted via proxy-header from loopback', async () => {
        const { ssoMiddleware, restore } = await loadMiddleware({ SSO_MODE: 'PROD', SSO_TRUST_PROXY_HEADER: 'true' });
        try {
            const req  = mockReq({ headers: { 'x-auth-user': 'IBRAHIM5_NT\\muhammaddaniyal' }, ip: '127.0.0.1' });
            const res  = mockRes();
            const next = jest.fn();

            await ssoMiddleware(req, res, next);

            expect(next).toHaveBeenCalledTimes(1);
            expect(req.user.username).toBe('muhammaddaniyal');  // domain prefix stripped
            expect(req.user.raw.source).toBe('proxy-header');
        } finally { restore(); }
    });

    test('ignores X-Auth-User from external (non-loopback) IP', async () => {
        const { ssoMiddleware, restore } = await loadMiddleware({ SSO_MODE: 'PROD', SSO_TRUST_PROXY_HEADER: 'true' });
        try {
            const req  = mockReq({ headers: { 'x-auth-user': 'IFL\\attacker' }, ip: '10.0.0.99' });
            const res  = mockRes();
            const next = jest.fn();

            await ssoMiddleware(req, res, next);

            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(401);
        } finally { restore(); }
    });

    test('ignores proxy header when SSO_TRUST_PROXY_HEADER is false', async () => {
        const { ssoMiddleware, restore } = await loadMiddleware({ SSO_MODE: 'PROD', SSO_TRUST_PROXY_HEADER: 'false' });
        try {
            const req  = mockReq({ headers: { 'x-auth-user': 'IFL\\someone' }, ip: '127.0.0.1' });
            const res  = mockRes();
            const next = jest.fn();

            await ssoMiddleware(req, res, next);

            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(401);
        } finally { restore(); }
    });

    test('sidecar token takes priority over proxy header when both present', async () => {
        const { ssoMiddleware, restore } = await loadMiddleware({ SSO_MODE: 'PROD' });
        try {
            const token = makeToken({ username: 'IFL\\tokenuser', email: 'token@igc.com.pk', displayName: 'Token User' });
            const req   = mockReq({
                headers: { 'x-sidecar-token': token, 'x-auth-user': 'IFL\\headeruser' },
                ip: '127.0.0.1'
            });
            const res  = mockRes();
            const next = jest.fn();

            await ssoMiddleware(req, res, next);

            expect(next).toHaveBeenCalledTimes(1);
            expect(req.user.username).toBe('tokenuser');         // sidecar wins
            expect(req.user.raw.source).toBe('sidecar-token');
        } finally { restore(); }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('SSO Middleware — MOCK mode', () => {

    test('injects mock identity from env vars, skips all auth', async () => {
        const { ssoMiddleware, restore } = await loadMiddleware({
            SSO_MODE:             'MOCK',
            SSO_MOCK_USERNAME:    'dev.user',
            SSO_MOCK_EMAIL:       'dev.user@ifl.com.pk',
            SSO_MOCK_DISPLAY:     'Dev User',
            SSO_MOCK_DESIGNATION: 'HR'
        });
        try {
            const req  = mockReq();           // no token, no proxy header
            const res  = mockRes();
            const next = jest.fn();

            await ssoMiddleware(req, res, next);

            expect(next).toHaveBeenCalledTimes(1);
            expect(req.user.username).toBe('dev.user');
            expect(req.user.email).toBe('dev.user@ifl.com.pk');
            expect(req.user.raw.mock).toBe(true);
        } finally { restore(); }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('SSO Middleware — OPTIONAL mode', () => {

    test('uses sidecar token when present', async () => {
        const { ssoMiddleware, restore } = await loadMiddleware({ SSO_MODE: 'OPTIONAL' });
        try {
            const token = makeToken({ username: 'IFL\\realuser', email: 'real@igc.com.pk', displayName: 'Real User' });
            const req  = mockReq({ headers: { 'x-sidecar-token': token } });
            const res  = mockRes();
            const next = jest.fn();

            await ssoMiddleware(req, res, next);

            expect(next).toHaveBeenCalledTimes(1);
            expect(req.user.username).toBe('realuser');
            expect(req.user.raw.source).toBe('sidecar-token');
        } finally { restore(); }
    });

    test('falls back to mock identity when no token or proxy header present', async () => {
        const { ssoMiddleware, restore } = await loadMiddleware({ SSO_MODE: 'OPTIONAL', SSO_MOCK_USERNAME: 'dev.user' });
        try {
            const req  = mockReq();
            const res  = mockRes();
            const next = jest.fn();

            await ssoMiddleware(req, res, next);

            expect(next).toHaveBeenCalledTimes(1);
            expect(req.user.username).toBe('dev.user');
            expect(req.user.raw.mock).toBe(true);
        } finally { restore(); }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('SSO Middleware — no identity → 401', () => {

    test('returns 401 in PROD mode with no token and no proxy header', async () => {
        const { ssoMiddleware, restore } = await loadMiddleware({ SSO_MODE: 'PROD' });
        try {
            const req  = mockReq({ ip: '10.0.0.5' }); // external IP, no headers
            const res  = mockRes();
            const next = jest.fn();

            await ssoMiddleware(req, res, next);

            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(401);
            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({ error: expect.stringContaining('Unauthorized') })
            );
        } finally { restore(); }
    });
});

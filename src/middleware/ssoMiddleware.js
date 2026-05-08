import logger from '../utils/logger.js';
import crypto from 'crypto';

const SHARED_SECRET = process.env.SSO_SHARED_SECRET || 'IFL_WORKFLOW_SECRET_KEY_2025';

// SSO_MODE controls authentication behavior.
//
//   "PROD"      (default) — Real sidecar required. Reject any request without a
//                           valid token or trusted proxy header.
//   "MOCK"                — Skip everything; inject a dev identity from
//                           SSO_MOCK_* env vars. For local dev without IIS.
//   "OPTIONAL"            — Try sidecar/proxy-header; fall back to mock user
//                           when neither is present.
const SSO_MODE = (process.env.SSO_MODE || 'PROD').toUpperCase();

// SSO_TRUST_PROXY_HEADER — when "true" (default), accept the X-Auth-User
// header injected by IIS URL Rewrite from {LOGON_USER}. Lets browser-navigation
// requests (no JS to add headers) reach SSO-protected routes. Only safe when
// Node binds to 127.0.0.1 and the IIS proxy is the sole ingress.
const TRUST_PROXY_HEADER = String(process.env.SSO_TRUST_PROXY_HEADER || 'true').toLowerCase() !== 'false';

const buildMockUser = () => ({
    username:    process.env.SSO_MOCK_USERNAME    || 'dev.user',
    email:       process.env.SSO_MOCK_EMAIL       || 'dev.user@ifl.com.pk',
    displayName: process.env.SSO_MOCK_DISPLAY     || 'Dev User (Mock SSO)',
    manager:     null,
    raw:         { mock: true },
    designation: process.env.SSO_MOCK_DESIGNATION || 'HR'
});

// HMAC-SHA256 signer used to verify the signed payload from token.aspx.
function hmac(data) {
    const h = crypto.createHmac('sha256', SHARED_SECRET);
    h.update(data);
    return h.digest('hex');
}

function timingSafeEqualHex(aHex, bHex) {
    const a = Buffer.from(aHex, 'hex');
    const b = Buffer.from(bHex, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

// Verify a sidecar token signature. The token.aspx page can sign two payload
// shapes:
//   (v2 / current)   "username|timestamp|email|displayName"
//   (v1 / legacy)    "username|timestamp"
// We accept either so the upgrade is non-breaking.
function verifyTokenSignature(token) {
    if (!token || !token.signature || !token.username || token.timestamp == null) return false;
    const username  = String(token.username);
    const ts        = String(token.timestamp);
    const email     = typeof token.email       === 'string' ? token.email       : '';
    const display   = typeof token.displayName === 'string' ? token.displayName : '';

    const v2 = hmac(`${username}|${ts}|${email}|${display}`);
    if (timingSafeEqualHex(v2, token.signature)) return true;

    const v1 = hmac(`${username}|${ts}`);
    return timingSafeEqualHex(v1, token.signature);
}

// Only trust headers like X-Auth-User when the request came from the local
// IIS proxy. External forgery is blocked by both this check and the firewall.
function isLoopback(req) {
    const ip = (req.socket && req.socket.remoteAddress) || '';
    const clean = ip.replace(/^::ffff:/, '');
    return clean === '127.0.0.1' || clean === '::1' || clean === 'localhost';
}

// Strip the optional "DOMAIN\" prefix that IIS includes in LOGON_USER.
function stripDomain(s) {
    if (!s) return '';
    const parts = String(s).split('\\');
    return (parts.length > 1 ? parts[1] : parts[0]).trim();
}

// Build req.user from the verified sidecar token. AD lookup is intentionally
// NOT performed here — per client policy Node does not bind to AD directly.
// Identity data is sourced from token.aspx (which runs on the IIS/SharePoint
// host and queries AD locally).
function userFromToken(token) {
    const username = stripDomain(token.username);
    const email = (typeof token.email === 'string' ? token.email : '').trim();
    const displayName = (typeof token.displayName === 'string' ? token.displayName : '').trim() || username;

    // Temporary designation override — until proper AD-group lookup is wired up.
    let designation = '';
    if (email && email.toLowerCase() === 'sajeel.dilshad@perception-it.com') designation = 'HR';

    return {
        username,
        email,
        displayName,
        manager: null,
        raw: { source: 'sidecar-token' },
        designation
    };
}

// Build req.user from the IIS proxy header. Only username is available here —
// no email/displayName, since those come from token.aspx. Pages that need the
// full profile (form pre-fills, badge) hydrate via /api/auth/me using the
// sidecar token, which is fired client-side as soon as JS runs.
function userFromProxyHeader(rawHeader) {
    const username = stripDomain(rawHeader);
    return {
        username,
        email: '',
        displayName: username,
        manager: null,
        raw: { source: 'proxy-header' },
        designation: ''
    };
}


export const ssoMiddleware = async (req, res, next) => {
    try {
        // ─── MOCK mode: skip everything ────────────────────────────────
        if (SSO_MODE === 'MOCK') {
            req.user = buildMockUser();
            logger.info(`[SSO] [MOCK] ${req.user.username} for ${req.method} ${req.originalUrl}`);
            return next();
        }

        // ─── 1. Sidecar HMAC token (preferred — has full profile data) ─
        // The token can arrive on three channels in priority order:
        //   (a) x-sidecar-token request header   — used by AJAX (window.iflFetch)
        //   (b) x-sidecar-token form body field  — HTML form POSTs that can't
        //                                          add custom headers
        //   (c) sidecarToken query string        — last-resort for GETs
        const rawSidecarToken = (
            req.headers['x-sidecar-token']
            || (req.body && req.body['x-sidecar-token'])
            || (req.query && req.query.sidecarToken)
            || ''
        ).toString().trim();

        if (rawSidecarToken) {
            let token;
            try { token = JSON.parse(rawSidecarToken); }
            catch (e) {
                logger.warn(`[SSO] Malformed sidecar token: ${e.message}`);
                return res.status(401).json({ error: 'Unauthorized: Invalid Token Format' });
            }
            const now = Math.floor(Date.now() / 1000);
            if (Math.abs(now - token.timestamp) > 300) {
                logger.warn(`[SSO] Expired token for ${token.username}`);
                return res.status(401).json({ error: 'Unauthorized: Token Expired' });
            }
            if (!verifyTokenSignature(token)) {
                logger.warn(`[SSO] Invalid signature for ${token.username}`);
                return res.status(401).json({ error: 'Unauthorized: Invalid Token' });
            }
            req.user = userFromToken(token);
            logger.info(`[SSO] [SIDECAR] ${req.user.username} (${req.user.email || 'no-email'}) for ${req.method} ${req.originalUrl}`);
            return next();
        }

        // ─── 2. IIS proxy header (browser-navigation fallback) ─────────
        // Only username is available on this path; email/displayName get
        // hydrated client-side via /api/auth/me + the sidecar token.
        const proxyUserRaw = req.headers['x-auth-user'];
        if (TRUST_PROXY_HEADER && proxyUserRaw && isLoopback(req)) {
            req.user = userFromProxyHeader(proxyUserRaw);
            if (req.user.username) {
                logger.info(`[SSO] [PROXY-HEADER] ${req.user.username} for ${req.method} ${req.originalUrl}`);
                return next();
            }
        }

        // ─── 3. OPTIONAL mode falls back to mock identity ──────────────
        if (SSO_MODE === 'OPTIONAL') {
            req.user = buildMockUser();
            logger.info(`[SSO] [OPTIONAL] No sidecar/proxy header; using mock ${req.user.username}`);
            return next();
        }

        // ─── No identity at all → 401 with diagnostic log ──────────────
        const seenIp = (req.socket && req.socket.remoteAddress) || 'unknown';
        const seenAuthUser = req.headers['x-auth-user'] || '<missing>';
        logger.warn(
            `[SSO] 401 on ${req.method} ${req.originalUrl} | ` +
            `from=${seenIp} loopback=${isLoopback(req)} ` +
            `trustProxyHeader=${TRUST_PROXY_HEADER} ` +
            `x-auth-user="${seenAuthUser}" ` +
            `x-sidecar-token=<missing>`
        );
        return res.status(401).json({ error: 'Unauthorized: SSO required. Please open this page from the IFL portal.' });

    } catch (err) {
        logger.error(`[SSO] Middleware error: ${err.message}`);
        return res.status(500).json({ error: 'Internal Authentication Error' });
    }
};

// Expose the resolved mode so other modules / health checks can introspect it.
export const getSSOMode = () => SSO_MODE;

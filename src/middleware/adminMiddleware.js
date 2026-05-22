import logger from '../utils/logger.js';
import crypto from 'crypto';

const SHARED_SECRET = process.env.SSO_SHARED_SECRET || 'IFL_WORKFLOW_SECRET_KEY_2025';

function hmacHex(data) {
    return crypto.createHmac('sha256', SHARED_SECRET).update(data).digest('hex');
}
function timingSafeEq(a, b) {
    const ba = Buffer.from(a, 'hex'), bb = Buffer.from(b, 'hex');
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
function verifySidecarToken(token) {
    if (!token || !token.signature || !token.username || token.timestamp == null) return false;
    const u = String(token.username), ts = String(token.timestamp);
    const e = typeof token.email       === 'string' ? token.email       : '';
    const d = typeof token.displayName === 'string' ? token.displayName : '';
    if (timingSafeEq(hmacHex(`${u}|${ts}|${e}|${d}`), token.signature)) return true;
    return timingSafeEq(hmacHex(`${u}|${ts}`), token.signature); // v1 compat
}

// ── Admin identity list ────────────────────────────────────────────────────────
//
// ADMIN_USERS (preferred) — comma-separated AD login names (sAMAccountName):
//   ADMIN_USERS=israr.haq,ahmed.ali
//
// ADMIN_EMAILS (legacy / fallback) — full email addresses; the local part
// before @ is extracted and treated identically to an ADMIN_USERS entry:
//   ADMIN_EMAILS=israr.haq@igc.com.pk
//
// Both env vars are merged at startup.  Add more admins by appending to either.
// DOMAIN\ prefixes in Windows Auth headers are stripped automatically.
//
// If neither var is set, all admin access is denied (startup warning logged).

const rawUsers  = process.env.ADMIN_USERS  || '';
const rawEmails = process.env.ADMIN_EMAILS || '';

if (!rawUsers.trim() && !rawEmails.trim()) {
    logger.warn('[Admin] Neither ADMIN_USERS nor ADMIN_EMAILS is set — all admin access denied. Set ADMIN_USERS in .env.');
}

// Convert any identity string to a bare AD username:
//   "IBRAHIM\\israr.haq" → "israr.haq"
//   "israr.haq@igc.com.pk" → "israr.haq"
//   "israr.haq"            → "israr.haq"
function toUsername(str) {
    if (!str) return '';
    const bs = str.lastIndexOf('\\');
    if (bs >= 0) return str.slice(bs + 1).toLowerCase().trim();
    const at = str.indexOf('@');
    return (at > 0 ? str.slice(0, at) : str).toLowerCase().trim();
}

const ADMIN_USERNAMES = new Set([
    ...rawUsers.split(',').map(s => toUsername(s.trim())).filter(Boolean),
    ...rawEmails.split(',').map(s => toUsername(s.trim())).filter(Boolean),
]);

const isAdmin = (username) => !!username && ADMIN_USERNAMES.has(username);

// ── API guard ─────────────────────────────────────────────────────────────────
// NEVER returns 401 — IIS intercepts 401 and shows a Windows-Auth login popup
// for every fetch() the page JS makes. Always returns 403 JSON on failure so
// the browser receives it cleanly.
//
// Auth priority:
//   1. x-sidecar-token (HMAC-signed, from window.iflFetch via token.aspx)
//   2. X-Auth-User proxy header (IIS-injected LOGON_USER, loopback connections)
export const adminApiGuard = (req, res, next) => {
    const deny = (reason) => {
        logger.warn(`[Admin] API denied — ${reason} for ${req.method} ${req.originalUrl}`);
        return res.status(403).json({
            success: false,
            error:   'Admin access required. Please open this page from the IFL intranet portal.',
        });
    };

    // ── 1. Sidecar HMAC token ─────────────────────────────────────────────────
    const rawToken = (
        req.headers['x-sidecar-token'] ||
        (req.body  && req.body['x-sidecar-token']) ||
        (req.query && req.query.sidecarToken) ||
        ''
    ).toString().trim();

    if (rawToken) {
        let token;
        try { token = JSON.parse(rawToken); }
        catch { return deny('malformed sidecar token'); }

        const age = Math.abs(Math.floor(Date.now() / 1000) - (token.timestamp || 0));
        if (age > 300) return deny('expired sidecar token');
        if (!verifySidecarToken(token)) return deny('invalid sidecar token signature');

        const username = toUsername(token.username);
        if (!isAdmin(username)) return deny(`"${username}" not in admin list (sidecar)`);

        req.user = { username, email: token.email || '', displayName: token.displayName || username, raw: { source: 'sidecar-token' } };
        logger.info(`[Admin] API granted — ${username} (sidecar) for ${req.method} ${req.originalUrl}`);
        return next();
    }

    // ── 2. IIS proxy header fallback ──────────────────────────────────────────
    const username = toUsername(req.headers['x-auth-user'] || '');
    if (username && isAdmin(username)) {
        req.user = { username, email: '', displayName: username, raw: { source: 'proxy-header' } };
        logger.info(`[Admin] API granted — ${username} (proxy-header) for ${req.method} ${req.originalUrl}`);
        return next();
    }

    return deny(username ? `"${username}" not in admin list` : 'no identity');
};

// ── Legacy API guard (kept for reference — no longer used on admin routes) ────
// Ran after ssoMiddleware; could return 401 which triggers IIS popup.
export const adminMiddleware = (req, res, next) => {
    const user = req.user;
    if (!user) {
        logger.warn(`[Admin] No SSO identity for ${req.method} ${req.originalUrl}`);
        return res.status(403).json({ success: false, error: 'Authentication required.' });
    }
    const username = toUsername(user.username) || toUsername(user.email);
    if (!isAdmin(username)) {
        logger.warn(`[Admin] Access denied — "${username}" not in admin list`);
        return res.status(403).json({ success: false, error: 'Admin access required.' });
    }
    logger.info(`[Admin] Granted — ${username} for ${req.method} ${req.originalUrl}`);
    next();
};

// ── Page guard ────────────────────────────────────────────────────────────────
// Reads the IIS-injected X-Auth-User header directly — NO ssoMiddleware call,
// so it NEVER returns 401 and cannot trigger an IIS Windows-Auth popup loop.
// Non-admins get a 403 render; admins pass through to the HTML shell.
// If the header is absent (direct Node access bypassing IIS) we pass through
// and let the API guards on each data call handle it.
export const adminPageGuard = (req, res, next) => {
    const rawHeader = req.headers['x-auth-user'] || '';
    if (!rawHeader) return next();

    const username = toUsername(rawHeader);
    if (!isAdmin(username)) {
        logger.warn(`[Admin] Page access denied — "${rawHeader}" (${req.originalUrl})`);
        return res.status(403).render('pages/message', {
            title:      'Access Denied',
            heading:    'Admin Access Denied',
            titleClass: 'error',
            icon:       '⛔',
            iconClass:  'error-icon',
            message:    'You are not authorised to access the admin portal. Contact your system administrator.',
        });
    }

    next();
};

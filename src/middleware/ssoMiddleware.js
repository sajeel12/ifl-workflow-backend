import { findUser } from '../services/adService.js';
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

// SSO_TRUST_PROXY_HEADER — when set to "true" (default), accept the
// X-Auth-User header injected by IIS URL Rewrite from {LOGON_USER}. This
// is what lets browser-navigation requests (no JS-injected token) reach
// SSO-protected routes. Only safe when Node binds to 127.0.0.1 and the
// IIS proxy is the sole ingress (port 3000 firewalled externally).
const TRUST_PROXY_HEADER = String(process.env.SSO_TRUST_PROXY_HEADER || 'true').toLowerCase() !== 'false';

const buildMockUser = () => ({
    username:    process.env.SSO_MOCK_USERNAME    || 'dev.user',
    email:       process.env.SSO_MOCK_EMAIL       || 'dev.user@ifl.com.pk',
    displayName: process.env.SSO_MOCK_DISPLAY     || 'Dev User (Mock SSO)',
    manager:     null,
    raw:         { mock: true },
    designation: process.env.SSO_MOCK_DESIGNATION || 'HR'
});

function verifySignature(username, timestamp, signature) {
    const data = `${username}|${timestamp}`;
    const hmac = crypto.createHmac('sha256', SHARED_SECRET);
    hmac.update(data);
    const expectedSignature = hmac.digest('hex');
    const expectedBuffer = Buffer.from(expectedSignature, 'hex');
    const providedBuffer = Buffer.from(signature, 'hex');

    if (expectedBuffer.length !== providedBuffer.length) return false;
    return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

// Only trust headers like X-Auth-User when the request came from the local
// IIS proxy. Anything else could be a forged header from a process that
// reached Node directly (which shouldn't happen if firewalled, but defense
// in depth).
function isLoopback(req) {
    const ip = (req.socket && req.socket.remoteAddress) || '';
    // Strip IPv6-mapped IPv4 prefix
    const clean = ip.replace(/^::ffff:/, '');
    return clean === '127.0.0.1' || clean === '::1' || clean === 'localhost';
}

// Strip the optional "DOMAIN\" prefix that IIS includes in LOGON_USER.
function stripDomain(s) {
    if (!s) return '';
    const parts = String(s).split('\\');
    return (parts.length > 1 ? parts[1] : parts[0]).trim();
}

// Resolve the AD profile + designation for a username and stamp it on req.user.
async function resolveAndStampUser(req, username) {
    const userProfile = await findUser(username);
    if (!userProfile) {
        logger.warn(`[SSO] Authenticated username "${username}" not found in AD`);
        return { ok: false, status: 403, error: 'User Access Denied' };
    }

    // Temporary designation override — until proper AD-group lookup is wired up.
    let designation = '';
    if (userProfile.mail === 'sajeel.dilshad@perception-it.com') {
        designation = 'HR';
    }
    // TODO: replace with real AD-group / designation lookup
    //   designation = await getDesignation(userProfile.sAMAccountName);

    req.user = {
        username:    userProfile.sAMAccountName,
        email:       userProfile.mail,
        displayName: userProfile.displayName,
        manager:     userProfile.manager,
        raw:         userProfile,
        designation: designation
    };
    return { ok: true };
}


export const ssoMiddleware = async (req, res, next) => {
    try {
        // ─── MOCK mode: skip everything ────────────────────────────────
        if (SSO_MODE === 'MOCK') {
            req.user = buildMockUser();
            logger.info(`[SSO] [MOCK] ${req.user.username} for ${req.method} ${req.originalUrl}`);
            return next();
        }

        // ─── 1. Try the IIS proxy header (X-Auth-User from {LOGON_USER}) ───
        // This works for browser-navigation requests where JavaScript can't
        // attach a custom header. The IIS URL Rewrite rule injects the
        // authenticated Windows user as a trusted header on every proxied
        // request. We only honor it from a loopback connection so external
        // forgery isn't possible (assuming Node is firewalled to localhost).
        const proxyUserRaw = req.headers['x-auth-user'];
        if (TRUST_PROXY_HEADER && proxyUserRaw && isLoopback(req)) {
            const username = stripDomain(proxyUserRaw);
            if (username) {
                try {
                    const r = await resolveAndStampUser(req, username);
                    if (!r.ok) return res.status(r.status).json({ error: r.error });
                    logger.info(`[SSO] [PROXY-HEADER] ${username} for ${req.method} ${req.originalUrl}`);
                    return next();
                } catch (adErr) {
                    logger.error(`[SSO] AD lookup failed for "${username}": ${adErr.message}`);
                    return res.status(500).json({ error: 'Authentication Verification Failed' });
                }
            }
        }

        // ─── 2. Try the sidecar HMAC token. The token can arrive on three
        //        channels in priority order:
        //   (a) x-sidecar-token request header   — used by AJAX (window.iflFetch)
        //   (b) x-sidecar-token form body field  — used by HTML form POSTs that
        //                                          can't add custom headers
        //   (c) sidecarToken query string        — last-resort for GETs that
        //                                          can't run JS (rare)
        const rawSidecarToken = (
            req.headers['x-sidecar-token']
            || (req.body && req.body['x-sidecar-token'])
            || (req.query && req.query.sidecarToken)
            || ''
        ).toString().trim();
        if (!rawSidecarToken) {
            // ─── OPTIONAL mode: fall back to mock user ──────────────────
            if (SSO_MODE === 'OPTIONAL') {
                req.user = buildMockUser();
                logger.info(`[SSO] [OPTIONAL] No sidecar/proxy header; using mock ${req.user.username}`);
                return next();
            }
            // Diagnostic — log what we DID receive so we can tell whether
            // the IIS X-Auth-User injection is reaching Node (and from where).
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
        }

        let authenticatedUser = null;
        try {
            const token = JSON.parse(rawSidecarToken);
            const now = Math.floor(Date.now() / 1000);
            if (Math.abs(now - token.timestamp) > 300) {
                logger.warn(`[SSO] Expired token for ${token.username}`);
                return res.status(401).json({ error: 'Unauthorized: Token Expired' });
            }
            if (verifySignature(token.username, token.timestamp, token.signature)) {
                authenticatedUser = token.username;
            } else {
                logger.warn(`[SSO] Invalid signature for ${token.username}`);
                return res.status(401).json({ error: 'Unauthorized: Invalid Token' });
            }
        } catch (e) {
            logger.warn(`[SSO] Malformed sidecar token: ${e.message}`);
            return res.status(401).json({ error: 'Unauthorized: Invalid Token Format' });
        }

        try {
            const username = stripDomain(authenticatedUser);
            const r = await resolveAndStampUser(req, username);
            if (!r.ok) return res.status(r.status).json({ error: r.error });
            logger.info(`[SSO] [SIDECAR] ${username} for ${req.method} ${req.originalUrl}`);
            return next();
        } catch (adErr) {
            logger.error(`[SSO] AD lookup failed: ${adErr.message}`);
            return res.status(500).json({ error: 'Authentication Verification Failed' });
        }

    } catch (err) {
        logger.error(`[SSO] Middleware error: ${err.message}`);
        return res.status(500).json({ error: 'Internal Authentication Error' });
    }
};

// Expose the resolved mode so other modules / health checks can introspect it.
export const getSSOMode = () => SSO_MODE;

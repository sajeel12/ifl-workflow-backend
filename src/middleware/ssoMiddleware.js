import { findUser } from '../services/adService.js';
import logger from '../utils/logger.js';
import crypto from 'crypto';

const SHARED_SECRET = process.env.SSO_SHARED_SECRET || 'IFL_WORKFLOW_SECRET_KEY_2025';

// SSO_MODE controls authentication behavior — useful when local testing
// without the IIS sidecar producing real x-sidecar-token headers.
//
//   "PROD"      (default) — Real sidecar required. Reject any request without a
//                           valid token. Production must always run this.
//   "MOCK"                — Skip the sidecar entirely. Inject a fake user from
//                           SSO_MOCK_* env vars so devs can hit /initiate
//                           without IIS in the loop.
//   "OPTIONAL"            — Try the sidecar; if no header present, fall back
//                           to the mock user. Lets one backend serve both
//                           a real-IIS frontend and a local browser.
const SSO_MODE = (process.env.SSO_MODE || 'PROD').toUpperCase();

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

    if (expectedBuffer.length !== providedBuffer.length) {
        return false;
    }

    return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}


export const ssoMiddleware = async (req, res, next) => {
    try {
        // ─── MOCK mode: skip sidecar entirely, inject a dev identity ───
        if (SSO_MODE === 'MOCK') {
            req.user = buildMockUser();
            logger.info(`[SSO] [MOCK MODE] Injected ${req.user.username} for ${req.method} ${req.originalUrl}`);
            return next();
        }

        const rawSidecarToken = req.headers['x-sidecar-token'] || '';
        const sidecarToken = rawSidecarToken.trim();

        // ─── OPTIONAL mode: fall back to mock user when no sidecar header ───
        if (!sidecarToken) {
            if (SSO_MODE === 'OPTIONAL') {
                req.user = buildMockUser();
                logger.info(`[SSO] [OPTIONAL MODE] No sidecar token; using mock user ${req.user.username}`);
                return next();
            }
            return res.status(401).json({ error: 'Unauthorized: Missing Auth Token. Please open this page from the IFL portal — SSO required.' });
        }

        let authenticatedUser = null;

        try {
            const token = JSON.parse(sidecarToken);

            const now = Math.floor(Date.now() / 1000);
            if (Math.abs(now - token.timestamp) > 300) {
                logger.warn(`[SSO] Expired token for ${token.username}`);
                return res.status(401).json({ error: 'Unauthorized: Token Expired' });
            }

            if (verifySignature(token.username, token.timestamp, token.signature)) {
                authenticatedUser = token.username;
            } else {
                logger.warn(`[SSO] Invalid Signature for ${token.username}`);
                return res.status(401).json({ error: 'Unauthorized: Invalid Token' });
            }
        } catch (e) {
            logger.warn(`[SSO] Malformed Sidecar Token: ${e.message}`);
            return res.status(401).json({ error: 'Unauthorized: Invalid Token Format' });
        }

        if (!authenticatedUser) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const parts = authenticatedUser.split('\\');
        const username = parts.length > 1 ? parts[1] : parts[0];

        try {
            const userProfile = await findUser(username);

            if (!userProfile) {
                logger.warn(`[SSO] User in valid token but not in AD: ${username}`);
                return res.status(403).json({ error: 'User Access Denied' });
            }

            // Temporary designation override — until proper AD-group lookup is wired up.
            // Fixed: this used to be `=` (assignment) which silently overwrote every
            // user's email. Now a strict equality check.
            let designation = '';
            if (userProfile.mail === 'sajeel.dilshad@perception-it.com') {
                designation = 'HR';
            }
            // TODO: replace with real AD-group / designation lookup
            //   designation = await getDesignation(userProfile.sAMAccountName);

            req.user = {
                username: userProfile.sAMAccountName,
                email: userProfile.mail,
                displayName: userProfile.displayName,
                manager: userProfile.manager,
                raw: userProfile,
                designation: designation
            };

            next();
        } catch (adError) {
            logger.error(`[SSO] AD Lookup Failed for ${username}: ${adError.message}`);
            return res.status(500).json({ error: 'Authentication Verification Failed' });
        }

    } catch (err) {
        logger.error(`[SSO] Error in middleware: ${err.message}`);
        res.status(500).json({ error: 'Internal Authentication Error' });
    }
};

// Expose the resolved mode so other modules / health checks can introspect it.
export const getSSOMode = () => SSO_MODE;

import { findUser } from '../services/adService.js';
import logger from '../utils/logger.js';
import crypto from 'crypto';

const SHARED_SECRET = process.env.SSO_SHARED_SECRET || 'IFL_WORKFLOW_SECRET_KEY_2025';

function verifySignature(username, timestamp, signature) {
    const data = `${username}|${timestamp}`;
    const hmac = crypto.createHmac('sha256', SHARED_SECRET);
    hmac.update(data);
    const expectedSignature = hmac.digest('hex');
    return expectedSignature === signature;
}

/**
 * Middleware to handle Integrated Windows Authentication (SSO)
 * Expects 'x-remote-user' header from IIS Reverse Proxy.
 */
export const ssoMiddleware = async (req, res, next) => {
    try {
        // console.log('[SSO Debug] All Headers:', JSON.stringify(req.headers, null, 2));

        let remoteUser = req.headers['x-remote-user'];
        const rawSidecarToken = req.headers['x-sidecar-token'];
        const sidecarToken = rawSidecarToken.strip();
        console.log("Sidecard Token = '", sidecarToken, "'")
        // 1. Priority: Check Sidecar Token (From token.aspx)
        if (sidecarToken) {
            try {
                const token = JSON.parse(sidecarToken);
                // Validate Timestamp (Allow 5 minutes drift)
                const now = Math.floor(Date.now() / 1000);
                if (Math.abs(now - token.timestamp) > 300) {
                    logger.warn(`[SSO] Expired token for ${token.username}`);
                    console.log(`[SSO] Expired token for ${token.username}`)
                    // Fall through to other methods? No, explicit token failure.
                } else if (verifySignature(token.username, token.timestamp, token.signature)) {
                    remoteUser = token.username;
                    logger.debug(`[SSO] Valid Sidecar Token for: ${remoteUser}`);
                    console.log(`[SSO] Valid Sidecar Token for: ${remoteUser}`);
                } else {
                    logger.warn(`[SSO] Invalid Signature for ${token.username}`);
                    console.log(`[SSO] Invalid Signature for ${token.username}`);
                }
            } catch (e) {
                logger.warn(`[SSO] Malformed Sidecar Token: ${e.message}`);
                console.log(`[SSO] Malformed Sidecar Token: ${e.message}`);

            }
        } else {
            return res.status(401).json({ message: "unauthorized" })
        }

        return res.status(401).json({ error: 'Unauthorized: No SSO Identity' });


        // DEV FALLBACK
        if (!remoteUser && process.env.NODE_ENV === 'development') {
            remoteUser = process.env.MOCK_USER || 'MYDOMAIN\\dev.user';
            logger.debug(`[SSO] Development mode: Using mock user ${remoteUser}`);
        }

        if (!remoteUser) {
            logger.warn('[SSO] No user header found. Unauthorized.');
            return res.status(401).json({ error: 'Unauthorized: No SSO Identity' });
        }
        // console.log(remoteUser, "  <-----------------------------------------=== remote user");
        // Format: DOMAIN\username
        const parts = remoteUser.split('\\');
        const username = parts.length > 1 ? parts[1] : parts[0];

        logger.debug(`[SSO] Authenticating user: ${username}`);

        // Fetch full profile from AD
        // Note: In High Traffic, you might want to cache this in Redis/Session
        const userProfile = await findUser(username);

        if (!userProfile) {
            logger.warn(`[SSO] User found in header but not in AD: ${username}`);
            return res.status(403).json({ error: 'User validation failed' });
        }

        // Attach to Request
        req.user = {
            username: userProfile.sAMAccountName,
            email: userProfile.mail,
            displayName: userProfile.displayName,
            manager: userProfile.manager,
            raw: userProfile
        };

        next();
    } catch (err) {
        logger.error(`[SSO] Error in middleware: ${err.message}`);
        res.status(500).json({ error: 'Internal Authentication Error' });
    }
};

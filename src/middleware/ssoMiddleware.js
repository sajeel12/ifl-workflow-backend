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
 * Middleware to handle Integrated Windows Authentication (SSO) via Sidecar
 * Strictly authenticates checks 'x-sidecar-token' from token.aspx
 */
export const ssoMiddleware = async (req, res, next) => {
    try {
        const rawSidecarToken = req.headers['x-sidecar-token'] || '';
        const sidecarToken = rawSidecarToken.trim();

        if (!sidecarToken) {
            return res.status(401).json({ error: 'Unauthorized: Missing Auth Token' });
        }

        let authenticatedUser = null;

        try {
            const token = JSON.parse(sidecarToken);

            // Validate Timestamp (Allow 5 minutes drift)
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

        // Format: DOMAIN\username or just username
        const parts = authenticatedUser.split('\\');
        const username = parts.length > 1 ? parts[1] : parts[0];

        // Fetch full profile from AD
        try {
            const userProfile = await findUser(username);

            if (!userProfile) {
                logger.warn(`[SSO] User in valid token but not in AD: ${username}`);
                return res.status(403).json({ error: 'User Access Denied' });
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
        } catch (adError) {
            // If FindUser crashes (AD Connection error etc), we probably should return 500, or 401 if we want to be safe.
            // But logging it is important.
            logger.error(`[SSO] AD Lookup Failed for ${username}: ${adError.message}`);
            return res.status(500).json({ error: 'Authentication Verification Failed' });
        }

    } catch (err) {
        logger.error(`[SSO] Error in middleware: ${err.message}`);
        res.status(500).json({ error: 'Internal Authentication Error' });
    }
};

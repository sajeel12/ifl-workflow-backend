import { findUser } from '../services/adService.js';
import logger from '../utils/logger.js';

/**
 * Middleware to handle Integrated Windows Authentication (SSO)
 * Expects 'x-remote-user' header from IIS Reverse Proxy.
 */
export const ssoMiddleware = async (req, res, next) => {
    try {
        let remoteUser = req.headers['x-remote-user'];

        // DEV FALLBACK
        if (!remoteUser && process.env.NODE_ENV === 'development') {
            remoteUser = process.env.MOCK_USER || 'MYDOMAIN\\dev.user';
            logger.debug(`[SSO] Development mode: Using mock user ${remoteUser}`);
        }

        if (!remoteUser) {
            logger.warn('[SSO] No user header found. Unauthorized.');
            return res.status(401).json({ error: 'Unauthorized: No SSO Identity' });
        }

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

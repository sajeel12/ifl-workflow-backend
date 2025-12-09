import adService from '../services/adService.js';
import logger from '../utils/logger.js';

const ssoMiddleware = async (req, res, next) => {
    // In IIS with Windows Auth, the user is passed in x-remote-user or similar headers
    let username = req.headers['x-remote-user'] || req.headers['x-forwarded-user'];

    // DEV BACKDOOR: If no header (local dev), use .env fallback
    if (!username && process.env.NODE_ENV === 'development') {
        username = 'MYDOMAIN\\dev.user';
        logger.debug(`Using Mock SSO User: ${username}`);
    }

    if (!username) {
        return res.status(401).json({ error: 'Unauthorized: No SSO Identity Found' });
    }

    try {
        // Optionally fetch full profile here if needed, or just attach username
        // For performance, you might cache this or only fetch on specific endpoints
        req.user = {
            id: username,
            username: username.split('\\').pop()
        };
        next();
    } catch (error) {
        logger.error('SSO Middleware Error', error);
        res.status(500).json({ error: 'Internal Auth Error' });
    }
};

export default ssoMiddleware;

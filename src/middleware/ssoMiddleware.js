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
        // Fetch full profile from AD
        let adProfile = null;
        try {
            adProfile = await adService.findUser(username);
        } catch (adError) {
            logger.warn('AD Lookup failed for SSO user', adError);
        }

        req.user = {
            id: username,
            username: username.split('\\').pop(),
            ...(adProfile || {})
        };
        next();
    } catch (error) {
        logger.error('SSO Middleware Error', error);
        res.status(500).json({ error: 'Internal Auth Error' });
    }
};

export default ssoMiddleware;

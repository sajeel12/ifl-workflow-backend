import logger from '../utils/logger.js';


export const getCurrentUser = (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: 'Not authenticated' });
        }

        logger.info(`User requested own profile: ${req.user.username}`);
        res.json({
            user: req.user,
            authMethod: 'SSO/Kerberos',
            timestamp: new Date()
        });
    } catch (error) {
        logger.error(`Error in getCurrentUser: ${error.message}`);
        res.status(500).json({ error: 'Internal Server Error' });
    }
};

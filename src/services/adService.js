import logger from '../utils/logger.js';
// import ActiveDirectory from 'activedirectory2'; // Dynamic import used below

// AD Connection Config (used by SSO middleware)
const adConfig = {
    url: process.env.AD_URL || 'ldap://your-dc.ifl.local',
    baseDN: process.env.AD_BASE_DN || 'dc=ifl,dc=local',
    username: process.env.AD_USERNAME || 'svc_account@ifl.local',
    password: process.env.AD_PASSWORD || 'password'
};

let ad = null;

// Initialize AD Client dynamically
(async () => {
    try {
        const adModule = await import('activedirectory2');
        const ActiveDirectory = adModule.default;
        ad = new ActiveDirectory(adConfig);
        logger.info('[ADService] ActiveDirectory client initialized.');
    } catch (err) {
        logger.warn(`[ADService] Could not initialize AD client (Module not found or config error): ${err.message}`);
        logger.warn('[ADService] Running in MOCK mode.');
    }
})();

/**
 * Find a user in Active Directory by sAMAccountName.
 * Used by ssoMiddleware for authentication.
 */
export const findUser = (username) => {
    return new Promise((resolve, reject) => {
        if (!ad) {
            // Fallback mock for dev environments without AD
            logger.warn(`[ADService] AD not available, returning mock user for: ${username}`);
            return resolve({
                sAMAccountName: username,
                mail: `${username}@ifl.com`,
                displayName: username,
                manager: null
            });
        }
        ad.findUser(username, (err, user) => {
            if (err) return reject(err);
            resolve(user);
        });
    });
};

// Stub AD Service (for RecipientService group lookups)
// In future, this will use 'activedirectory2' or 'ldapjs'
const ADService = {
    /**
     * Get email for a Distribution List or Security Group
     * @param {string} groupName - CN of the group
     * @returns {Promise<string|null>}
     */
    getGroupEmail: async (groupName) => {
        logger.debug(`[ADService] Looking up email for group: ${groupName}`);

        // Mock Data
        const mockGroups = {
            'IT_Operations_DL': 'it.ops@ifl.com',
            'DCI_Team_DL': 'dti.support@ifl.com',
            'OPS_Support_DL': 'ops.support@ifl.com'
        };

        const email = mockGroups[groupName];
        if (email) {
            logger.debug(`[ADService] Found: ${email}`);
            return email;
        }

        logger.warn(`[ADService] Group not found: ${groupName}`);
        return null; // Or throw error based on preference
    },

    /**
     * Get details for a specific user
     * @param {string} sAMAccountName 
     */
    getUser: async (sAMAccountName) => {
        // Future implementation
    }
};

export const getAllUsers = async (limit = 10) => {
    logger.info(`[ADService] Mock getAllUsers called with limit ${limit}`);
    return [
        { sAMAccountName: 'mock.user1', mail: 'mock1@ifl.com', displayName: 'Mock User 1' },
        { sAMAccountName: 'mock.user2', mail: 'mock2@ifl.com', displayName: 'Mock User 2' }
    ];
};

export const debugDumpAD = async () => {
    logger.info('[ADService] Mock debugDumpAD called');
    return { message: 'Debug dump not implemented in mock mode' };
};

export default ADService;

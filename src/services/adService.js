import logger from '../utils/logger.js';
import ActiveDirectory from 'activedirectory2';

// AD Connection Config (used by SSO middleware)
const adConfig = {
    url: process.env.AD_URL || 'ldap://your-dc.ifl.local',
    baseDN: process.env.AD_BASE_DN || 'dc=ifl,dc=local',
    username: process.env.AD_USERNAME || 'svc_account@ifl.local',
    password: process.env.AD_PASSWORD || 'password'
};

let ad = null;
try {
    ad = new ActiveDirectory(adConfig);
} catch (err) {
    logger.warn(`[ADService] Could not initialize AD client: ${err.message}`);
}

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

export default ADService;

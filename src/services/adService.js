import logger from '../utils/logger.js';

// Stub AD Service
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

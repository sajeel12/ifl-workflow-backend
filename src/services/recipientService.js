import logger from '../utils/logger.js';
import ADService from './adService.js';
import HRMSService from './hrmsService.js';

const RecipientService = {
    /**
     * Resolve the final email address for a given role/context.
     * Applies Test Mode redirection if enabled.
     * 
     * @param {string} roleKey - 'HOD', 'IT_OPS', 'DCI_MANAGER', etc.
     * @param {object} context - { employeeId, department, etc. }
     * @returns {Promise<string>}
     */
    get: async (roleKey, context = {}) => {
        let recipientEmail = null;
        let source = 'UNKNOWN';

        try {
            // 1. Resolve Logical Email
            switch (roleKey) {
                case 'IT_OPS':
                    recipientEmail = await ADService.getGroupEmail('IT_Operations_DL');
                    source = 'AD_Group';
                    break;
                case 'DCI_TEAM':
                    recipientEmail = await ADService.getGroupEmail('DCI_Team_DL');
                    source = 'AD_Group';
                    break;
                case 'OPS_TEAM':
                    recipientEmail = await ADService.getGroupEmail('OPS_Support_DL');
                    source = 'AD_Group';
                    break;

                case 'HOD':
                    // Connect to HRMS Service
                    const manager = await HRMSService.getManager(context.employeeId);
                    if (manager && manager.email) {
                        recipientEmail = manager.email;
                        source = 'HRMS_API';
                    } else {
                        // Fallback if no manager found in HRMS
                        recipientEmail = 'hod.substitute@ifl.com';
                        source = 'HRMS_Fallback';
                    }
                    break;

                case 'DCI_MANAGER':
                    // Could be from DB Config or specific user
                    recipientEmail = process.env.EMAIL_DCI_MANAGER || 'dci.manager@ifl.com';
                    source = 'ENV';
                    break;

                case 'IT_HOD':
                    recipientEmail = process.env.EMAIL_IT_HOD || 'it.hod@ifl.com';
                    source = 'ENV';
                    break;

                case 'DCI_IMPLEMENTER':
                    recipientEmail = 'dzi.implementer@ifl.com'; // Or pool of admins
                    source = 'Hardcoded';
                    break;

                default:
                    logger.warn(`[RecipientService] Unknown Role Key: ${roleKey}`);
                    return null;
            }

            // 2. Test Mode Interception
            // Default to 'DEV' if not specified
            const emailMode = process.env.EMAIL_MODE || 'DEV';

            if (emailMode === 'DEV') {
                const safeEmail = process.env.TEST_RECIPIENT_EMAIL || 'developer@local.test';

                logger.info(`[RecipientService] [TEST MODE] Redirecting ${roleKey} email.`);
                logger.info(`   > Intended: ${recipientEmail} (${source})`);
                logger.info(`   > Actual:   ${safeEmail}`);

                return safeEmail;
            }

            logger.info(`[RecipientService] Resolved ${roleKey} to ${recipientEmail} from ${source}`);
            return recipientEmail;

        } catch (err) {
            logger.error(`[RecipientService] Error resolving ${roleKey}: ${err.message}`);
            // Fallback to safety
            return process.env.TEST_RECIPIENT_EMAIL || 'fallback@local.test';
        }
    }
};

export default RecipientService;

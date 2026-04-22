import logger from '../utils/logger.js';
import HRMSService from './hrmsService.js';
import WorkflowApproverConfig from '../models/WorkflowApproverConfig.js';

const RecipientService = {
    /**
     * Resolve the final email address for a given role/context.
     * Reads approver emails from DB (admin-configurable), with env-var fallback.
     * Applies Test Mode redirection if EMAIL_MODE=DEV.
     *
     * @param {string} roleKey - 'HOD' | 'IT_OPS' | 'DCI_TEAM' | 'OPS_TEAM' | 'DCI_MANAGER' | 'IT_HOD' | 'DCI_IMPLEMENTER'
     * @param {object} context - { employeeId, department, ... }
     * @returns {Promise<string|null>}
     */
    get: async (roleKey, context = {}) => {
        let recipientEmail = null;
        let source = 'UNKNOWN';

        try {
            if (roleKey === 'HOD') {
                // HOD is per-employee — resolved dynamically via HRMS
                const manager = await HRMSService.getManager(context.employeeId);
                if (manager && manager.email) {
                    recipientEmail = manager.email;
                    source = 'HRMS';
                } else {
                    // Fallback: check if admin configured a HOD_FALLBACK
                    const cfg = await WorkflowApproverConfig.findOne({ where: { roleKey: 'HOD_FALLBACK', isActive: true } });
                    recipientEmail = cfg?.approverEmail || process.env.EMAIL_HOD_FALLBACK || null;
                    source = cfg ? 'DB_Fallback' : 'ENV_Fallback';
                }
            } else {
                // All other roles: read from admin-configured DB record
                const cfg = await WorkflowApproverConfig.findOne({ where: { roleKey, isActive: true } });

                if (cfg && cfg.approverEmail) {
                    recipientEmail = cfg.approverEmail;
                    source = 'DB';
                } else {
                    // Env-var fallback map
                    const envFallbacks = {
                        IT_OPS:          process.env.EMAIL_IT_OPS,
                        DCI_TEAM:        process.env.EMAIL_DCI_TEAM,
                        OPS_TEAM:        process.env.EMAIL_OPS_TEAM,
                        DCI_MANAGER:     process.env.EMAIL_DCI_MANAGER,
                        IT_HOD:          process.env.EMAIL_IT_HOD,
                        DCI_IMPLEMENTER: process.env.EMAIL_DCI_IMPLEMENTER,
                    };
                    recipientEmail = envFallbacks[roleKey] || null;
                    source = recipientEmail ? 'ENV' : 'NONE';

                    if (!recipientEmail) {
                        logger.warn(`[RecipientService] No email configured for role "${roleKey}". Set it in Admin > Workflow Approvers.`);
                        return null;
                    }
                }
            }

            // Test Mode interception
            const emailMode = process.env.EMAIL_MODE || 'DEV';
            if (emailMode === 'DEV') {
                const safeEmail = process.env.TEST_RECIPIENT_EMAIL || 'developer@local.test';
                logger.info(`[RecipientService] [TEST MODE] ${roleKey}: intended=${recipientEmail} (${source}) → actual=${safeEmail}`);
                return safeEmail;
            }

            logger.info(`[RecipientService] Resolved ${roleKey} → ${recipientEmail} (${source})`);
            return recipientEmail;

        } catch (err) {
            logger.error(`[RecipientService] Error resolving ${roleKey}: ${err.message}`);
            return process.env.TEST_RECIPIENT_EMAIL || 'fallback@local.test';
        }
    }
};

export default RecipientService;

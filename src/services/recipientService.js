import logger from '../utils/logger.js';
import HRMSService from './hrmsService.js';
import WorkflowApproverConfig from '../models/WorkflowApproverConfig.js';

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

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
                const manager = await HRMSService.getManager(context.employeeId);
                if (manager && manager.email) {
                    recipientEmail = manager.email;
                    source = 'HRMS';
                } else {
                    const cfg = await WorkflowApproverConfig.findOne({ where: { roleKey: 'HOD_FALLBACK', isActive: true } });
                    recipientEmail = cfg?.approverEmail || process.env.EMAIL_HOD_FALLBACK || null;
                    source = cfg ? 'DB_Fallback' : 'ENV_Fallback';
                }
            } else {
                const cfg = await WorkflowApproverConfig.findOne({ where: { roleKey, isActive: true } });

                if (cfg && cfg.approverEmail) {
                    recipientEmail = cfg.approverEmail;
                    source = 'DB';
                } else {
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
    },

    /**
     * Resolve recipient using the Primary / Secondary fallback logic:
     *   - If primary was assigned > 2 days ago and hasn't responded → use secondary & mark primaryExpiredAt
     *   - Special case: DCI_MANAGER ↔ IT_HOD back each other up when primary is blank/expired
     *   - No further fallback after secondary
     *
     * @param {string} roleKey
     * @param {object} context - { employeeId, requestId, assignedAt }
     * @returns {Promise<{email: string|null, name: string, isFallback: boolean, source: string}>}
     */
    getWithFallback: async (roleKey, context = {}) => {
        try {
            if (roleKey === 'HOD') {
                const email = await RecipientService.get(roleKey, context);
                return { email, name: '', isFallback: false, source: 'HRMS' };
            }

            const cfg = await WorkflowApproverConfig.findOne({ where: { roleKey, isActive: true } });

            if (!cfg) {
                const email = await RecipientService.get(roleKey, context);
                return { email, name: '', isFallback: false, source: 'ENV' };
            }

            const now = new Date();
            const primaryStale =
                cfg.lastAssignedAt &&
                (now - new Date(cfg.lastAssignedAt)) > TWO_DAYS_MS &&
                !cfg.primaryExpiredAt;

            // If primary expired, mark it and use secondary
            if (primaryStale && cfg.secondaryEmail) {
                await cfg.update({ primaryExpiredAt: now });
                logger.info(`[RecipientService] Primary expired for ${roleKey} — using secondary ${cfg.secondaryEmail}`);
                return RecipientService._applyTestMode(cfg.secondaryEmail, cfg.secondaryName || '', true, 'DB_Secondary', roleKey);
            }

            // If primary missing and already expired, use secondary
            if ((!cfg.approverEmail || cfg.primaryExpiredAt) && cfg.secondaryEmail) {
                return RecipientService._applyTestMode(cfg.secondaryEmail, cfg.secondaryName || '', true, 'DB_Secondary', roleKey);
            }

            // Special-case cross-backup for DCI_MANAGER ↔ IT_HOD
            if ((roleKey === 'DCI_MANAGER' || roleKey === 'IT_HOD') && !cfg.approverEmail && !cfg.secondaryEmail) {
                const backupRole = roleKey === 'DCI_MANAGER' ? 'IT_HOD' : 'DCI_MANAGER';
                const backup = await WorkflowApproverConfig.findOne({ where: { roleKey: backupRole, isActive: true } });
                if (backup?.approverEmail) {
                    logger.info(`[RecipientService] ${roleKey} empty — using ${backupRole} as cross-backup`);
                    return RecipientService._applyTestMode(backup.approverEmail, backup.approverName || '', true, 'DB_CrossBackup', roleKey);
                }
            }

            // Happy path: use primary and stamp lastAssignedAt if this is a new routing
            if (cfg.approverEmail) {
                if (context.requestId) {
                    await cfg.update({ lastAssignedAt: now, primaryExpiredAt: null });
                }
                return RecipientService._applyTestMode(cfg.approverEmail, cfg.approverName || '', false, 'DB_Primary', roleKey);
            }

            // Nothing configured — env fallback via plain get()
            const email = await RecipientService.get(roleKey, context);
            return { email, name: '', isFallback: false, source: 'ENV' };

        } catch (err) {
            logger.error(`[RecipientService] Error in getWithFallback for ${roleKey}: ${err.message}`);
            const email = process.env.TEST_RECIPIENT_EMAIL || 'fallback@local.test';
            return { email, name: '', isFallback: true, source: 'ERROR' };
        }
    },

    _applyTestMode(intended, name, isFallback, source, roleKey) {
        const emailMode = process.env.EMAIL_MODE || 'DEV';
        if (emailMode === 'DEV') {
            const safe = process.env.TEST_RECIPIENT_EMAIL || 'developer@local.test';
            logger.info(`[RecipientService] [TEST MODE] ${roleKey}: intended=${intended} (${source}) → actual=${safe}`);
            return { email: safe, name, isFallback, source };
        }
        logger.info(`[RecipientService] Resolved ${roleKey} → ${intended} (${source})`);
        return { email: intended, name, isFallback, source };
    }
};

export default RecipientService;

import logger from '../utils/logger.js';
import HRMSService from './hrmsService.js';
import WorkflowApproverConfig from '../models/WorkflowApproverConfig.js';
import WorkflowApproverLocationOverride from '../models/WorkflowApproverLocationOverride.js';

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

// Per-client policy: only the IT Operations team is split by location.
// All other roles (DCI Team, DCI Manager, IT HOD, DCI Implementer) operate
// from a single global pool. Requests against the override table for any
// other roleKey are ignored even if rows exist — keeps the model honest.
const LOCATION_AWARE_ROLES = new Set(['IT_OPS']);

/**
 * Resolve the per-(role, location) approver row, or return null if no
 * override exists for this location AND this role is location-aware.
 */
async function findLocationOverride(roleKey, location) {
    if (!location) return null;
    if (!LOCATION_AWARE_ROLES.has(roleKey)) return null;
    return WorkflowApproverLocationOverride.findOne({
        where: { roleKey, location, isActive: true }
    });
}

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
                // Try location-specific override first, fall back to global config.
                const override = await findLocationOverride(roleKey, context.location);
                const cfg = override || await WorkflowApproverConfig.findOne({ where: { roleKey, isActive: true } });

                if (cfg && cfg.approverEmail) {
                    recipientEmail = cfg.approverEmail;
                    source = override ? `DB_LOC[${context.location}]` : 'DB';
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

            // Try the per-location override first. If one exists and is active,
            // it completely replaces the global config for THIS request — both
            // primary/secondary AND the lastAssignedAt tracking happen on the
            // override row, so the 2-day fallback timer is location-scoped.
            const override = await findLocationOverride(roleKey, context.location);
            const cfg = override || await WorkflowApproverConfig.findOne({ where: { roleKey, isActive: true } });
            const usingOverride = !!override;
            const sourceTag = usingOverride ? `LOC[${context.location}]` : 'GLOBAL';

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
                logger.info(`[RecipientService] Primary expired for ${roleKey}/${sourceTag} — using secondary ${cfg.secondaryEmail}`);
                return RecipientService._applyTestMode(cfg.secondaryEmail, cfg.secondaryName || '', true, `DB_Secondary_${sourceTag}`, roleKey);
            }

            // If primary missing and already expired, use secondary
            if ((!cfg.approverEmail || cfg.primaryExpiredAt) && cfg.secondaryEmail) {
                return RecipientService._applyTestMode(cfg.secondaryEmail, cfg.secondaryName || '', true, `DB_Secondary_${sourceTag}`, roleKey);
            }

            // Special-case cross-backup for DCI_MANAGER ↔ IT_HOD — cross-backup
            // looks at the same location's override first, then global config.
            if ((roleKey === 'DCI_MANAGER' || roleKey === 'IT_HOD') && !cfg.approverEmail && !cfg.secondaryEmail) {
                const backupRole = roleKey === 'DCI_MANAGER' ? 'IT_HOD' : 'DCI_MANAGER';
                const backupOverride = await findLocationOverride(backupRole, context.location);
                const backup = backupOverride || await WorkflowApproverConfig.findOne({ where: { roleKey: backupRole, isActive: true } });
                if (backup?.approverEmail) {
                    logger.info(`[RecipientService] ${roleKey}/${sourceTag} empty — using ${backupRole} as cross-backup`);
                    return RecipientService._applyTestMode(backup.approverEmail, backup.approverName || '', true, `DB_CrossBackup_${sourceTag}`, roleKey);
                }
            }

            // Happy path: use primary and stamp lastAssignedAt if this is a new routing
            if (cfg.approverEmail) {
                if (context.requestId) {
                    await cfg.update({ lastAssignedAt: now, primaryExpiredAt: null });
                }
                return RecipientService._applyTestMode(cfg.approverEmail, cfg.approverName || '', false, `DB_Primary_${sourceTag}`, roleKey);
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

import { Op } from 'sequelize';
import OnboardingRequest from '../models/OnboardingRequest.js';
import WorkflowApproverConfig from '../models/WorkflowApproverConfig.js';
import WorkflowApproverLocationOverride from '../models/WorkflowApproverLocationOverride.js';
import TimelineEvent from '../models/TimelineEvent.js';
import * as emailService from './emailService.js';
import logger from '../utils/logger.js';
import { emailsMatch } from '../utils/emailMatch.js';

const TWO_DAYS_MS = 48 * 60 * 60 * 1000;

// Roles that use the 2-day primary→secondary fallback model. Each entry maps a
// pending status to the role responsible, the email type for the notification,
// and the request field that marks when the stage started (so we measure the
// correct 48h window — not when the request was created, but when THIS stage
// began).
const FALLBACK_ELIGIBLE = {
    PendingIT: {
        roleKey:        'IT_OPS',
        emailType:      'IT_OPS',
        stageStartField: 'hrSubmittedAt'
    },
    PendingDCI: {
        roleKey:        'DCI_TEAM',
        emailType:      'DCI_INPUT',
        stageStartField: 'hodApprovedAt'
    },
    PendingDCIImplementation: {
        roleKey:        'DCI_IMPLEMENTER',
        emailType:      'DCI_IMPLEMENTATION',
        stageStartField: null          // special — see getStageStartedAt()
    },
    PendingOPSAction: {
        roleKey:        'IT_OPS',
        emailType:      'OPS_ACTION',
        stageStartField: 'dciImplementedAt'
    }
};

const LOCATION_AWARE = new Set(['IT_OPS', 'HR_INITIATOR']);

// Resolve the active approver config for this role/location, checking the
// per-location override table first (same priority as RecipientService).
async function resolveConfig(roleKey, location) {
    let override = null;
    if (location && LOCATION_AWARE.has(roleKey)) {
        override = await WorkflowApproverLocationOverride.findOne({
            where: { roleKey, location, isActive: true }
        });
    }
    const globalCfg = await WorkflowApproverConfig.findOne({
        where: { roleKey, isActive: true }
    });
    return { activeCfg: override || globalCfg };
}

// PendingDCIImplementation can be reached from two paths:
//   email required → via IT HOD (itHodDecidedAt)
//   no email       → directly from DCI Manager (dciManagerDecidedAt)
// Use whichever timestamp is set; fall back to the other.
function getStageStartedAt(request, status) {
    if (status === 'PendingDCIImplementation') {
        return request.itHodDecidedAt || request.dciManagerDecidedAt;
    }
    const field = FALLBACK_ELIGIBLE[status]?.stageStartField;
    return field ? request[field] : null;
}

/**
 * Scan every in-flight request that is waiting on a 2-day-fallback role.
 * For each one where the stage has been open > 48 hours and the primary has
 * not acted, automatically re-route to the configured secondary:
 *   1. Stamp primaryExpiredAt on the role config row (new requests also go to secondary).
 *   2. Update currentStageAssigneeEmail on the request to the secondary's address.
 *   3. Re-send the action link email to secondary (same token — same form).
 *   4. Write a System timeline event so the audit trail is clear.
 *
 * Idempotent: a request whose currentStageAssigneeEmail already matches
 * secondary is skipped, so repeated cron runs do not re-send emails.
 *
 * @returns {{ checked: number, escalated: number }}
 */
export async function runEscalationCheck() {
    const statuses = Object.keys(FALLBACK_ELIGIBLE);
    logger.info(`[Escalation] Starting 48h check — statuses: ${statuses.join(', ')}`);

    const requests = await OnboardingRequest.findAll({
        where: { status: { [Op.in]: statuses } }
    });

    let checked = 0;
    let escalated = 0;

    for (const request of requests) {
        try {
            checked++;
            const stageCfg = FALLBACK_ELIGIBLE[request.status];
            if (!stageCfg) continue;

            // Measure how long this stage has been open
            const stageStartedAt = getStageStartedAt(request, request.status);
            if (!stageStartedAt) continue;
            const ageMs = Date.now() - new Date(stageStartedAt).getTime();
            if (ageMs < TWO_DAYS_MS) continue;   // still within 48h — nothing to do

            // Resolve the approver config (location override first, then global)
            const { activeCfg } = await resolveConfig(stageCfg.roleKey, request.location);
            if (!activeCfg?.secondaryEmail) continue;  // no secondary to escalate to

            // Idempotency: if we already escalated this request, skip
            if (emailsMatch(request.currentStageAssigneeEmail, activeCfg.secondaryEmail)) continue;

            // Safety: can't resend if the token is gone (shouldn't happen for in-flight)
            if (!request.currentStageToken) continue;

            const hoursStalled = Math.round(ageMs / 3_600_000);
            logger.info(
                `[Escalation] Request #${request.id} stalled ${hoursStalled}h in ${request.status} ` +
                `(${request.location || 'global'}) — escalating from ${activeCfg.approverEmail} → ${activeCfg.secondaryEmail}`
            );

            // 1. Mark primary expired on the config row so any new requests for
            //    this role also route to secondary (primary is unresponsive).
            if (!activeCfg.primaryExpiredAt) {
                await activeCfg.update({ primaryExpiredAt: new Date() });
            }

            // 2. Update the request's assignee so the auth gate recognises the new owner
            await request.update({ currentStageAssigneeEmail: activeCfg.secondaryEmail });

            // 3. Re-send the action link to secondary — same token means same form
            const actionLink = `${process.env.APP_URL}/api/onboarding/handle?token=${request.currentStageToken}`;
            await emailService.sendOnboardingNotification(
                activeCfg.secondaryEmail,
                request,
                actionLink,
                stageCfg.emailType
            );

            // 4. Audit trail entry
            await TimelineEvent.create({
                requestId: request.id,
                action:    'Auto-Escalated to Secondary',
                actorRole: 'System',
                details:   `Primary (${activeCfg.approverEmail}) did not act within 48 hours. ` +
                           `Stage automatically escalated to secondary (${activeCfg.secondaryEmail}).`,
                timestamp: new Date()
            });

            escalated++;
        } catch (err) {
            logger.error(`[Escalation] Error on request #${request.id}: ${err.message}`);
        }
    }

    logger.info(`[Escalation] Done — checked ${checked}, escalated ${escalated}.`);
    return { checked, escalated };
}

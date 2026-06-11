import { Op } from 'sequelize';
import OnboardingRequest from '../models/OnboardingRequest.js';
import OffboardingRequest from '../models/OffboardingRequest.js';
import InternetBrowsingRequest from '../models/InternetBrowsingRequest.js';
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

// Internet Browsing fallback-eligible stages. Same 2-day primary→secondary
// model as the onboarding map above, keyed by IBR statuses + IBR email types
// and portal slugs. Only roles with a primary/secondary fallback config
// participate (IT_OPS validation, FMS, Network Implementer). HOD / RN (IT_OPS
// again) / IT HOD are delegation-style — handled by admin reassignment.
const IBR_FALLBACK_ELIGIBLE = {
    PendingITOpsValidation: {
        roleKey:         'IT_OPS',
        emailType:       'IT_OPS_VALIDATION',
        slug:            'it-ops',
        stageStartField: 'initiatedAt'
    },
    PendingFMS: {
        roleKey:         'NETWORK_VALIDATOR',
        emailType:       'FMS_VALIDATION',
        slug:            'network-validator',
        stageStartField: 'hodApprovedAt'
    },
    PendingImplementation: {
        roleKey:         'NETWORK_IMPLEMENTER',
        emailType:       'IMPLEMENTATION',
        slug:            'network-implementer',
        stageStartField: 'itHodApprovedAt'
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
            await request.update({
                currentStageAssigneeEmail:    activeCfg.secondaryEmail,
                currentStageAssigneeUsername: activeCfg.secondaryUsername || null
            });

            // 3. Re-send the action link to secondary via portal (same token = same form).
            const ESCALATION_SLUG = { IT_OPS: 'it-ops', DCI_TEAM: 'dci-team', DCI_IMPLEMENTER: 'dci-implementer' };
            const portalSlug = ESCALATION_SLUG[stageCfg.roleKey];
            const actionLink = portalSlug
                ? `${process.env.APP_URL}/portal/${portalSlug}/enter?action=${request.currentStageToken}`
                : `${process.env.APP_URL}/api/onboarding/handle?token=${request.currentStageToken}`;
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

    logger.info(`[Escalation] Done (onboarding) — checked ${checked}, escalated ${escalated}.`);

    // IBR pass — same 48h primary→secondary logic for Internet Browsing.
    try {
        const ibr = await runIBREscalationCheck();
        checked   += ibr.checked;
        escalated += ibr.escalated;
    } catch (err) {
        logger.error(`[Escalation] IBR pass failed: ${err.message}`);
    }

    // Second pass: delegation auto-revert. Independent of the 48h
    // primary→secondary timer above. Operates on both Onboarding and
    // Offboarding requests where the delegationEvent JSON has been set by
    // admin's delegation rebind in adminController.js.
    try {
        const revertResult = await runDelegationRevertCheck();
        return { checked, escalated, delegationReverts: revertResult };
    } catch (err) {
        logger.error(`[Escalation] Delegation revert pass failed: ${err.message}`);
        return { checked, escalated, delegationReverts: { checked: 0, reverted: 0 } };
    }
}

// 48h primary→secondary escalation for Internet Browsing requests. Same
// shape as runEscalationCheck's onboarding loop, scoped to IBR statuses +
// the IBR email/slug maps. Returns { checked, escalated }.
async function runIBREscalationCheck() {
    const statuses = Object.keys(IBR_FALLBACK_ELIGIBLE);
    logger.info(`[Escalation] Starting 48h IBR check — statuses: ${statuses.join(', ')}`);

    const requests = await InternetBrowsingRequest.findAll({
        where: { status: { [Op.in]: statuses } }
    });

    let checked = 0;
    let escalated = 0;

    for (const request of requests) {
        try {
            checked++;
            const stageCfg = IBR_FALLBACK_ELIGIBLE[request.status];
            if (!stageCfg) continue;

            const stageStartedAt = request[stageCfg.stageStartField];
            if (!stageStartedAt) continue;
            const ageMs = Date.now() - new Date(stageStartedAt).getTime();
            if (ageMs < TWO_DAYS_MS) continue;

            const { activeCfg } = await resolveConfig(stageCfg.roleKey, request.location);
            if (!activeCfg?.secondaryEmail) continue;

            if (emailsMatch(request.currentStageAssigneeEmail, activeCfg.secondaryEmail)) continue;
            if (!request.currentStageToken) continue;

            const hoursStalled = Math.round(ageMs / 3_600_000);
            logger.info(
                `[Escalation] IBR #${request.id} stalled ${hoursStalled}h in ${request.status} ` +
                `(${request.location || 'global'}) — escalating from ${activeCfg.approverEmail} → ${activeCfg.secondaryEmail}`
            );

            if (!activeCfg.primaryExpiredAt) {
                await activeCfg.update({ primaryExpiredAt: new Date() });
            }

            await request.update({
                currentStageAssigneeEmail:    activeCfg.secondaryEmail,
                currentStageAssigneeUsername: activeCfg.secondaryUsername || null
            });

            const actionLink = stageCfg.slug
                ? `${process.env.APP_URL}/portal/${stageCfg.slug}/enter?action=${request.currentStageToken}`
                : `${process.env.APP_URL}/api/internet-browsing/handle?token=${request.currentStageToken}`;
            await emailService.sendInternetBrowsingNotification(
                activeCfg.secondaryEmail,
                request,
                actionLink,
                stageCfg.emailType
            );

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
            logger.error(`[Escalation] IBR error on request #${request.id}: ${err.message}`);
        }
    }

    logger.info(`[Escalation] Done (IBR) — checked ${checked}, escalated ${escalated}.`);
    return { checked, escalated };
}

// Default delegation timeout window. After this many hours of inactivity by
// the delegate, any remaining stage emails the delegate hasn't acted on
// auto-route back to the originalAssigneeEmail captured at delegation time.
// Per the plan: half the 48h primary-to-secondary window.
const DELEGATE_TIMEOUT_HOURS = parseInt(process.env.DELEGATE_TIMEOUT_HOURS || '24', 10);
const DELEGATE_TIMEOUT_MS    = DELEGATE_TIMEOUT_HOURS * 60 * 60 * 1000;

// In-flight pending statuses that participate in delegation revert. Mirrors
// DELEGATION_ROLE_TO_STATUS in adminController.js.
const DELEGATION_REVERT_STATUSES = ['PendingDCIManager', 'PendingITHOD', 'PendingDCIImplementation'];

async function runDelegationRevertCheck() {
    logger.info(`[DelegationRevert] Starting ${DELEGATE_TIMEOUT_HOURS}h check`);

    let checked = 0;
    let reverted = 0;

    const MODELS = [
        { model: OnboardingRequest,  kind: 'onboarding'  },
        { model: OffboardingRequest, kind: 'offboarding' }
    ];

    for (const { model, kind } of MODELS) {
        const rows = await model.findAll({
            where: {
                status:          { [Op.in]: DELEGATION_REVERT_STATUSES },
                delegationEvent: { [Op.ne]: null }
            }
        });

        for (const r of rows) {
            try {
                checked++;
                const ev = r.delegationEvent;
                if (!ev || !ev.delegatedAt || !ev.originalAssigneeEmail) continue;
                if (emailsMatch(r.currentStageAssigneeEmail, ev.originalAssigneeEmail)) {
                    // Already reverted (or never re-stamped); clear the snapshot.
                    await r.update({ delegationEvent: null });
                    continue;
                }
                const ageMs = Date.now() - new Date(ev.delegatedAt).getTime();
                if (ageMs < DELEGATE_TIMEOUT_MS) continue;
                if (!r.currentStageToken) {
                    // Stage closed between delegation and now — clear snapshot, nothing to do.
                    await r.update({ delegationEvent: null });
                    continue;
                }

                logger.info(`[DelegationRevert] ${kind} #${r.id} reverting: ${r.currentStageAssigneeEmail} → ${ev.originalAssigneeEmail}`);

                await r.update({
                    currentStageAssigneeEmail:    ev.originalAssigneeEmail,
                    currentStageAssigneeUsername: null,
                    delegationEvent:              null
                });

                // Re-emit the stage email to the original holder via the same
                // /api/<kind>/handle?token=… link the original email had.
                const actionLink = `${process.env.APP_URL}/api/${kind}/handle?token=${r.currentStageToken}`;
                try {
                    if (kind === 'offboarding') {
                        const type = r.status === 'PendingDCIManager' ? 'DCI_MANAGER_APPROVAL'
                                   : r.status === 'PendingDCIImplementation' ? 'DCI_IMPLEMENTER'
                                   : null;
                        if (type) await emailService.sendOffboardingNotification(ev.originalAssigneeEmail, r, actionLink, type);
                    } else {
                        const type = r.status === 'PendingDCIManager' ? 'DCI_MANAGER_APPROVAL'
                                   : r.status === 'PendingITHOD'      ? 'IT_HOD_APPROVAL'
                                   : null;
                        if (type) await emailService.sendOnboardingNotification(ev.originalAssigneeEmail, r, actionLink, type);
                    }
                } catch (mailErr) {
                    logger.warn(`[DelegationRevert] Email re-emit failed for ${kind} #${r.id}: ${mailErr.message}`);
                }

                await TimelineEvent.create({
                    requestId: r.id,
                    action:    'Delegation Reverted (Timeout)',
                    actorRole: 'System',
                    details:   `Delegate (${ev.delegatedToEmail || 'unknown'}) did not act within ` +
                               `${DELEGATE_TIMEOUT_HOURS}h. Stage automatically reverted to original ` +
                               `holder (${ev.originalAssigneeEmail}).`,
                    timestamp: new Date()
                });

                reverted++;
            } catch (err) {
                logger.error(`[DelegationRevert] Error on ${kind} #${r.id}: ${err.message}`);
            }
        }
    }

    logger.info(`[DelegationRevert] Done — checked ${checked}, reverted ${reverted}.`);
    return { checked, reverted };
}

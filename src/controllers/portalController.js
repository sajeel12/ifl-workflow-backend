import { Op } from 'sequelize';
import OnboardingRequest from '../models/OnboardingRequest.js';
import WorkflowApproverConfig from '../models/WorkflowApproverConfig.js';
import WorkflowApproverLocationOverride from '../models/WorkflowApproverLocationOverride.js';
import { issueToken, validateToken } from '../services/portalTokenService.js';
import { sendPortalAccessLink } from '../services/emailService.js';
import { emailsMatch } from '../utils/emailMatch.js';
import { groupLabel } from '../utils/locationGroups.js';
import logger from '../utils/logger.js';

// ── Role registry ──────────────────────────────────────────────────────────────

const ROLE_SLUGS = {
    'it-ops':          'IT_OPS',
    'dci-team':        'DCI_TEAM',
    'dci-implementer': 'DCI_IMPLEMENTER',
    'it-hod':          'IT_HOD',
    'dci-manager':     'DCI_MANAGER',
    'hr-initiator':    'HR_INITIATOR',
};

// pendingStatuses: statuses this role is responsible for acting on.
// historyField:    DB column set when this role finishes their step (null = not applicable).
// roleModel:       fallback | delegation | parallel
// isLocationAware: whether location scoping applies.
const ROLE_META = {
    IT_OPS: {
        label:          'IT Operations',
        pendingStatuses: ['PendingIT', 'PendingOPSAction'],
        historyField:   'itSubmittedAt',
        roleModel:      'fallback',
        isLocationAware: true,
    },
    DCI_TEAM: {
        label:          'DCI Team',
        pendingStatuses: ['PendingDCI'],
        historyField:   'dciSubmittedAt',
        roleModel:      'fallback',
        isLocationAware: false,
    },
    DCI_IMPLEMENTER: {
        label:          'DCI Implementer',
        pendingStatuses: ['PendingDCIImplementation'],
        historyField:   'dciImplementedAt',
        roleModel:      'fallback',
        isLocationAware: false,
    },
    IT_HOD: {
        label:          'IT Head of Department',
        pendingStatuses: ['PendingITHOD'],
        historyField:   'itHodDecidedAt',
        roleModel:      'delegation',
        isLocationAware: false,
    },
    DCI_MANAGER: {
        label:          'DCI Manager',
        pendingStatuses: ['PendingDCIManager'],
        historyField:   'dciManagerDecidedAt',
        roleModel:      'delegation',
        isLocationAware: false,
    },
    HR_INITIATOR: {
        label:          'HR Initiator',
        pendingStatuses: [], // HR sees all active requests (not stage-specific)
        historyField:   null,
        roleModel:      'parallel',
        isLocationAware: true,
    },
};

const LOCATION_AWARE = new Set(['IT_OPS', 'HR_INITIATOR']);
const TERMINAL_STATUSES = ['Completed', 'Rejected'];

// ── Access resolution ──────────────────────────────────────────────────────────

// Returns [{location, isPrimary}] — empty means no access.
// location = null means global (all locations). Override rows take precedence.
async function resolveAccess(email, roleKey) {
    const accesses = [];

    if (LOCATION_AWARE.has(roleKey)) {
        const overrides = await WorkflowApproverLocationOverride.findAll({
            where: { roleKey, isActive: true }
        });
        for (const ov of overrides) {
            if (emailsMatch(email, ov.approverEmail)) {
                accesses.push({ location: ov.location, isPrimary: true });
            } else if (emailsMatch(email, ov.secondaryEmail)) {
                accesses.push({ location: ov.location, isPrimary: false });
            }
        }
    }

    // If no override matched, fall through to global config.
    if (accesses.length === 0) {
        const globalCfg = await WorkflowApproverConfig.findOne({
            where: { roleKey, isActive: true }
        });
        if (globalCfg) {
            if (emailsMatch(email, globalCfg.approverEmail)) {
                accesses.push({ location: null, isPrimary: true });
            } else if (emailsMatch(email, globalCfg.secondaryEmail)) {
                accesses.push({ location: null, isPrimary: false });
            }
        }
    }

    return accesses;
}

// Build the Sequelize location WHERE clause from the accesses list.
function locationWhere(accesses) {
    if (accesses.some(a => a.location === null)) return {}; // global — no filter
    const locs = [...new Set(accesses.map(a => a.location))];
    return { location: { [Op.in]: locs } };
}

// ── Route handlers ─────────────────────────────────────────────────────────────

export function showLogin(req, res) {
    const roleSlug = req.params.roleSlug;
    const roleKey  = ROLE_SLUGS[roleSlug];
    if (!roleKey) return res.status(404).send('Unknown portal.');
    const meta = ROLE_META[roleKey];
    res.render('pages/portal_login', {
        roleSlug,
        roleName: meta.label,
        sent:     false,
        error:    null,
    });
}

export async function requestAccess(req, res) {
    const roleSlug = req.params.roleSlug;
    const roleKey  = ROLE_SLUGS[roleSlug];
    if (!roleKey) return res.status(404).send('Unknown portal.');
    const meta  = ROLE_META[roleKey];
    const email = (req.body.email || '').trim().toLowerCase();

    if (!email) {
        return res.render('pages/portal_login', {
            roleSlug, roleName: meta.label, sent: false,
            error: 'Please enter your email address.',
        });
    }

    try {
        const accesses = await resolveAccess(email, roleKey);

        if (accesses.length === 0) {
            logger.warn(`[Portal] Access denied — ${email} is not configured for ${roleKey}`);
            return res.render('pages/portal_login', {
                roleSlug, roleName: meta.label, sent: false,
                error: 'Your email is not authorised for this portal. Contact your administrator.',
            });
        }

        const token = issueToken({ roleKey, email, accesses, roleName: meta.label });
        const portalUrl = `${process.env.APP_URL}/portal/${roleSlug}/view?token=${token}`;

        await sendPortalAccessLink(email, meta.label, portalUrl);
        logger.info(`[Portal] Access link sent to ${email} for ${roleKey} (${accesses.length} location(s))`);

        return res.render('pages/portal_login', {
            roleSlug, roleName: meta.label, sent: true, error: null,
        });
    } catch (err) {
        logger.error(`[Portal] requestAccess error: ${err.message}`);
        return res.render('pages/portal_login', {
            roleSlug, roleName: meta.label, sent: false,
            error: 'Something went wrong. Please try again.',
        });
    }
}

export async function showDashboard(req, res) {
    const roleSlug = req.params.roleSlug;
    const roleKey  = ROLE_SLUGS[roleSlug];
    if (!roleKey) return res.status(404).send('Unknown portal.');

    const session = validateToken(req.query.token || '');
    if (!session || session.roleKey !== roleKey) {
        return res.redirect(`/portal/${roleSlug}?expired=1`);
    }

    const meta    = ROLE_META[roleKey];
    const { email, accesses, roleName } = session;
    const locWhere = locationWhere(accesses);

    try {
        let pendingRequests = [];
        let historyRequests = [];

        if (roleKey === 'HR_INITIATOR') {
            // HR sees all active (non-terminal) requests from their location(s).
            pendingRequests = await OnboardingRequest.findAll({
                where: {
                    ...locWhere,
                    status: { [Op.notIn]: [...TERMINAL_STATUSES, 'Draft'] },
                },
                order: [['hrSubmittedAt', 'ASC']],
            });
            historyRequests = await OnboardingRequest.findAll({
                where: {
                    ...locWhere,
                    status: { [Op.in]: TERMINAL_STATUSES },
                },
                order: [['updatedAt', 'DESC']],
                limit: 100,
            });
        } else {
            // For all other roles: pending = requests in their stage(s).
            pendingRequests = await OnboardingRequest.findAll({
                where: {
                    ...locWhere,
                    status: { [Op.in]: meta.pendingStatuses },
                },
                order: [['createdAt', 'ASC']],
            });

            // History = requests where the role's timestamp field is set
            // AND the request has moved past this role's stage.
            if (meta.historyField) {
                historyRequests = await OnboardingRequest.findAll({
                    where: {
                        ...locWhere,
                        [meta.historyField]: { [Op.ne]: null },
                        status: { [Op.notIn]: meta.pendingStatuses },
                    },
                    order: [['updatedAt', 'DESC']],
                    limit: 100,
                });
            }
        }

        // Annotate each pending request with whether this user can act on it.
        const pending = pendingRequests.map(r => ({
            ...r.toJSON(),
            canAct: emailsMatch(r.currentStageAssigneeEmail, email),
            actionUrl: r.currentStageToken
                ? `${process.env.APP_URL}/api/onboarding/handle?token=${r.currentStageToken}`
                : null,
        }));

        const history = historyRequests.map(r => ({
            ...r.toJSON(),
            historyUrl: `${process.env.APP_URL}/api/onboarding/history/${r.id}`,
        }));

        // Convert group keys (e.g. "HO_FSD") to display labels
        // (e.g. "HO / ISB / MUL / P10 / SIDHUPURA / KHI") for the view.
        const locationLabels = accesses.some(a => a.location === null)
            ? ['All Locations']
            : [...new Set(accesses.map(a => a.location))].map(k => groupLabel(k) || k);

        const isPrimary = accesses.some(a => a.isPrimary);

        res.render('pages/portal_dashboard', {
            roleSlug,
            roleKey,
            roleName,
            roleModel: meta.roleModel,
            userEmail: email,
            locationLabels,
            isPrimary,
            pending,
            history,
            pendingCount: pending.length,
            actionCount:  pending.filter(r => r.canAct).length,
            token: req.query.token,
            appUrl: process.env.APP_URL,
        });
    } catch (err) {
        logger.error(`[Portal] showDashboard error: ${err.message}`);
        res.status(500).send('Dashboard unavailable. Please try again later.');
    }
}

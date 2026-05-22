import { Op } from 'sequelize';
import OnboardingRequest from '../models/OnboardingRequest.js';
import WorkflowApproverConfig from '../models/WorkflowApproverConfig.js';
import WorkflowApproverLocationOverride from '../models/WorkflowApproverLocationOverride.js';
import { issueToken, validateToken } from '../services/portalTokenService.js';
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

const ROLE_META = {
    IT_OPS: {
        label:           'IT Operations',
        pendingStatuses: ['PendingIT', 'PendingOPSAction'],
        historyField:    'itSubmittedAt',
        roleModel:       'fallback',
        isLocationAware: true,
    },
    DCI_TEAM: {
        label:           'DCI Team',
        pendingStatuses: ['PendingDCI'],
        historyField:    'dciSubmittedAt',
        roleModel:       'fallback',
        isLocationAware: false,
    },
    DCI_IMPLEMENTER: {
        label:           'DCI Implementer',
        pendingStatuses: ['PendingDCIImplementation'],
        historyField:    'dciImplementedAt',
        roleModel:       'fallback',
        isLocationAware: false,
    },
    IT_HOD: {
        label:           'IT Head of Department',
        pendingStatuses: ['PendingITHOD'],
        historyField:    'itHodDecidedAt',
        roleModel:       'delegation',
        isLocationAware: false,
    },
    DCI_MANAGER: {
        label:           'DCI Manager',
        pendingStatuses: ['PendingDCIManager'],
        historyField:    'dciManagerDecidedAt',
        roleModel:       'delegation',
        isLocationAware: false,
    },
    HR_INITIATOR: {
        label:           'HR Initiator',
        pendingStatuses: [],
        historyField:    null,
        roleModel:       'parallel',
        isLocationAware: true,
    },
};

const LOCATION_AWARE   = new Set(['IT_OPS', 'HR_INITIATOR']);
const TERMINAL_STATUSES = ['Completed', 'Rejected'];

const STATUS_TO_SLUG = {
    PendingIT:                'it-ops',
    PendingDCI:               'dci-team',
    PendingDCIManager:        'dci-manager',
    PendingITHOD:             'it-hod',
    PendingDCIImplementation: 'dci-implementer',
    PendingOPSAction:         'it-ops',
};

// ── Identity helpers ───────────────────────────────────────────────────────────

// Strip "DOMAIN\" prefix from the IIS X-Auth-User header value.
function stripDomain(s) {
    if (!s) return '';
    const parts = String(s).split('\\');
    return (parts.length > 1 ? parts[1] : parts[0]).trim().toLowerCase();
}

// Does a config row's PRIMARY slot match this Windows username?
// Check order:
//   1. Explicit approverUsername field (new — set by admin UI going forward).
//   2. Email local part (backward compat for rows configured before username was added).
function rowMatchesPrimary(row, username) {
    if (row.approverUsername) return row.approverUsername.toLowerCase() === username;
    if (row.approverEmail)    return row.approverEmail.split('@')[0].toLowerCase() === username;
    return false;
}

function rowMatchesSecondary(row, username) {
    if (row.secondaryUsername) return row.secondaryUsername.toLowerCase() === username;
    if (row.secondaryEmail)    return row.secondaryEmail.split('@')[0].toLowerCase() === username;
    return false;
}

// ── Access resolution ──────────────────────────────────────────────────────────
//
// Returns { accesses: [{location, isPrimary}], email: string }
// accesses = [] means the user is not configured for this role.
// email is the stored approverEmail (used for canAct comparison with
// currentStageAssigneeEmail — kept for backward compat until that field
// is replaced with currentStageAssigneeUsername).
async function resolveAccess(username, roleKey) {
    const accesses = [];
    let email = '';

    if (LOCATION_AWARE.has(roleKey)) {
        const overrides = await WorkflowApproverLocationOverride.findAll({
            where: { roleKey, isActive: true }
        });
        for (const ov of overrides) {
            if (rowMatchesPrimary(ov, username)) {
                accesses.push({ location: ov.location, isPrimary: true });
                if (!email) email = ov.approverEmail || '';
            } else if (rowMatchesSecondary(ov, username)) {
                accesses.push({ location: ov.location, isPrimary: false });
                if (!email) email = ov.secondaryEmail || '';
            }
        }
    }

    if (accesses.length === 0) {
        const globalCfg = await WorkflowApproverConfig.findOne({
            where: { roleKey, isActive: true }
        });
        if (globalCfg) {
            if (rowMatchesPrimary(globalCfg, username)) {
                accesses.push({ location: null, isPrimary: true });
                email = globalCfg.approverEmail || '';
            } else if (rowMatchesSecondary(globalCfg, username)) {
                accesses.push({ location: null, isPrimary: false });
                email = globalCfg.secondaryEmail || '';
            }
        }
    }

    return { accesses, email };
}

// Build the Sequelize location WHERE clause from the accesses list.
function locationWhere(accesses) {
    if (accesses.some(a => a.location === null)) return {};
    const locs = [...new Set(accesses.map(a => a.location))];
    return { location: { [Op.in]: locs } };
}

// ── Route handlers ─────────────────────────────────────────────────────────────

// GET /portal/:roleSlug
// IIS has already authenticated the user via Windows Auth and injected X-Auth-User.
// We read that identity, check the approver config, and auto-redirect to the dashboard.
// No email entry form, no email link — Windows login name IS the identity.
export async function showLogin(req, res) {
    const roleSlug = req.params.roleSlug;
    const roleKey  = ROLE_SLUGS[roleSlug];
    if (!roleKey) return res.status(404).send('Unknown portal.');

    const rawHeader = req.headers['x-auth-user'] || '';
    const username  = stripDomain(rawHeader);

    if (!username) {
        return res.status(403).render('pages/message', {
            title:      'Intranet Access Required',
            heading:    'Intranet Access Required',
            titleClass: 'error',
            icon:       '🔒',
            iconClass:  'error-icon',
            message:    'This portal is only accessible from within the IFL intranet. Please open it from a domain-joined computer on the company network.',
        });
    }

    try {
        const { accesses, email } = await resolveAccess(username, roleKey);

        if (accesses.length === 0) {
            logger.warn(`[Portal] ${username} not configured for ${roleKey}`);
            return res.status(403).render('pages/message', {
                title:      'Portal Access Denied',
                heading:    'Not Authorised',
                titleClass: 'error',
                icon:       '⛔',
                iconClass:  'error-icon',
                message:    `Your Windows account "${username}" is not configured as an approver for the ${ROLE_META[roleKey].label} portal. Contact your administrator to be added.`,
            });
        }

        const meta  = ROLE_META[roleKey];
        const token = issueToken({ roleKey, username, email, accesses, roleName: meta.label });
        logger.info(`[Portal] Auto-login → ${username} for ${roleKey}`);
        return res.redirect(`/portal/${roleSlug}/view?token=${token}`);
    } catch (err) {
        logger.error(`[Portal] showLogin error: ${err.message}`);
        return res.status(500).render('pages/message', {
            title:   'Portal Error',
            heading: 'Something went wrong',
            message: 'Could not load the portal. Please try again.',
        });
    }
}

// GET /portal/:roleSlug/enter?action=TOKEN
// Entry point from an emailed action link.
// Action token proves the user received the email; we then verify their
// Windows identity is still a configured approver and issue a portal session.
// Never returns 401 — no popup loop risk.
export async function enterViaActionToken(req, res) {
    const roleSlug    = req.params.roleSlug;
    const roleKey     = ROLE_SLUGS[roleSlug];
    const actionToken = req.query.action;

    if (!roleKey || !actionToken) return res.redirect(`/portal/${roleSlug || ''}`);

    const rawHeader = req.headers['x-auth-user'] || '';
    const username  = stripDomain(rawHeader);

    try {
        const request = await OnboardingRequest.findOne({
            where: { currentStageToken: actionToken }
        });
        if (!request) return res.redirect(`/portal/${roleSlug}?expired=1`);

        // Auto-correct if the request has moved to a different stage.
        const expectedSlug = STATUS_TO_SLUG[request.status];
        if (expectedSlug && expectedSlug !== roleSlug) {
            return res.redirect(`/portal/${expectedSlug}/enter?action=${actionToken}`);
        }

        if (!username) {
            logger.warn(`[Portal] No Windows identity on ${roleSlug}/enter — redirecting to login`);
            return res.redirect(`/portal/${roleSlug}`);
        }

        const { accesses, email } = await resolveAccess(username, roleKey);
        if (accesses.length === 0) {
            logger.warn(`[Portal] ${username} not authorised for ${roleKey} (action-token path)`);
            return res.status(403).render('pages/message', {
                title:      'Portal Access Denied',
                heading:    'Not Authorised',
                titleClass: 'error',
                icon:       '⛔',
                iconClass:  'error-icon',
                message:    `Your Windows account "${username}" is not configured as an approver for the ${ROLE_META[roleKey].label} portal. Contact your administrator.`,
            });
        }

        const meta  = ROLE_META[roleKey];
        const token = issueToken({ roleKey, username, email, accesses, roleName: meta.label });
        logger.info(`[Portal] Enter via action token → ${username} for ${roleKey} (req #${request.id})`);
        return res.redirect(`/portal/${roleSlug}/view?token=${token}&expand=${request.id}`);
    } catch (err) {
        logger.error(`[Portal] enterViaActionToken error: ${err.message}`);
        return res.redirect(`/portal/${roleSlug}`);
    }
}

// GET /portal/:roleSlug/view?token=SESSION
export async function showDashboard(req, res) {
    const roleSlug = req.params.roleSlug;
    const roleKey  = ROLE_SLUGS[roleSlug];
    if (!roleKey) return res.status(404).send('Unknown portal.');

    const session = validateToken(req.query.token || '');
    if (!session || session.roleKey !== roleKey) {
        return res.redirect(`/portal/${roleSlug}?expired=1`);
    }

    const meta = ROLE_META[roleKey];
    const { username, email, accesses, roleName } = session;
    const locWhere = locationWhere(accesses);

    try {
        let pendingRequests = [];
        let historyRequests = [];

        if (roleKey === 'HR_INITIATOR') {
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
            pendingRequests = await OnboardingRequest.findAll({
                where: {
                    ...locWhere,
                    status: { [Op.in]: meta.pendingStatuses },
                },
                order: [['createdAt', 'ASC']],
            });

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

        const portalSessionToken = req.query.token || '';

        const pending = pendingRequests.map(r => ({
            ...r.toJSON(),
            // canAct: this request is assigned to this user.
            // Compared by email for now (currentStageAssigneeEmail is set by
            // recipientService which returns the stored approverEmail).
            canAct: email
                ? emailsMatch(r.currentStageAssigneeEmail, email)
                : r.currentStageAssigneeEmail?.split('@')[0]?.toLowerCase() === username,
            actionUrl: r.currentStageToken
                ? `${process.env.APP_URL}/api/onboarding/handle?token=${r.currentStageToken}&pt=${portalSessionToken}`
                : null,
        }));

        const history = historyRequests.map(r => ({
            ...r.toJSON(),
            historyUrl: `${process.env.APP_URL}/api/onboarding/history/${r.id}`,
        }));

        const locationLabels = accesses.some(a => a.location === null)
            ? ['All Locations']
            : [...new Set(accesses.map(a => a.location))].map(k => groupLabel(k) || k);

        const isPrimary = accesses.some(a => a.isPrimary);
        const expandId  = parseInt(req.query.expand, 10) || null;

        res.render('pages/portal_dashboard', {
            roleSlug,
            roleKey,
            roleName,
            roleModel:      meta.roleModel,
            userEmail:      email,
            locationLabels,
            isPrimary,
            pending,
            history,
            pendingCount:   pending.length,
            actionCount:    pending.filter(r => r.canAct).length,
            expandId,
            token:          req.query.token,
            appUrl:         process.env.APP_URL,
        });
    } catch (err) {
        logger.error(`[Portal] showDashboard error: ${err.message}`);
        res.status(500).send('Dashboard unavailable. Please try again later.');
    }
}

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
// Returns { accesses: [{location, isPrimary}], email: string, delegatorInfo }
// accesses = [] means the user is not configured for this role.
// email is the stored approverEmail (used for canAct comparison with
// currentStageAssigneeEmail — kept for backward compat until that field
// is replaced with currentStageAssigneeUsername).
//
// delegatorInfo is set when the user is the ORIGINAL holder of a delegation
// role that is currently temporarily covered by someone else. In that case
// accesses contains one entry with isOriginalDelegator: true, and the portal
// renders in read-only mode with an informational banner instead of a 403.
async function resolveAccess(username, roleKey) {
    const accesses = [];
    let email = '';
    let delegatorInfo = null;

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
            } else if (globalCfg.isDelegatedTemporarily) {
                // Third path: user is the original holder who temporarily delegated
                // the role to someone else. Let them in as read-only so they can see
                // the queue state without seeing a confusing 403.
                const prevUser  = globalCfg.previousApproverUsername?.toLowerCase();
                const prevLocal = globalCfg.previousApproverEmail?.split('@')[0].toLowerCase();
                const matchesPrev = prevUser ? prevUser === username : (prevLocal === username);
                if (matchesPrev) {
                    accesses.push({ location: null, isPrimary: false, isOriginalDelegator: true });
                    email = globalCfg.previousApproverEmail || '';
                    delegatorInfo = {
                        delegateName:  globalCfg.approverName  || globalCfg.approverEmail || '',
                        delegateEmail: globalCfg.approverEmail || '',
                    };
                }
            }
        }
    }

    return { accesses, email, delegatorInfo };
}

// Build the Sequelize location WHERE clause from the accesses list.
function locationWhere(accesses) {
    if (accesses.some(a => a.location === null)) return {};
    const locs = [...new Set(accesses.map(a => a.location))];
    return { location: { [Op.in]: locs } };
}

// ── Route handlers ─────────────────────────────────────────────────────────────

// GET /api/portal-auth/:roleSlug  (ssoMiddleware already ran — req.user is set)
// Called client-side via window.iflFetch so the sidecar token carries the identity.
// IIS URL Rewrite inbound rules run at BeginRequest, BEFORE Windows Authentication
// completes, so {LOGON_USER} / X-Auth-User is always empty on proxied requests.
// Using the sidecar token (fetched from token.aspx by client JS) is the correct
// approach — it's the same mechanism used by every other guarded route in this app.
export async function apiPortalAuth(req, res) {
    const roleSlug   = req.params.roleSlug;
    const roleKey    = ROLE_SLUGS[roleSlug];
    const actionToken = (req.query.action || '').trim();

    if (!roleKey) return res.status(404).json({ error: 'Unknown portal' });

    const username = (req.user?.username || '').toLowerCase();
    if (!username) return res.status(403).json({ error: 'No identity resolved from sidecar token' });

    try {
        let expandId   = null;
        let targetSlug = roleSlug;

        if (actionToken) {
            const request = await OnboardingRequest.findOne({ where: { currentStageToken: actionToken } });
            if (request) {
                expandId = request.id;
                const expectedSlug = STATUS_TO_SLUG[request.status];
                if (expectedSlug && expectedSlug !== roleSlug) {
                    // Request moved to a different stage — authenticate for the correct portal.
                    targetSlug = expectedSlug;
                    const correctKey = ROLE_SLUGS[targetSlug];
                    const { accesses: a2, email: e2 } = await resolveAccess(username, correctKey);
                    if (a2.length === 0) {
                        return res.status(403).json({ error: `Account "${username}" is not configured for the ${ROLE_META[correctKey]?.label || correctKey} portal.` });
                    }
                    const m2    = ROLE_META[correctKey];
                    const tok2  = issueToken({ roleKey: correctKey, username, email: e2, accesses: a2, roleName: m2.label });
                    logger.info(`[Portal] Sidecar auth (auto-corrected) → ${username} for ${correctKey} req#${expandId}`);
                    return res.json({ redirect: `/portal/${targetSlug}/view?token=${tok2}&expand=${expandId}` });
                }
            }
            // actionToken not found in DB — treat as expired (let dashboard redirect handle it)
        }

        const { accesses, email, delegatorInfo } = await resolveAccess(username, roleKey);
        if (accesses.length === 0) {
            logger.warn(`[Portal] ${username} not configured for ${roleKey} (sidecar path)`);
            return res.status(403).json({ error: `Account "${username}" is not configured for the ${ROLE_META[roleKey].label} portal. Contact your administrator.` });
        }

        const meta         = ROLE_META[roleKey];
        const tokenPayload = { roleKey, username, email, accesses, roleName: meta.label };
        if (delegatorInfo) {
            tokenPayload.isDelegator   = true;
            tokenPayload.delegateName  = delegatorInfo.delegateName;
            tokenPayload.delegateEmail = delegatorInfo.delegateEmail;
        }
        const token = issueToken(tokenPayload);
        logger.info(`[Portal] Sidecar auth${delegatorInfo ? ' (original delegator, read-only)' : ''} → ${username} for ${roleKey}${expandId ? ` req#${expandId}` : ''}`);
        const redirect = `/portal/${roleSlug}/view?token=${token}${expandId ? `&expand=${expandId}` : ''}`;
        return res.json({ redirect });

    } catch (err) {
        logger.error(`[Portal] apiPortalAuth error: ${err.message}`);
        return res.status(500).json({ error: 'Portal authentication failed. Please try again.' });
    }
}

// GET /portal/:roleSlug
// Renders a loading page that authenticates via sidecar token (client-side).
// X-Auth-User from IIS URL Rewrite is tried first as a fast path; if it is
// absent (always the case when URL Rewrite runs before auth completes), the
// loading page calls /api/portal-auth/:roleSlug via window.iflFetch instead.
export async function showLogin(req, res) {
    const roleSlug = req.params.roleSlug;
    const roleKey  = ROLE_SLUGS[roleSlug];
    if (!roleKey) return res.status(404).send('Unknown portal.');

    // Fast path: X-Auth-User present (would require IIS to set it post-auth).
    const username = stripDomain(req.headers['x-auth-user'] || '');
    if (username) {
        try {
            const { accesses, email, delegatorInfo } = await resolveAccess(username, roleKey);
            if (accesses.length > 0) {
                const meta         = ROLE_META[roleKey];
                const tokenPayload = { roleKey, username, email, accesses, roleName: meta.label };
                if (delegatorInfo) {
                    tokenPayload.isDelegator   = true;
                    tokenPayload.delegateName  = delegatorInfo.delegateName;
                    tokenPayload.delegateEmail = delegatorInfo.delegateEmail;
                }
                const token = issueToken(tokenPayload);
                logger.info(`[Portal] Auto-login (X-Auth-User)${delegatorInfo ? ' (original delegator, read-only)' : ''} → ${username} for ${roleKey}`);
                return res.redirect(`/portal/${roleSlug}/view?token=${token}`);
            }
        } catch (_) { /* fall through to sidecar path */ }
    }

    // Sidecar path: render loading page; client JS calls /api/portal-auth/:roleSlug.
    const meta = ROLE_META[roleKey];
    return res.render('pages/portal_loading', {
        roleSlug,
        roleName: meta.label,
        authUrl:  `/api/portal-auth/${roleSlug}`,
    });
}

// GET /portal/:roleSlug/enter?action=TOKEN
// Entry point from an emailed action link.
// Validates the action token, auto-corrects the stage slug if needed, then
// renders the same loading page as showLogin so client JS can authenticate
// via sidecar token. The action token is passed to /api/portal-auth so the
// dashboard opens with the relevant request expanded.
export async function enterViaActionToken(req, res) {
    const roleSlug    = req.params.roleSlug;
    const roleKey     = ROLE_SLUGS[roleSlug];
    const actionToken = (req.query.action || '').trim();

    if (!roleKey || !actionToken) return res.redirect(`/portal/${roleSlug || ''}`);

    try {
        const request = await OnboardingRequest.findOne({ where: { currentStageToken: actionToken } });
        if (!request) return res.redirect(`/portal/${roleSlug}?expired=1`);

        // Auto-correct slug if the request has moved to a different stage.
        const expectedSlug = STATUS_TO_SLUG[request.status];
        if (expectedSlug && expectedSlug !== roleSlug) {
            return res.redirect(`/portal/${expectedSlug}/enter?action=${actionToken}`);
        }

        // Fast path: X-Auth-User present.
        const username = stripDomain(req.headers['x-auth-user'] || '');
        if (username) {
            try {
                const { accesses, email, delegatorInfo } = await resolveAccess(username, roleKey);
                if (accesses.length > 0) {
                    const meta         = ROLE_META[roleKey];
                    const tokenPayload = { roleKey, username, email, accesses, roleName: meta.label };
                    if (delegatorInfo) {
                        tokenPayload.isDelegator   = true;
                        tokenPayload.delegateName  = delegatorInfo.delegateName;
                        tokenPayload.delegateEmail = delegatorInfo.delegateEmail;
                    }
                    const token = issueToken(tokenPayload);
                    logger.info(`[Portal] Enter via action token (X-Auth-User)${delegatorInfo ? ' (original delegator, read-only)' : ''} → ${username} for ${roleKey} req#${request.id}`);
                    return res.redirect(`/portal/${roleSlug}/view?token=${token}&expand=${request.id}`);
                }
            } catch (_) { /* fall through to sidecar path */ }
        }

        // Sidecar path: render loading page; client JS calls /api/portal-auth with action token.
        const meta = ROLE_META[roleKey];
        return res.render('pages/portal_loading', {
            roleSlug,
            roleName: meta.label,
            authUrl:  `/api/portal-auth/${roleSlug}?action=${encodeURIComponent(actionToken)}`,
        });

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
    const { username, email, accesses, roleName,
            isDelegator   = false,
            delegateName  = '',
            delegateEmail = '' } = session;
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
            // canAct: this request is assigned to this user AND they are not the
            // original delegator viewing in read-only mode.
            canAct: isDelegator ? false : (
                email
                    ? emailsMatch(r.currentStageAssigneeEmail, email)
                    : r.currentStageAssigneeEmail?.split('@')[0]?.toLowerCase() === username
            ),
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
            isDelegator,
            delegateName,
            delegateEmail,
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

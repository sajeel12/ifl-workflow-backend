import { Op } from 'sequelize';
import OnboardingRequest from '../models/OnboardingRequest.js';
import OffboardingRequest from '../models/OffboardingRequest.js';
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
    'it-ops-mgr':      'IT_OPS_MGR',
};

const ROLE_META = {
    IT_OPS: {
        label:           'IT Operations',
        description:     'Configure workstation, email account, network access, printers and file shares for new joiners.',
        accentColor:     '#0078D4',
        pendingStatuses: ['PendingIT', 'PendingOPSAction'],
        historyField:    'itSubmittedAt',
        roleModel:       'fallback',
        isLocationAware: true,
    },
    DCI_TEAM: {
        label:           'DCI Team',
        description:     'Gather and submit the DCI requirements needed for the new employee\'s system setup.',
        accentColor:     '#D97706',
        pendingStatuses: ['PendingDCI'],
        historyField:    'dciSubmittedAt',
        roleModel:       'fallback',
        isLocationAware: false,
    },
    DCI_IMPLEMENTER: {
        label:           'DCI Implementer',
        description:     'Implement DCI configurations and services once requirements are approved.',
        accentColor:     '#7C3AED',
        pendingStatuses: ['PendingDCIImplementation'],
        historyField:    'dciImplementedAt',
        roleModel:       'fallback',
        isLocationAware: false,
    },
    IT_HOD: {
        label:           'IT Head of Department',
        description:     'Authorise email and communication services for senior-grade new joiners.',
        accentColor:     '#059669',
        pendingStatuses: ['PendingITHOD'],
        historyField:    'itHodDecidedAt',
        roleModel:       'delegation',
        isLocationAware: false,
    },
    DCI_MANAGER: {
        label:           'DCI Manager',
        description:     'Review and approve DCI team submissions before implementation begins.',
        accentColor:     '#0891B2',
        pendingStatuses: ['PendingDCIManager'],
        historyField:    'dciManagerDecidedAt',
        roleModel:       'delegation',
        isLocationAware: false,
    },
    HR_INITIATOR: {
        label:           'HR Initiator',
        description:     'Initiate onboarding requests for incoming employees and track their progress.',
        accentColor:     '#16A34A',
        pendingStatuses: [],
        historyField:    null,
        roleModel:       'parallel',
        isLocationAware: true,
    },
    IT_OPS_MGR: {
        label:           'IT Operations Manager',
        description:     'Monitor IT Operations workload across all locations and manage escalations.',
        accentColor:     '#64748B',
        pendingStatuses: [],   // sees IT_OPS statuses directly — not its own pending queue
        historyField:    null,
        roleModel:       'delegation',
        isLocationAware: false,
    },
};

const LOCATION_AWARE   = new Set(['IT_OPS', 'HR_INITIATOR']);
const TERMINAL_STATUSES = ['Completed', 'Rejected', 'AdminDeleted'];

const STATUS_TO_SLUG = {
    PendingIT:                'it-ops',
    PendingDCI:               'dci-team',
    PendingDCIManager:        'dci-manager',
    PendingITHOD:             'it-hod',
    PendingDCIImplementation: 'dci-implementer',
    PendingOPSAction:         'it-ops',
};

// Offboarding has its own (smaller) status → portal-slug map. DCI Manager
// + DCI Implementer are the only emailed stages; the initiation step is
// triggered from the standalone /api/offboarding/initiate form, not email.
const OFFBOARDING_STATUS_TO_SLUG = {
    PendingDCIManager:        'dci-manager',
    PendingDCIImplementation: 'dci-implementer',
};

// Look up an action token across BOTH onboarding and offboarding stage-token
// columns. Email links carry the same kind of token, but the request itself
// could live in either table. Returns { kind: 'onboarding'|'offboarding', request }
// or null if no match. Onboarding is checked first because that's the high-
// volume table.
async function findRequestByActionToken(actionToken) {
    if (!actionToken) return null;
    const on = await OnboardingRequest.findOne({ where: { currentStageToken: actionToken } });
    if (on) return { kind: 'onboarding', request: on };
    const off = await OffboardingRequest.findOne({ where: { currentStageToken: actionToken } });
    if (off) return { kind: 'offboarding', request: off };
    return null;
}

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
        let expandKind = null;      // 'onboarding' | 'offboarding' | null
        let targetSlug = roleSlug;

        if (actionToken) {
            const found = await findRequestByActionToken(actionToken);
            if (found) {
                const { kind, request } = found;
                expandId   = request.id;
                expandKind = kind;
                const statusMap = kind === 'offboarding' ? OFFBOARDING_STATUS_TO_SLUG : STATUS_TO_SLUG;
                const expectedSlug = statusMap[request.status];
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
                    logger.info(`[Portal] Sidecar auth (auto-corrected) → ${username} for ${correctKey} ${expandKind} req#${expandId}`);
                    const qs = `&expand=${expandId}` + (expandKind === 'offboarding' ? '&expandKind=offboarding' : '');
                    return res.json({ redirect: `/portal/${targetSlug}/view?token=${tok2}${qs}` });
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
        logger.info(`[Portal] Sidecar auth${delegatorInfo ? ' (original delegator, read-only)' : ''} → ${username} for ${roleKey}${expandId ? ` ${expandKind} req#${expandId}` : ''}`);
        const expandQs = expandId
            ? (`&expand=${expandId}` + (expandKind === 'offboarding' ? '&expandKind=offboarding' : ''))
            : '';
        const redirect = `/portal/${roleSlug}/view?token=${token}${expandQs}`;
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
        const found = await findRequestByActionToken(actionToken);
        if (!found) return res.redirect(`/portal/${roleSlug}?expired=1`);
        const { kind, request } = found;

        // Auto-correct slug if the request has moved to a different stage.
        const statusMap   = kind === 'offboarding' ? OFFBOARDING_STATUS_TO_SLUG : STATUS_TO_SLUG;
        const expectedSlug = statusMap[request.status];
        if (expectedSlug && expectedSlug !== roleSlug) {
            return res.redirect(`/portal/${expectedSlug}/enter?action=${actionToken}`);
        }

        // Build the expand-query suffix once — offboarding cards live in a
        // separate id namespace, so we pass kind alongside the id so the
        // dashboard knows which tab to open and which DOM id to target.
        const expandQs = `&expand=${request.id}` + (kind === 'offboarding' ? '&expandKind=offboarding' : '');

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
                    logger.info(`[Portal] Enter via action token (X-Auth-User)${delegatorInfo ? ' (original delegator, read-only)' : ''} → ${username} for ${roleKey} ${kind} req#${request.id}`);
                    return res.redirect(`/portal/${roleSlug}/view?token=${token}${expandQs}`);
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

        // ── IT Ops Manager: monitoring view across all locations ───────────────
        if (roleKey === 'IT_OPS_MGR') {
            const STAGE_START = { PendingIT: 'hrSubmittedAt', PendingOPSAction: 'dciImplementedAt' };

            const [locationConfigs, globalITOPS, allPending, allRequests] = await Promise.all([
                WorkflowApproverLocationOverride.findAll({
                    where: { roleKey: 'IT_OPS' },
                    order: [['location', 'ASC']],
                }),
                WorkflowApproverConfig.findOne({ where: { roleKey: 'IT_OPS', isActive: true } }),
                OnboardingRequest.findAll({
                    where: { status: { [Op.in]: ['PendingIT', 'PendingOPSAction'] } },
                    order: [['createdAt', 'ASC']],
                }),
                OnboardingRequest.findAll({
                    where: { status: { [Op.in]: ['PendingIT', 'PendingOPSAction', 'Completed'] } },
                    order: [['createdAt', 'DESC']],
                }),
            ]);

            const enrichedRequests = allPending.map(r => {
                const json       = r.toJSON();
                const locCfg     = locationConfigs.find(c => c.location === r.location) || globalITOPS;
                const startField = STAGE_START[r.status] || 'updatedAt';
                const stageAgeHours = Math.round(
                    (Date.now() - new Date(json[startField] || json.updatedAt)) / 3600000
                );
                return {
                    ...json,
                    stageAgeHours,
                    isStale:       stageAgeHours > 48,
                    isEscalated:   !!(locCfg?.primaryExpiredAt),
                    primaryName:   locCfg?.approverName   || locCfg?.approverEmail   || 'Unassigned',
                    secondaryName: locCfg?.secondaryName  || locCfg?.secondaryEmail  || '—',
                };
            });

            const locationSummary = locationConfigs.map(cfg => ({
                location:      cfg.location,
                primaryName:   cfg.approverName   || cfg.approverEmail   || 'Unassigned',
                primaryEmail:  cfg.approverEmail  || '',
                secondaryName: cfg.secondaryName  || cfg.secondaryEmail  || '—',
                secondaryEmail:cfg.secondaryEmail || '',
                isEscalated:   !!(cfg.primaryExpiredAt),
                activeCount:   allPending.filter(r => r.location === cfg.location).length,
            }));

            return res.render('pages/portal_it_ops_mgr', {
                roleSlug,
                roleKey,
                roleName,
                userEmail:      email,
                isDelegator,
                delegateName,
                delegateEmail,
                locationSummary,
                pendingRequests: enrichedRequests,
                pendingCount:    enrichedRequests.length,
                allRequests:     allRequests.map(r => r.toJSON()),
                totalCount:      allRequests.length,
                token:           req.query.token,
                appUrl:          process.env.APP_URL || '',
            });
        }

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

        const isPrimary  = accesses.some(a => a.isPrimary);
        const expandId   = parseInt(req.query.expand, 10) || null;
        // 'offboarding' switches the dashboard to the offboarding tab and
        // looks for an "off-req-<id>" card; anything else (including missing)
        // is treated as onboarding for back-compat.
        const expandKind = ((req.query.expandKind || '').toString().toLowerCase() === 'offboarding')
            ? 'offboarding' : 'onboarding';

        // Discover every OTHER portal this user's account is configured for.
        // Both tables are tiny (<20 rows each) so two findAll calls are cheap.
        const [allGlobalCfgs, allLocationCfgs] = await Promise.all([
            WorkflowApproverConfig.findAll({ where: { isActive: true } }),
            WorkflowApproverLocationOverride.findAll({ where: { isActive: true } }),
        ]);
        const myOtherPortals = [];
        for (const [slug, key] of Object.entries(ROLE_SLUGS)) {
            if (key === roleKey) continue;
            const m = ROLE_META[key];
            if (!m) continue;
            const matchesAny =
                allGlobalCfgs.some(c  => c.roleKey === key && (rowMatchesPrimary(c, username) || rowMatchesSecondary(c, username))) ||
                allLocationCfgs.some(c => c.roleKey === key && (rowMatchesPrimary(c, username) || rowMatchesSecondary(c, username)));
            if (matchesAny) {
                myOtherPortals.push({ label: m.label, slug, accentColor: m.accentColor });
            }
        }

        res.render('pages/portal_dashboard', {
            roleSlug,
            roleKey,
            roleName,
            roleDescription:  meta.description || '',
            roleAccentColor:  meta.accentColor  || '#0078D4',
            roleModel:        meta.roleModel,
            userEmail:        email,
            locationLabels,
            isPrimary,
            isDelegator,
            delegateName,
            delegateEmail,
            pending,
            history,
            pendingCount:     pending.length,
            actionCount:      pending.filter(r => r.canAct).length,
            myOtherPortals,
            expandId,
            expandKind,
            token:            req.query.token,
            appUrl:           process.env.APP_URL,
        });
    } catch (err) {
        logger.error(`[Portal] showDashboard error: ${err.message}`);
        res.status(500).send('Dashboard unavailable. Please try again later.');
    }
}

import * as ibrService from '../services/internetBrowsingService.js';
import InternetBrowsingRequest from '../models/InternetBrowsingRequest.js';
import TimelineEvent from '../models/TimelineEvent.js';
import HRMSService from '../services/hrmsService.js';
import { emailsMatch } from '../utils/emailMatch.js';
import { LOCATION_GROUPS, groupLabel } from '../utils/locationGroups.js';
import { humanizeAction, humanizeDetails, humanizeDetailsHTML, narrate } from '../utils/historyFormatter.js';
import logger from '../utils/logger.js';

const LOCATION_GROUP_LABELS = Object.fromEntries(LOCATION_GROUPS.map(g => [g.key, g.label]));

// Map an IBR role to the sidebar/portal slug + label that the success screen
// uses to render the "Return to <role> Portal" button and the 10-second auto-
// redirect countdown. Mirrors OFF_ROLE_TO_PORTAL in offboardingController.
// HOD is intentionally absent — HODs never have a portal session.
const IBR_ROLE_TO_PORTAL = {
    ITOps:              { key: 'IT_OPS',              label: 'IT Operations' },
    FMS:                { key: 'NETWORK_VALIDATOR',   label: 'Network Validator (FMS)' },
    ITOpsMgr:           { key: 'IT_OPS_MGR',          label: 'IT Operations Manager' },
    ITHOD:              { key: 'IT_HOD',              label: 'IT HOD' },
    NetworkImplementer: { key: 'NETWORK_IMPLEMENTER', label: 'Network Implementer' }
};

const renderSuccess = (res, title, message, next = {}) => {
    const view = {
        title: 'Success',
        heading: title,
        message,
        titleClass: 'success',
        icon: '✅',
        iconClass: 'success-icon',
        requestRef: next.requestId,
        nextStatus: next.statusLabel,
        nextOwner:  next.statusOwner,
        nextStatusColor: next.statusColor
    };
    const portal = next.actorRole && IBR_ROLE_TO_PORTAL[next.actorRole];
    if (portal) {
        view.roleKey   = portal.key;
        view.roleLabel = portal.label;
        view.showPortal = false;
    }
    if (next.portalToken) view.portalToken = next.portalToken;
    return res.render('pages/message', view);
};
const renderError = (res, message, status = 400) => {
    return res.status(status).render('pages/message', {
        title: 'Error',
        heading: 'Error',
        titleClass: 'error',
        icon: '❌',
        iconClass: 'error-icon',
        message
    });
};

export const handleRequest = async (req, res) => {
    const { token } = req.query;
    try {
        if (req.method === 'GET') {
            return await renderForm(req, res, token);
        } else if (req.method === 'POST') {
            return await handleSubmission(req, res, token);
        }
    } catch (err) {
        logger.error(`[IBR] Error: ${err.message}`);
        return renderError(res, err.message, 500);
    }
};

// Resolve the requesting employee + snapshot the auto-collected fields
// from HRMS + the SSO identity. Returns a `data` object ready to hand to
// ibrService.createRequest, or null + an error message if the lookup fails.
const collectInitiatorSnapshot = async (req) => {
    if (!req.user || !req.user.email) {
        return { error: 'Sign-in required to initiate an Internet Browsing request. Please open this page from the IFL portal.', status: 401 };
    }
    // Match by email first, then pivot on the Employee Number (the AD email
    // often differs from the HRMS email; the employee number is the shared key).
    const empRow = await ibrService.resolveInitiatorEmployee(req.user);
    if (!empRow) {
        return {
            error: `Your SSO identity (${req.user.email}) could not be matched to an employee record by email or AD employee number. Please contact HR before requesting internet access.`,
            status: 403
        };
    }
    // IT-Ops validation is routed by the AD-derived LOCATION GROUP — NOT the
    // HRMS location. Resolve the user's AD office and map it to a group; if it
    // can't be mapped, block the request (we never fall back to HRMS location).
    const { adOffice, group, adEmail, adTelephoneNumber, adMobile } = await ibrService.resolveLocationGroupForEmployee(empRow, req.user);
    if (!group) {
        return {
            error: `Your office${adOffice ? ` "${adOffice}"` : ''} is not mapped to a location group, so we can't route your request to the right IT Operations team. Please contact IT to configure your office in the location-group mapping.`,
            status: 422
        };
    }
    // Preview which IT-Ops location group / validator the request will route to,
    // so the form can show it (transparency + routing verification in testing).
    const validator = await ibrService.getItOpsValidatorForGroup(group, empRow.employeeId);

    let hodEmail = '';
    let hodName  = empRow.managerName || '';
    try {
        const mgr = await HRMSService.getManager(empRow.employeeId);
        if (mgr) {
            hodEmail = mgr.email || '';
            hodName  = mgr.name || hodName;
        }
    } catch (_) { /* fall through with empty HOD email */ }

    return {
        snapshot: {
            employeeId:    empRow.employeeId,
            fullName:      empRow.name || req.user.displayName,
            joiningDate:   empRow.joiningDate || null,
            department:    empRow.mainDept || empRow.orgElementName || null,
            designation:   empRow.designation || null,
            // `location` here is the DISPLAY value shown on the form (the real AD
            // office). `locationGroup` is the routing key consumed by createRequest;
            // `adOffice` is persisted for audit.
            location:      adOffice || null,
            locationGroup: group,
            locationGroupLabel: groupLabel(group),
            adOffice:      adOffice || null,
            // Which IT-Ops location/validator this request forwards to (display).
            itOpsValidatorName:  (validator && validator.name)  || '',
            itOpsValidatorEmail: (validator && validator.email) || '',
            // The requester's AD login (sAMAccountName) — auto-captured at
            // initiation. The rights selection (User Type / Facility Duration /
            // Browsing Rights) is filled later by the IT-Ops validator, not here.
            ntLogin:       req.user.username || req.user.displayName || '',
            extension:     adTelephoneNumber || null,
            contactNumber: adMobile || null,
            hod:           hodName,
            hodEmail:      hodEmail,
            email:         adEmail || req.user.email
        }
    };
};

// Statuses that count as an in-flight IBR for the "already has an active
// request" guard. Shared by the form render and the snapshot endpoint.
const IBR_ACTIVE_STATUSES = ['Draft', 'PendingITOpsValidation', 'PendingHOD', 'PendingFMS',
                             'PendingITOpsMgr', 'PendingITHOD', 'PendingImplementation'];

const findActiveIBR = (employeeId) =>
    InternetBrowsingRequest.findOne({ where: { employeeId, status: IBR_ACTIVE_STATUSES } });

/**
 * GET /api/internet-browsing/my-snapshot  (ssoMiddleware required)
 * Returns the signed-in employee's auto-collected snapshot + any active request.
 * The initiate form (rendered open at Node) calls this via window.iflFetch — which
 * attaches the sidecar token — to hydrate its read-only fields after page load.
 */
export const getMySnapshot = async (req, res) => {
    try {
        if (!req.user || !req.user.email) {
            return res.status(401).json({ error: 'Sign-in required. Please open this page from the IFL portal.' });
        }
        const r = await collectInitiatorSnapshot(req);
        if (r.error) return res.status(r.status || 400).json({ error: r.error });
        const existing = await findActiveIBR(r.snapshot.employeeId);
        return res.json({
            snapshot: r.snapshot,
            existing: existing ? { id: existing.id, status: existing.status } : null
        });
    } catch (err) {
        logger.error(`[IBR] getMySnapshot: ${err.message}`);
        return res.status(500).json({ error: err.message });
    }
};

const handleSubmission = async (req, res, token) => {
    const data = req.body;

    try {
        if (!token) {
            // ─── Stage 1: employee self-initiation ────────────────────
            const { snapshot, error, status } = await collectInitiatorSnapshot(req);
            if (error) return renderError(res, error, status || 400);

            const payload = {
                ...snapshot,
                // ntLogin comes from snapshot (req.user.username via AD) — the
                // read-only display field carries no name attr so data.ntLogin
                // would be empty. Never override the server-derived value here.
                requirementDetails: data.requirementDetails,
                userType:           data.userType,
                facilityDuration:   data.facilityDuration,
                browsingRights:     data.browsingRights
            };
            const created = await ibrService.createRequest(payload, req.user);
            return renderSuccess(
                res,
                'Internet Browsing Request Submitted',
                'Your request has been forwarded to the Location Ops / IT Ops team for validation. You will receive an email once your request progresses to the next stage.',
                {
                    requestId:   created && created.id,
                    statusLabel: 'Pending IT Ops Validation',
                    statusOwner: 'IT Operations',
                    statusColor: 'warning',
                    // Employees don't have a portal; show no "Return to Portal" button.
                    actorRole:   null,
                    portalToken: data.pt || req.query.pt || null
                }
            );
        }

        // ─── Token-bearing actions (stages 2–7) ───────────────────────
        const context = await ibrService.getFormContext(token);
        if (!context) return renderError(res, 'Invalid or Expired Token');
        const { role, request } = context;

        // Forwarded-email guard.
        if (request.currentStageAssigneeEmail) {
            const actual = (req.user && req.user.email) || '';
            if (!actual) {
                return renderError(res, `This action can only be submitted by ${request.currentStageAssigneeEmail}. Please open the link from the IFL portal.`, 401);
            }
            if (!emailsMatch(actual, request.currentStageAssigneeEmail)) {
                try {
                    await TimelineEvent.create({
                        requestId: request.id,
                        action:    'Unauthorized Submit (IBR)',
                        actorRole: 'System',
                        details:   `Expected ${request.currentStageAssigneeEmail}, got ${req.user.email}`,
                        timestamp: new Date()
                    });
                } catch (_) {}
                return renderError(
                    res,
                    `This action link was sent to ${request.currentStageAssigneeEmail}. You are signed in as ${req.user.email}, so you cannot submit this request.`,
                    403
                );
            }
        }

        const portalToken = data.pt || req.query.pt || null;
        const remarks = data.remarks || data.managerRemarks || '';

        if (role === 'ITOps') {
            // The IT-Ops validator sets the rights selection at this stage.
            const updated = await ibrService.handleITOpsValidation(token, data.action || 'Approve', remarks, {
                ntLogin:              data.ntLogin,
                userType:             data.userType,
                facilityDuration:     data.facilityDuration,
                facilityDurationDays: data.facilityDurationDays,
                browsingRights:       data.browsingRights,
                specificSites:        data.specificSites
            });
            if (data.action === 'Reject') {
                return renderSuccess(res, 'Request Rejected', 'The Internet Browsing request has been rejected and closed.', {
                    requestId: updated.id, statusLabel: 'Rejected', statusOwner: '—', statusColor: 'danger',
                    actorRole: 'ITOps', portalToken
                });
            }
            return renderSuccess(res, 'Approved — Forwarded to HOD',
                'The request has been forwarded to the employee\'s HOD for approval.',
                {
                    requestId: updated.id, statusLabel: 'Pending HOD Approval', statusOwner: 'HOD', statusColor: 'warning',
                    actorRole: 'ITOps', portalToken
                });
        }

        if (role === 'HOD') {
            const updated = await ibrService.handleHODApproval(token, data.action || 'Approve', remarks);
            if (data.action === 'Reject') {
                return renderSuccess(res, 'Request Rejected', 'The Internet Browsing request has been rejected and closed.', {
                    requestId: updated.id, statusLabel: 'Rejected', statusOwner: '—', statusColor: 'danger',
                    portalToken
                });
            }
            return renderSuccess(res, 'Approved — Forwarded to FMS',
                'The request has been forwarded to the FMS (Network Validator) team.',
                {
                    requestId: updated.id, statusLabel: 'Pending FMS Validation', statusOwner: 'Network Validator', statusColor: 'warning',
                    portalToken
                });
        }

        if (role === 'FMS') {
            const updated = await ibrService.handleFMSValidation(token, data.action || 'Approve', remarks);
            if (data.action === 'Reject') {
                return renderSuccess(res, 'Request Rejected', 'The Internet Browsing request has been rejected and closed.', {
                    requestId: updated.id, statusLabel: 'Rejected', statusOwner: '—', statusColor: 'danger',
                    actorRole: 'FMS', portalToken
                });
            }
            return renderSuccess(res, 'Approved — Forwarded to RN',
                'The request has been forwarded to the IT Operations Manager (RN).',
                {
                    requestId: updated.id, statusLabel: 'Pending RN Approval', statusOwner: 'IT Operations Manager', statusColor: 'warning',
                    actorRole: 'FMS', portalToken
                });
        }

        if (role === 'ITOpsMgr') {
            const updated = await ibrService.handleITOpsMgrApproval(token, data.action || 'Approve', remarks);
            if (data.action === 'Reject') {
                return renderSuccess(res, 'Request Rejected', 'The Internet Browsing request has been rejected and closed.', {
                    requestId: updated.id, statusLabel: 'Rejected', statusOwner: '—', statusColor: 'danger',
                    actorRole: 'ITOpsMgr', portalToken
                });
            }
            return renderSuccess(res, 'Approved — Forwarded to IT HOD',
                'The request has been forwarded to the IT HOD (UZ) for final approval.',
                {
                    requestId: updated.id, statusLabel: 'Pending IT HOD Approval', statusOwner: 'IT HOD', statusColor: 'warning',
                    actorRole: 'ITOpsMgr', portalToken
                });
        }

        if (role === 'ITHOD') {
            const updated = await ibrService.handleITHODApproval(token, data.action || 'Approve', remarks);
            if (data.action === 'Reject') {
                return renderSuccess(res, 'Request Rejected', 'The Internet Browsing request has been rejected and closed.', {
                    requestId: updated.id, statusLabel: 'Rejected', statusOwner: '—', statusColor: 'danger',
                    actorRole: 'ITHOD', portalToken
                });
            }
            return renderSuccess(res, 'Approved — Forwarded to Network Implementer',
                'The request has been forwarded to the Network Implementer to apply the change.',
                {
                    requestId: updated.id, statusLabel: 'Pending Implementation', statusOwner: 'Network Implementer', statusColor: 'warning',
                    actorRole: 'ITHOD', portalToken
                });
        }

        if (role === 'NetworkImplementer') {
            data.confirmed = data.confirmed === 'on' || data.confirmed === 'true' || data.confirmed === true;
            const implementerName = (req.user && (req.user.displayName || req.user.username)) || 'Network Implementer';
            const proofPaths = Array.isArray(req.files) ? req.files.map(f => f.path) : [];
            const updated = await ibrService.handleImplementerCompletion(token, data, implementerName, proofPaths);
            return renderSuccess(
                res,
                'Internet Browsing Request Completed',
                'The change has been applied and recorded. The employee, their HOD and IT HOD have been notified.',
                {
                    requestId: updated.id, statusLabel: 'Completed', statusOwner: '—', statusColor: 'success',
                    actorRole: 'NetworkImplementer', portalToken
                }
            );
        }

        return renderError(res, 'Action not permitted at this stage.');
    } catch (err) {
        logger.error(`[IBR] Submission error: ${err.message}`);
        return renderError(res, err.message, 500);
    }
};

const renderForm = async (req, res, token) => {
    // No token + initiate URL → employee self-initiation form.
    if (!token && req.originalUrl.includes('/initiate')) {
        // GET stays OPEN at Node (no ssoMiddleware) — a fresh browser navigation
        // carries no sidecar token, so gating it would 401 / trigger the IIS
        // Windows-auth loop (same rule as onboarding's GET /initiate). We render
        // the form shell; if the SSO identity already happens to be present
        // (e.g. MOCK mode) we pre-fill server-side, otherwise the page hydrates
        // its auto-collected fields client-side from /internet-browsing/my-snapshot.
        let snapshot = {};
        let existing = null;
        if (req.user && req.user.email) {
            const r = await collectInitiatorSnapshot(req);
            if (!r.error) {
                snapshot = r.snapshot;
                existing = await findActiveIBR(snapshot.employeeId);
            }
            // On error (identity not matchable) fall through to the empty shell;
            // the client /my-snapshot call surfaces the same message.
        }
        return res.render('pages/internet_browsing_initiate', {
            snapshot,
            existing,
            currentUser: req.user || null
        });
    }

    let request = {};
    let role    = 'ReadOnly';

    if (token) {
        const context = await ibrService.getFormContext(token);
        if (!context) return renderError(res, 'Invalid or Expired Token');
        request = context.request;
        role    = context.role;

        // Server-side Access Denied — mirrors offboardingController.
        if (req.user && req.user.email && request.currentStageAssigneeEmail
            && !emailsMatch(req.user.email, request.currentStageAssigneeEmail)) {
            try {
                await TimelineEvent.create({
                    requestId: request.id,
                    action:    'Unauthorized Click (IBR)',
                    actorRole: 'System',
                    details:   `Expected ${request.currentStageAssigneeEmail}, got ${req.user.email}`,
                    timestamp: new Date()
                });
            } catch (_) {}
            const roleLabel = ({
                ITOps:              'IT Operations',
                HOD:                'HOD',
                FMS:                'Network Validator (FMS)',
                ITOpsMgr:           'IT Operations (RN Approval)',
                ITHOD:              'IT HOD',
                NetworkImplementer: 'Network Implementer'
            })[role] || 'this stage';
            const acctName  = (req.user.username || req.user.email || 'this user');
            return res.status(403).render('pages/message', {
                title: 'Access Denied',
                heading: 'Access Denied',
                titleClass: 'error',
                icon: '⛔',
                iconClass: 'error-icon',
                message: `Account "${acctName}" is not configured as the ${roleLabel} for this Internet Browsing request.`
            });
        }
    }

    // Stepper — 7 stages.
    const steps = [
        { id: 'init',        label: 'Employee Initiates' },
        { id: 'it-ops',      label: 'IT Ops Validation' },
        { id: 'hod',         label: 'HOD Approval' },
        { id: 'fms',         label: 'FMS Validation' },
        { id: 'rn',          label: 'RN Approval' },
        { id: 'uz',          label: 'UZ Approval' },
        { id: 'implementer', label: 'Implementation' },
        { id: 'complete',    label: 'Completed' }
    ];
    let cur = 0;
    if (request.status === 'PendingITOpsValidation') cur = 1;
    else if (request.status === 'PendingHOD')        cur = 2;
    else if (request.status === 'PendingFMS')        cur = 3;
    else if (request.status === 'PendingITOpsMgr')   cur = 4;
    else if (request.status === 'PendingITHOD')      cur = 5;
    else if (request.status === 'PendingImplementation') cur = 6;
    else if (request.status === 'Completed' || request.status === 'Rejected') cur = 7;
    steps.forEach((step, i) => {
        if (i < cur)      step.status = 'completed';
        else if (i === cur) step.status = 'active';
        else                step.status = 'pending';
    });

    let timeline = [];
    if (request && request.id) {
        try {
            const events = await TimelineEvent.findAll({
                where: { requestId: request.id },
                order: [['timestamp', 'ASC']],
                attributes: ['id', 'action', 'actorRole', 'details', 'timestamp']
            });
            timeline = events.map(e => {
                const ev = e.toJSON();
                ev.actionLabel = humanizeAction(ev.action);
                ev.detailsText = humanizeDetails(ev.details);
                return ev;
            });
        } catch (_) {}
    }

    return res.render('pages/internet_browsing_status', {
        request,
        steps,
        role,
        token,
        timeline,
        locationGroupLabels: LOCATION_GROUP_LABELS,
        currentUser: req.user || null,
        expectedAssigneeEmail: (token && request.currentStageAssigneeEmail) || null
    });
};

export const initiate = async (req, res) => handleRequest(req, res);

// ─── Portal queue ─────────────────────────────────────────────────────
// Returns pending or history rows scoped to the calling role's queue.
// Roles understood: IT_OPS, NETWORK_VALIDATOR, IT_HOD, NETWORK_IMPLEMENTER.
// IT_OPS owns BOTH the stage-2 validation queue and the stage-5 RN approval
// queue (same team handles the request twice) — so its status filter is an
// array. Sequelize treats `status: [...]` as an IN clause.
const STATUS_FOR_ROLE = {
    IT_OPS:              ['PendingITOpsValidation', 'PendingITOpsMgr'],
    NETWORK_VALIDATOR:   'PendingFMS',
    IT_HOD:              'PendingITHOD',
    NETWORK_IMPLEMENTER: 'PendingImplementation'
};
const HISTORY_ACTOR_ROLES = {
    // ITOps actor role is logged for both stage-2 validation and stage-5 RN
    // approval (the latter still tags 'ITOpsMgr' on its timeline events).
    IT_OPS:              ['ITOps', 'ITOpsMgr'],
    NETWORK_VALIDATOR:   ['FMS'],
    IT_HOD:              ['ITHOD'],
    NETWORK_IMPLEMENTER: ['NetworkImplementer']
};

export const getRoleQueue = async (req, res) => {
    try {
        const role = (req.query.role || '').toUpperCase();
        const type = (req.query.type || 'pending').toLowerCase();
        if (!role || !STATUS_FOR_ROLE[role]) {
            return res.status(400).json({ success: false, error: 'Unknown role' });
        }

        if (type === 'pending') {
            const rows = await InternetBrowsingRequest.findAll({
                where: { status: STATUS_FOR_ROLE[role] },
                order: [['updatedAt', 'DESC']]
            });
            const data = rows.map(r => ({
                rowId:       'ibr-' + r.id,
                isEvent:     false,
                requestId:   r.id,
                fullName:    r.fullName,
                employeeId:  r.employeeId,
                department:  r.department,
                designation: r.designation,
                lastUpdated: r.updatedAt,
                actionable:  true,
                url:         `/api/internet-browsing/handle?token=${encodeURIComponent(r.currentStageToken || '')}`,
                requestType: 'internet-browsing'
            }));
            return res.json({ success: true, data });
        }

        const actorRoles = HISTORY_ACTOR_ROLES[role] || [];
        if (!actorRoles.length) return res.json({ success: true, data: [] });

        const ibrIds = (await InternetBrowsingRequest.findAll({ attributes: ['id'] })).map(r => r.id);
        const events = await TimelineEvent.findAll({
            where: { actorRole: actorRoles, requestId: ibrIds },
            order: [['timestamp', 'DESC']],
            limit: 200
        });

        const requestById = Object.fromEntries((await InternetBrowsingRequest.findAll({
            attributes: ['id', 'fullName', 'employeeId', 'department', 'designation']
        })).map(r => [r.id, r]));

        const data = events.map(ev => {
            const r = requestById[ev.requestId] || {};
            return {
                rowId:           'ibr-ev-' + ev.id,
                isEvent:         true,
                eventId:         ev.id,
                requestId:       ev.requestId,
                actorRole:       ev.actorRole,
                action:          ev.action,
                actionLabel:     ev.action,
                actionTone:      /reject/i.test(ev.action) ? 'danger'
                              : /approve|complete/i.test(ev.action) ? 'success'
                              : 'info',
                actionDetailHTML: ev.details ? '<pre style="white-space:pre-wrap;margin:0;">' + String(ev.details).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])) + '</pre>' : '',
                timestamp:       ev.timestamp,
                fullName:        r.fullName,
                employeeId:      r.employeeId,
                department:      r.department,
                designation:     r.designation,
                requestType:     'internet-browsing'
            };
        });
        return res.json({ success: true, data });
    } catch (err) {
        logger.error(`[IBR queue] ${err.message}`);
        return res.status(500).json({ success: false, error: err.message });
    }
};

const STATUS_LABEL = {
    Draft:                 'Draft',
    PendingITOpsValidation:'In Process (IT Ops Validation)',
    PendingHOD:            'In Process (HOD Approval)',
    PendingFMS:            'In Process (FMS Validation)',
    PendingITOpsMgr:       'In Process (RN Approval)',
    PendingITHOD:          'In Process (UZ Approval)',
    PendingImplementation: 'In Process (Implementation)',
    Completed:             'Approved',
    Rejected:              'Rejected'
};

export const renderHistory = async (req, res) => {
    try {
        const { id } = req.params;
        const request = await InternetBrowsingRequest.findByPk(id);
        if (!request) {
            return res.status(404).render('pages/message', {
                title: 'Not Found', heading: 'Internet Browsing request not found',
                titleClass: 'error', icon: '⛔', iconClass: 'error-icon',
                message: `No Internet Browsing request with id #${id}.`
            });
        }

        const events = await TimelineEvent.findAll({
            where: { requestId: id },
            order: [['timestamp', 'ASC']],
            attributes: ['eventId', 'action', 'actorRole', 'details', 'timestamp']
        });
        const timeline = events.map(e => {
            const ev = e.toJSON();
            ev.actionLabel = humanizeAction(ev.action);
            ev.detailsText = humanizeDetails(ev.details);
            ev.detailsHTML = humanizeDetailsHTML(ev.details);
            ev.summary     = narrate(ev);
            return ev;
        });

        const currentRecipient = {
            role:  STATUS_LABEL[request.status] || '—',
            name:  '',
            email: request.currentStageAssigneeEmail || ''
        };

        return res.render('pages/internet_browsing_status', {
            title: `Internet Browsing - ${request.fullName || request.employeeId}`,
            request,
            steps: [],
            role: 'ReadOnly',
            token: null,
            timeline,
            currentRecipient,
            statusLabel: STATUS_LABEL[request.status] || request.status,
            locationGroupLabels: LOCATION_GROUP_LABELS,
            currentUser: req.user || null,
            expectedAssigneeEmail: null
        });
    } catch (err) {
        logger.error(`[IBR History] ${err.message}`);
        return res.status(500).render('pages/message', {
            title: 'Error', heading: 'Error', titleClass: 'error',
            icon: '❌', iconClass: 'error-icon',
            message: err.message
        });
    }
};

// Multipart proof upload — mirrors onboarding/upload-proof, the actual
// persistence happens in handleImplementerCompletion via req.files.
export const uploadProof = async (req, res) => {
    try {
        const paths = (req.files || []).map(f => f.path);
        return res.json({ success: true, files: paths });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
};

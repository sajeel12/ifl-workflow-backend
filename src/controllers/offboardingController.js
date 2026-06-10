import * as offboardingService from '../services/offboardingService.js';
import OffboardingRequest from '../models/OffboardingRequest.js';
import OnboardingRequest from '../models/OnboardingRequest.js';
import WorkflowApproverConfig from '../models/WorkflowApproverConfig.js';
import WorkflowApproverLocationOverride from '../models/WorkflowApproverLocationOverride.js';
import TimelineEvent from '../models/TimelineEvent.js';
import { emailsMatch } from '../utils/emailMatch.js';
import { LOCATION_GROUPS, groupByKey, groupKeyForLocation } from '../utils/locationGroups.js';
import { humanizeAction, humanizeDetails, humanizeDetailsHTML, narrate } from '../utils/historyFormatter.js';
import { resolveEmployeeAdProfile } from './employeeJourneyController.js';
import Employee from '../models/Employee.js';
import * as pdfService from '../services/pdfService.js';
import path from 'path';
import logger from '../utils/logger.js';

const LOCATION_GROUP_LABELS = Object.fromEntries(LOCATION_GROUPS.map(g => [g.key, g.label]));

// ───────────────────────────────────────────────────────────────────────
// Initiator gating — HR or IT Ops only.
// Mirrors the HR-only logic on the onboarding side but accepts EITHER role,
// per the new offboarding requirement (Israr email 1).
// ───────────────────────────────────────────────────────────────────────
async function resolveInitiatorGroupForEmail(email, roleKey) {
    if (!email) return null;
    const overrides = await WorkflowApproverLocationOverride.findAll({
        where: { roleKey, isActive: true }
    });
    for (const o of overrides) {
        if (emailsMatch(email, o.approverEmail) || emailsMatch(email, o.secondaryEmail)) {
            return o.location;
        }
    }
    const globalCfg = await WorkflowApproverConfig.findOne({
        where: { roleKey, isActive: true }
    });
    if (globalCfg && (emailsMatch(email, globalCfg.approverEmail) || emailsMatch(email, globalCfg.secondaryEmail))) {
        return '__GLOBAL__';
    }
    return null;
}

// Map a form role (initiator / approver) to the sidebar/portal slug + label
// that the success screen uses to render the "Return to <role> Portal" button
// and the 10-second auto-redirect countdown. Mirrors the onboarding pattern in
// onboardingController.js (FORM_ROLE_TO_PORTAL).
const OFF_ROLE_TO_PORTAL = {
    HR:             { key: 'HR_INITIATOR',    label: 'HR' },
    IT:             { key: 'IT_OPS',          label: 'IT Operations' },
    DCIManager:     { key: 'DCI_MANAGER',     label: 'DCI Manager' },
    DCIImplementer: { key: 'DCI_IMPLEMENTER', label: 'DCI Implementer' }
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
    const portal = next.actorRole && OFF_ROLE_TO_PORTAL[next.actorRole];
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

// Build the offboarding revocation Work Order PDF for the DCI Implementer and
// store its path on the request. Pulls AD (live, via the sidecar resolver), the
// granted-services snapshot (matched completed onboarding record), and Employee
// DB details. Best-effort: a failure here is logged but must NOT block the
// approval workflow — the implementer form degrades to "PDF unavailable".
async function generateOffboardingRevocationPdf(request) {
    try {
        const adResult  = await resolveEmployeeAdProfile(request.employeeId).catch(() => null);
        const adProfile = adResult && adResult.found ? adResult.profile : null;

        const privileges = await OnboardingRequest.findOne({
            where: { employeeId: request.employeeId, status: 'Completed' },
            order: [['opsCompletedAt', 'DESC']]
        }).catch(() => null);

        const employee = await Employee.findOne({
            where: { employeeId: request.employeeId }
        }).catch(() => null);

        const filename   = `Offboarding_${request.employeeId}_${request.id}.pdf`;
        const outputPath = path.resolve('generated_pdfs', filename);
        await pdfService.generateOffboardingRevocationPDF({ request, adProfile, privileges, employee }, outputPath);
        await request.update({ revocationPdfPath: outputPath });
        logger.info(`[Offboarding] Revocation PDF generated: ${outputPath}`);
    } catch (err) {
        logger.error(`[Offboarding] Revocation PDF generation failed: ${err.message}`);
    }
}

// Serve the revocation Work Order PDF for the DCI Implementer — validated via
// the live stage token. Mirrors onboarding's serveWorkOrderPDF.
export const serveRevocationPDF = async (req, res) => {
    try {
        const token = req.params.token || req.query.token;
        if (!token) return res.status(400).send('Token required');
        const request = await OffboardingRequest.findOne({ where: { currentStageToken: token } });
        if (!request || request.status !== 'PendingDCIImplementation') {
            return res.status(404).send('PDF not available or token invalid.');
        }
        if (!request.revocationPdfPath) {
            return res.status(404).send('Revocation PDF not yet generated for this request.');
        }
        const { createReadStream, existsSync } = await import('fs');
        if (!existsSync(request.revocationPdfPath)) {
            return res.status(404).send('PDF file not found on server.');
        }
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="OffboardingRevocation_${request.id}.pdf"`);
        createReadStream(request.revocationPdfPath).pipe(res);
    } catch (err) {
        logger.error(`[Offboarding PDF Serve] ${err.message}`);
        res.status(500).send('Error serving PDF.');
    }
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
        logger.error(`[Offboarding] Error: ${err.message}`);
        return renderError(res, err.message, 500);
    }
};

const handleSubmission = async (req, res, token) => {
    const data = req.body;

    // Normalize checkboxes — implementer form sends 'on' for checked.
    ['adRevoked', 'smartXRevoked', 'doorAccessRevoked'].forEach(f => {
        data[f] = data[f] === 'on' || data[f] === 'true';
    });

    try {
        if (!token) {
            // ─── Initiate (HR or IT Ops) ──────────────────────────────
            if (!req.user || !req.user.email) {
                return renderError(
                    res,
                    'Sign-in required to initiate an offboarding request. Please open this page from the IFL portal.',
                    401
                );
            }

            const hrGroup    = await resolveInitiatorGroupForEmail(req.user.email, 'HR_INITIATOR');
            const itOpsGroup = await resolveInitiatorGroupForEmail(req.user.email, 'IT_OPS');
            if (!hrGroup && !itOpsGroup) {
                return res.status(403).render('pages/message', {
                    title: 'Not authorized',
                    heading: 'Only authorized HR or IT Operations users can initiate offboarding',
                    titleClass: 'error',
                    icon: '⛔',
                    iconClass: 'error-icon',
                    message: `You are signed in as ${req.user.email}, but you are not on the HR Initiator or IT Operations list. Please contact the workflow administrator.`
                });
            }

            // Derive location group from the initiator's group when available;
            // otherwise accept a user-supplied location (group-scoped initiators
            // always override).
            const initiatorGroup = (hrGroup && hrGroup !== '__GLOBAL__') ? hrGroup
                                : (itOpsGroup && itOpsGroup !== '__GLOBAL__') ? itOpsGroup
                                : groupKeyForLocation(data.location);
            if (initiatorGroup) data.location = initiatorGroup;

            const created = await offboardingService.createRequest(data, req.user);
            // Pick the initiator's role for the success-screen portal button.
            // HR takes precedence if both lists match (typical case is exactly one).
            const initiatorActorRole = hrGroup ? 'HR' : (itOpsGroup ? 'IT' : null);
            return renderSuccess(
                res,
                'Offboarding Initiated',
                'Request created. The DCI Manager has been notified and will review the privileges to revoke.',
                {
                    requestId:    created && created.id,
                    statusLabel:  'Pending DCI Manager Approval',
                    statusOwner:  'DCI Manager',
                    statusColor:  'warning',
                    actorRole:    initiatorActorRole,
                    portalToken:  data.pt || req.query.pt || null
                }
            );
        }

        // ─── Token-bearing actions (DCI Manager / DCI Implementer) ────
        const context = await offboardingService.getFormContext(token);
        if (!context) return renderError(res, 'Invalid or Expired Token');
        const { role, request } = context;

        // Forwarded-email guard — local-part match against the assignee email
        // we stamped at the previous stage. Mirrors onboardingController.
        if (request.currentStageAssigneeEmail) {
            const actual = (req.user && req.user.email) || '';
            if (!actual) {
                return renderError(res, `This action can only be submitted by ${request.currentStageAssigneeEmail}. Please open the link from the IFL portal.`, 401);
            }
            if (!emailsMatch(actual, request.currentStageAssigneeEmail)) {
                try {
                    await TimelineEvent.create({
                        requestId: request.id,
                        action: 'Unauthorized Submit (Offboarding)',
                        actorRole: 'System',
                        details: `Expected ${request.currentStageAssigneeEmail}, got ${req.user.email}`,
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

        // Portal token (from the email-link or the form's hidden field) used by
        // the success screen's "Return to Portal" button so the destination page
        // can re-validate the session without bouncing through SSO again.
        const portalToken = data.pt || req.query.pt || null;

        if (role === 'DCIManager') {
            const { action, managerRemarks } = data;
            const updated = await offboardingService.handleManagerApproval(token, action || 'Approve', managerRemarks);
            if (action === 'Reject') {
                return renderSuccess(res, 'Offboarding Rejected', 'The offboarding request has been rejected and closed.', {
                    requestId: updated.id, statusLabel: 'Rejected', statusOwner: '—', statusColor: 'danger',
                    actorRole: 'DCIManager', portalToken
                });
            }
            // Approved → build the revocation Work Order PDF (AD + DB + onboarding
            // privileges) for the DCI Implementer to download and act on.
            await generateOffboardingRevocationPdf(updated);
            return renderSuccess(
                res,
                'Approved — Forwarded to DCI Implementer',
                'AD/SmartX/Door-access revocation has been routed to the DCI Implementer team.',
                {
                    requestId: updated.id, statusLabel: 'Pending DCI Implementation', statusOwner: 'DCI Implementer', statusColor: 'warning',
                    actorRole: 'DCIManager', portalToken
                }
            );
        }

        if (role === 'DCIImplementer') {
            const implementerName = (req.user && (req.user.displayName || req.user.username)) || 'DCI Implementer';
            const proofPaths = Array.isArray(req.files) ? req.files.map(f => f.path) : [];
            // Proof is mandatory at this stage — the implementer must attach at
            // least one screenshot evidencing the AD/account revocation.
            if (!proofPaths.length) {
                return renderError(res, 'At least one proof screenshot is required to complete the offboarding. Please attach the revocation evidence and try again.');
            }
            const updated = await offboardingService.handleImplementerCompletion(token, data, implementerName, proofPaths);
            return renderSuccess(
                res,
                'Offboarding Completed',
                'AD account deleted; SmartX and door-access revocations recorded. The employee\'s HOD and IT HOD have been notified.',
                {
                    requestId: updated.id, statusLabel: 'Completed', statusOwner: '—', statusColor: 'success',
                    actorRole: 'DCIImplementer', portalToken
                }
            );
        }

        return renderError(res, 'Action not permitted at this stage.');
    } catch (err) {
        logger.error(`[Offboarding] Submission error: ${err.message}`);
        return renderError(res, err.message, 500);
    }
};

const renderForm = async (req, res, token) => {
    // No token + initiate URL → standalone HR/IT-Ops initiation form.
    if (!token && req.originalUrl.includes('/initiate')) {
        return res.render('pages/offboarding_initiate', {
            locationGroups: LOCATION_GROUPS,
            currentUser:    req.user || null
        });
    }

    let request   = {};
    let role      = 'ReadOnly';
    let privileges = null;     // populated when role === 'DCIManager'

    if (token) {
        const context = await offboardingService.getFormContext(token);
        if (!context) return renderError(res, 'Invalid or Expired Token');
        request = context.request;
        role    = context.role;

        // ─── Server-side Access Denied (matches the onboarding portal UX) ─
        // When req.user IS present (portal-first flow, or IIS proxy header
        // populated the user), reject up-front if they're not the assignee
        // for this stage — show a clear "not configured for…" page rather
        // than loading the form and blocking submit. Mirrors the
        // forwarded-email guard at POST.
        //
        // If req.user is ABSENT (fresh email-link click before SSO hydrates),
        // we do NOT 401 — that loops through IIS Windows auth. The page's
        // client-side cloak handles that case.
        if (req.user && req.user.email && request.currentStageAssigneeEmail
            && !emailsMatch(req.user.email, request.currentStageAssigneeEmail)) {
            try {
                await TimelineEvent.create({
                    requestId: request.id,
                    action:    'Unauthorized Click (Offboarding)',
                    actorRole: 'System',
                    details:   `Expected ${request.currentStageAssigneeEmail}, got ${req.user.email}`,
                    timestamp: new Date()
                });
            } catch (_) {}
            const roleLabel = role === 'DCIManager' ? 'DCI Manager'
                            : role === 'DCIImplementer' ? 'DCI Implementer'
                            : 'this stage';
            const acctName  = (req.user.username || req.user.email || 'this user');
            return res.status(403).render('pages/message', {
                title: 'Access Denied',
                heading: 'Access Denied',
                titleClass: 'error',
                icon: '⛔',
                iconClass: 'error-icon',
                message: `Account "${acctName}" is not configured as the ${roleLabel} for this offboarding request. Contact your administrator.`
            });
        }

        // Privileges summary: read the most recent Completed OnboardingRequest
        // for the same employee. Surfaced to the DCI Manager at approval time
        // so "approve" = explicit acknowledgement of what will be revoked.
        if (role === 'DCIManager' && request.employeeId) {
            try {
                privileges = await OnboardingRequest.findOne({
                    where: { employeeId: request.employeeId, status: 'Completed' },
                    order: [['opsCompletedAt', 'DESC']]
                });
            } catch (e) {
                logger.warn(`[Offboarding] Could not load privileges for ${request.employeeId}: ${e.message}`);
            }
        }
    }

    // Stepper — 4 stages.
    const steps = [
        { id: 'init',        label: 'HR / IT Ops Initiation' },
        { id: 'manager',     label: 'DCI Manager Approval' },
        { id: 'implementer', label: 'AD + Access Revocation' },
        { id: 'complete',    label: 'Completed' }
    ];
    let currentStateIndex = 0;
    if (request.status === 'PendingDCIManager')          currentStateIndex = 1;
    else if (request.status === 'PendingDCIImplementation') currentStateIndex = 2;
    else if (request.status === 'Completed')             currentStateIndex = 4;
    else if (request.status === 'Rejected')              currentStateIndex = 4;
    steps.forEach((step, i) => {
        if (i < currentStateIndex)      step.status = 'completed';
        else if (i === currentStateIndex) step.status = 'active';
        else                              step.status = 'pending';
    });

    // Queue sidebar removed per Israr (6 Jun 2026) — the queue lives on
    // /portal/dci-manager only. The form is a clean form. No portal_shell
    // locals are needed here anymore.

    return res.render('pages/offboarding_status', {
        request,
        steps,
        role,
        token,
        privileges,
        locationGroupLabels: LOCATION_GROUP_LABELS,
        currentUser: req.user || null,
        // Used by the client-side cloak in offboarding_status.ejs to verify
        // the SSO user matches the assignee before lifting the page. If null
        // (no token / no assignee), the cloak lifts immediately.
        expectedAssigneeEmail: (token && request.currentStageAssigneeEmail) || null
    });
};

export const initiate = async (req, res) => handleRequest(req, res);

// ─── Legacy admin-panel endpoints (renamed status filters) ──────────
export const getPendingManager = async (req, res) => {
    try {
        const requests = await OffboardingRequest.findAll({
            where: { status: 'PendingDCIManager' },
            order: [['initiatedAt', 'DESC']]
        });
        res.json({ success: true, data: requests });
    } catch (error) {
        logger.error(`[Offboarding API] ${error.message}`);
        res.status(500).json({ success: false, error: 'Server error' });
    }
};
export const getPendingSystem = async (req, res) => {
    try {
        const requests = await OffboardingRequest.findAll({
            where: { status: 'PendingDCIImplementation' },
            order: [['managerApprovedAt', 'DESC']]
        });
        res.json({ success: true, data: requests });
    } catch (error) {
        logger.error(`[Offboarding API] ${error.message}`);
        res.status(500).json({ success: false, error: 'Server error' });
    }
};
export const getAll = async (req, res) => {
    try {
        const requests = await OffboardingRequest.findAll({ order: [['createdAt', 'DESC']] });
        res.json({ success: true, data: requests });
    } catch (error) {
        logger.error(`[Offboarding API] ${error.message}`);
        res.status(500).json({ success: false, error: 'Server error' });
    }
};

// ─── Portal queue (mirror of onboarding /queue) ─────────────────────
// Returns pending or history rows scoped to the calling role's queue.
// Role keys understood: DCI_MANAGER, DCI_IMPLEMENTER.
const STATUS_FOR_ROLE = {
    DCI_MANAGER:     'PendingDCIManager',
    DCI_IMPLEMENTER: 'PendingDCIImplementation'
};
const HISTORY_ACTOR_ROLES = {
    DCI_MANAGER:     ['DCIManager'],
    DCI_IMPLEMENTER: ['DCIImplementer']
};

export const getRoleQueue = async (req, res) => {
    try {
        const role = (req.query.role || '').toUpperCase();
        const type = (req.query.type || 'pending').toLowerCase();
        if (!role || !STATUS_FOR_ROLE[role]) {
            return res.status(400).json({ success: false, error: 'Unknown role' });
        }

        if (type === 'pending') {
            const rows = await OffboardingRequest.findAll({
                where: { status: STATUS_FOR_ROLE[role] },
                order: [['updatedAt', 'DESC']]
            });
            const data = rows.map(r => ({
                rowId:         'off-' + r.id,
                isEvent:       false,
                requestId:     r.id,
                fullName:      r.fullName,
                employeeId:    r.employeeId,
                department:    r.department,
                designation:   r.designation,
                lastUpdated:   r.updatedAt,
                actionable:    true,
                url:           `/api/offboarding/handle?token=${encodeURIComponent(r.currentStageToken || '')}`,
                requestType:   'offboarding'
            }));
            return res.json({ success: true, data });
        }

        // History — TimelineEvents performed by this role on offboarding requests.
        const actorRoles = HISTORY_ACTOR_ROLES[role] || [];
        if (!actorRoles.length) return res.json({ success: true, data: [] });

        const offboardingIds = (await OffboardingRequest.findAll({ attributes: ['id'] })).map(r => r.id);
        const events = await TimelineEvent.findAll({
            where: { actorRole: actorRoles, requestId: offboardingIds },
            order: [['timestamp', 'DESC']],
            limit: 200
        });

        const requestById = Object.fromEntries((await OffboardingRequest.findAll({
            attributes: ['id', 'fullName', 'employeeId', 'department', 'designation']
        })).map(r => [r.id, r]));

        const data = events.map(ev => {
            const r = requestById[ev.requestId] || {};
            return {
                rowId:         'off-ev-' + ev.id,
                isEvent:       true,
                eventId:       ev.id,
                requestId:     ev.requestId,
                actorRole:     ev.actorRole,
                action:        ev.action,
                actionLabel:   ev.action,
                actionTone:    /reject/i.test(ev.action) ? 'danger'
                             : /approve|complete/i.test(ev.action) ? 'success'
                             : 'info',
                actionDetailHTML: ev.details ? '<pre style="white-space:pre-wrap;margin:0;">' + String(ev.details).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])) + '</pre>' : '',
                timestamp:     ev.timestamp,
                fullName:      r.fullName,
                employeeId:    r.employeeId,
                department:    r.department,
                designation:   r.designation,
                requestType:   'offboarding'
            };
        });
        return res.json({ success: true, data });
    } catch (err) {
        logger.error(`[Offboarding queue] ${err.message}`);
        return res.status(500).json({ success: false, error: err.message });
    }
};

// Suppress unused-import warning for groupByKey; it is intentionally available
// for future use (e.g. resolving a group from a freeform location string).
void groupByKey;

// ───────────────────────────────────────────────────────────────────────
// Live AD account snapshot for the employee on an offboarding request.
// The DCI Manager confirmation / DCI Implementer checklist already show the
// DB privilege snapshot (from the matched onboarding record); this adds the
// ACTUAL Active Directory account + groups that deletion will remove, fetched
// via the sidecar (adsearch.aspx) — the same resolver the 360° profile uses.
// Scoped by request id so it can't be used to look up arbitrary employees.
// GET /api/offboarding/:id/ad-profile  → { found, profile }
// ───────────────────────────────────────────────────────────────────────
export const getEmployeeAdProfile = async (req, res) => {
    try {
        const request = await OffboardingRequest.findByPk(req.params.id, {
            attributes: ['employeeId']
        });
        if (!request || !request.employeeId) {
            return res.json({ found: false, profile: null });
        }
        const result = await resolveEmployeeAdProfile(request.employeeId);
        return res.json(result);
    } catch (err) {
        logger.error(`[Offboarding] AD profile fetch failed: ${err.message}`);
        return res.status(500).json({ error: 'Failed to fetch AD profile' });
    }
};

// ───────────────────────────────────────────────────────────────────────
// Quick existence-check used by the initiate form's "Get Employee Data" flow.
// Returns { state: 'active' | 'completed' | null } for the given employeeId
// so the form can warn the user before they try to submit a duplicate.
// GET /api/offboarding/lookup?employeeId=...
// ───────────────────────────────────────────────────────────────────────
export const lookupExistingRequest = async (req, res) => {
    try {
        const employeeId = (req.query.employeeId || '').trim();
        if (!employeeId) return res.json({ state: null });

        const active = await OffboardingRequest.findOne({
            where: { employeeId, status: ['Draft', 'PendingDCIManager', 'PendingDCIImplementation'] },
            attributes: ['id', 'status']
        });
        if (active) return res.json({ state: 'active', id: active.id, status: active.status });

        const completed = await OffboardingRequest.findOne({
            where: { employeeId, status: 'Completed' },
            attributes: ['id'],
            order: [['completedAt', 'DESC']]
        });
        if (completed) return res.json({ state: 'completed', id: completed.id });

        return res.json({ state: null });
    } catch (err) {
        logger.error(`[Offboarding lookup] ${err.message}`);
        return res.status(500).json({ state: null, error: err.message });
    }
};

// ───────────────────────────────────────────────────────────────────────
// Per-request history page — mirrors onboardingController.renderHistory.
// GET /api/offboarding/history/:id
// ───────────────────────────────────────────────────────────────────────
const STATUS_LABEL = {
    Draft:                     'Draft',
    PendingDCIManager:         'Pending DCI Manager Approval',
    PendingDCIImplementation:  'Pending AD + Access Revocation',
    Completed:                 'Completed',
    Rejected:                  'Rejected'
};
const STATUS_OWNER = {
    Draft:                     '—',
    PendingDCIManager:         'DCI Manager',
    PendingDCIImplementation:  'DCI Implementer',
    Completed:                 '—',
    Rejected:                  '—'
};

export const renderHistory = async (req, res) => {
    try {
        const { id } = req.params;
        const request = await OffboardingRequest.findByPk(id);
        if (!request) {
            return res.status(404).render('pages/message', {
                title: 'Not Found', heading: 'Offboarding request not found',
                titleClass: 'error', icon: '⛔', iconClass: 'error-icon',
                message: `No offboarding request with id #${id}.`
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

        // "Currently With" — resolve from the request's assignee email
        // (already stamped at the previous stage transition).
        const currentRecipient = {
            role:  STATUS_OWNER[request.status] || '—',
            name:  '',
            email: request.currentStageAssigneeEmail || ''
        };

        return res.render('pages/offboarding_history', {
            title: `Offboarding History - ${request.fullName || request.employeeId}`,
            request,
            timeline,
            currentRecipient,
            statusLabel:         STATUS_LABEL[request.status] || request.status,
            locationGroupLabels: LOCATION_GROUP_LABELS
        });
    } catch (err) {
        logger.error(`[Offboarding History] ${err.message}`);
        return res.status(500).render('pages/message', {
            title: 'Error', heading: 'Error', titleClass: 'error',
            icon: '❌', iconClass: 'error-icon',
            message: err.message
        });
    }
};

import * as onboardingService from '../services/onboardingService.js';
import logger from '../utils/logger.js';
import SystemConfig from '../models/SystemConfig.js';
import OnboardingRequest from '../models/OnboardingRequest.js';
import TimelineEvent from '../models/TimelineEvent.js';
import { Op } from 'sequelize';
import { humanizeDetails, humanizeDetailsHTML, humanizeAction, narrate } from '../utils/historyFormatter.js';
import { labelFor as statusLabelFor, ownerFor as statusOwnerFor, colorFor as statusColorFor } from '../utils/workflowLabels.js';
import WorkflowApproverConfig from '../models/WorkflowApproverConfig.js';
import { emailsMatch } from '../utils/emailMatch.js';

// Map workflow status -> the role currently responsible for it
const STATUS_TO_ROLE = {
    PendingIT: { key: 'IT_OPS', label: 'IT Operations' },
    PendingHOD: { key: 'HOD', label: 'Head of Department' },
    PendingDCI: { key: 'DCI_TEAM', label: 'DCI Team' },
    PendingDCIManager: { key: 'DCI_MANAGER', label: 'DCI Manager' },
    PendingITHOD: { key: 'IT_HOD', label: 'IT HOD' },
    PendingDCIImplementation: { key: 'DCI_IMPLEMENTER', label: 'DCI Implementer' },
    // Step 12 owner is IT Operations (same group as Step 2) per client requirement.
    PendingOPSAction: { key: 'IT_OPS', label: 'IT Operations' },
    Completed: { key: null, label: 'Completed' },
    Rejected: { key: null, label: 'Closed (Rejected)' }
};

const resolveCurrentRecipient = async (status) => {
    const map = STATUS_TO_ROLE[status];
    if (!map) return { role: status, name: '', email: '' };
    if (!map.key) return { role: map.label, name: '', email: '' };
    try {
        const cfg = await WorkflowApproverConfig.findOne({ where: { roleKey: map.key, isActive: true } });
        if (!cfg) return { role: map.label, name: '', email: '' };
        const usingSecondary = cfg.primaryExpiredAt && cfg.secondaryEmail;
        return {
            role: map.label + (usingSecondary ? ' (Secondary)' : ''),
            name: usingSecondary ? cfg.secondaryName : cfg.approverName,
            email: usingSecondary ? cfg.secondaryEmail : cfg.approverEmail
        };
    } catch {
        return { role: map.label, name: '', email: '' };
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
        logger.error(`[Onboarding] Error: ${err.message}`);
        return res.status(500).render('pages/message', {
            title: 'Error',
            heading: 'Internal Server Error',
            titleClass: 'error',
            message: err.message
        });
    }
};

const handleSubmission = async (req, res, token) => {
    const data = req.body;
    // Normalize checkbox values
    const checkboxFields = [
        'intranetAccess', 'internetAccess', 'specificWebsites', 'emailIncoming',
        'emailOutgoing', 'laserPrinter', 'dotMatrixPrinter'
    ];
    checkboxFields.forEach(field => {
        data[field] = data[field] === 'on';
    });

    try {
        if (!token) {
            // HR Submission — requester identity ALWAYS comes from SSO; we ignore
            // any requesterName / requesterEmail in the body so a malicious or
            // mistaken POST cannot misattribute the request to someone else.
            if (req.user) {
                data.requesterName = req.user.displayName || req.user.username;
                data.requesterEmail = req.user.email || null;
            } else {
                return res.status(401).render('pages/message', {
                    title: 'Sign-in required',
                    heading: 'SSO sign-in required',
                    titleClass: 'error',
                    message: 'This request must be initiated from the IFL portal so we can identify the requester. Please open this page from the portal and try again.'
                });
            }

            // Guard: block duplicate active request for same employee.
            // HR-stage users must NOT see the prior request's history/trail —
            // workflow visibility is least-privilege and HR has no claim to
            // mid-flight data. Just refuse the submission with a clean message.
            if (data.employeeId) {
                const existing = await OnboardingRequest.findOne({
                    where: {
                        employeeId: data.employeeId,
                        status: { [Op.notIn]: ['Rejected', 'Completed'] }
                    },
                    attributes: ['id']
                });
                if (existing) {
                    return res.status(409).render('pages/message', {
                        title: 'Request already exists',
                        heading: 'A request is already in progress',
                        titleClass: 'error',
                        message: `An onboarding request for employee #${data.employeeId} is already moving through the workflow. You cannot submit a duplicate. Please wait for the existing request to complete (or be rejected) before initiating a new one.`
                    });
                }
            }

            // Step 1: HR/IT initiates the request.
            const created = await onboardingService.createRequest(data);
            return renderSuccess(
                res,
                'Request Submitted',
                'Request submitted successfully. The request has been forwarded to IT Operations for service configuration.',
                { status: 'PendingIT', requestId: created && created.id }
            );
        } else {
            const context = await onboardingService.getFormContext(token);
            if (!context) return renderError(res, 'Invalid or Expired Token');

            const { role, request } = context;

            // ─── Forwarded-email validation (HARD enforcement at POST) ────
            // The token is valid, but make absolutely sure the SSO user
            // submitting this action is the intended approver. This catches
            // any forwarded-email scenario regardless of how the GET reached
            // them. The same email that was used to send the action link
            // (request.currentStageAssigneeEmail) must match req.user.email.
            // Compare LOCAL-PART only (text before "@") — same person can be
            // ali.khan@ifl.net in HRMS and ali.khan@igc.com.pk in AD; the
            // domain varies but the local-part is consistent.
            const expectedEmail = request.currentStageAssigneeEmail || '';
            const actualEmail   = (req.user && req.user.email) || '';
            if (expectedEmail) {
                if (!actualEmail) {
                    // No SSO context — refuse outright. Token-only access is
                    // not enough to act on a request.
                    try {
                        await TimelineEvent.create({
                            requestId: request.id,
                            action: 'Unauthorized Submit',
                            actorRole: 'System',
                            details: `Submission attempt without SSO context. Expected ${request.currentStageAssigneeEmail}.`,
                            timestamp: new Date()
                        });
                    } catch (_) {}
                    return res.status(401).render('pages/message', {
                        title: 'SSO required',
                        heading: 'SSO sign-in required',
                        titleClass: 'error',
                        icon: '⛔',
                        iconClass: 'error-icon',
                        message: `This action can only be submitted by ${request.currentStageAssigneeEmail}. Please open the action link from the IFL portal so we can verify your identity.`
                    });
                }
                if (!emailsMatch(actualEmail, expectedEmail)) {
                    // Identity mismatch — log and reject.
                    try {
                        await TimelineEvent.create({
                            requestId: request.id,
                            action: 'Unauthorized Submit',
                            actorRole: 'System',
                            details: `Expected ${request.currentStageAssigneeEmail}, got ${req.user.email}`,
                            timestamp: new Date()
                        });
                    } catch (_) {}
                    return res.status(403).render('pages/message', {
                        title: 'Not authorized',
                        heading: 'This action is authorized only for the intended recipient',
                        titleClass: 'error',
                        icon: '⛔',
                        iconClass: 'error-icon',
                        message: `This action link was sent to ${request.currentStageAssigneeEmail}. You are signed in as ${req.user.email}, so you cannot submit this request. If you need to handle it on someone's behalf, please contact your administrator.`
                    });
                }
            }

            if (role === 'IT') {
                // Step 2: IT Ops records the configuration.
                await onboardingService.updateITDetails(token, data);
                return renderSuccess(
                    res,
                    'Record Submitted',
                    'Required Services configured and recorded. The request has been forwarded to HOD for review.',
                    { status: 'PendingHOD', requestId: request.id }
                );
            }
            else if (role === 'HOD') {
                // Step 3 (Approve) / Step 4 (Reject).
                const { action, hodRemarks } = data;
                await onboardingService.handleHODApproval(token, action, hodRemarks);
                if (action === 'Reject') {
                    return renderSuccess(
                        res,
                        'Request Rejected',
                        'Request rejected by HOD. The process has been stopped and notified to the relevant team.',
                        { status: 'Rejected', requestId: request.id }
                    );
                }
                return renderSuccess(
                    res,
                    'Request Approved',
                    'Approved by HOD. The request has been forwarded to the DCI Team for Window login and access setup.',
                    { status: 'PendingDCI', requestId: request.id }
                );
            }
            else if (role === 'DCI') {
                // Step 5: DCI Team records identity configuration.
                await onboardingService.updateDCIDetails(token, data);
                return renderSuccess(
                    res,
                    'Record Submitted',
                    'Windows login and required access details have been recorded. The request has been forwarded to the DCI Manager for final approval.',
                    { status: 'PendingDCIManager', requestId: request.id }
                );
            }
            else if (role === 'DCIManager') {
                // Steps 6 / 7 / 8 — decision depends on action and email risk.
                const { action, dciRemarks } = data;
                const updated = await onboardingService.handleDCIManagerApproval(token, action, dciRemarks);
                if (action === 'Reject') {
                    return renderSuccess(
                        res,
                        'Request Rejected',
                        'Request rejected by DCI Manager. The workflow has been stopped and notified to the DCI team.',
                        { status: 'Rejected', requestId: request.id }
                    );
                }
                if (action === 'RequestChanges') {
                    return renderSuccess(
                        res,
                        'Changes Requested',
                        'Change request sent back to the DCI Team with your remarks.',
                        { status: 'PendingDCI', requestId: request.id }
                    );
                }
                // Approve — branches based on whether email approval is needed.
                if (updated && updated.status === 'PendingITHOD') {
                    return renderSuccess(
                        res,
                        'Approve Request (Email Yes)',
                        'Approved by DCI Manager. The request has been forwarded to IT HOD for email service authorization.',
                        { status: 'PendingITHOD', requestId: request.id }
                    );
                }
                return renderSuccess(
                    res,
                    'Approved (No Email)',
                    'Approved by DCI Manager. PDF summary has been generated for record and notification sent for implementation.',
                    { status: 'PendingDCIImplementation', requestId: request.id }
                );
            }
            else if (role === 'ITHOD') {
                // Steps 9 / 10.
                const { action, itHodRemarks } = data;
                await onboardingService.handleITHODApproval(token, action, itHodRemarks);
                if (action === 'Reject') {
                    return renderSuccess(
                        res,
                        'Request Rejected',
                        'Request rejected by IT HOD. The workflow has been stopped and notified to the relevant team.',
                        { status: 'Rejected', requestId: request.id }
                    );
                }
                return renderSuccess(
                    res,
                    'Request Approved',
                    'Approved by IT HOD. The request is finalized — PDF summary has been generated for record and notification sent for implementation.',
                    { status: 'PendingDCIImplementation', requestId: request.id }
                );
            }
            else if (role === 'OPS') {
                // Step 12 — OPS final verification.
                const opsName = (req.user && (req.user.displayName || req.user.username)) || data.opsName;
                const checklistData = [];
                Object.keys(data).forEach(key => {
                    if (key.startsWith('check_')) {
                        checklistData.push({ item: key.replace('check_', ''), checked: data[key] === 'on' });
                    }
                });
                await onboardingService.handleOPSAction(token, checklistData, opsName);
                return renderSuccess(
                    res,
                    'Mark as Verified',
                    'Verification completed successfully. The onboarding process has been completed.',
                    { status: 'Completed', requestId: request.id }
                );
            }
            else {
                return renderError(res, 'Action not permitted.');
            }
        }
    } catch (err) {
        return renderError(res, err.message);
    }
};

export const handleProofUpload = async (req, res) => {
    try {
        const { token } = req.body;
        if (!req.files || req.files.length === 0) {
            return renderError(res, 'No files uploaded.');
        }

        // The /upload-proof route is gated by ssoMiddleware, so req.user is
        // guaranteed when SSO_MODE=PROD. Implementer identity comes ONLY from
        // SSO — we ignore req.body.implementerName so it can't be spoofed.
        if (!req.user) {
            return renderError(res, 'SSO sign-in required to record implementation proof.');
        }
        const implementerName = req.user.displayName || req.user.username;

        const filePaths = req.files.map(f => f.path);
        const updated = await onboardingService.handleDCIImplementation(token, filePaths, implementerName);

        return renderSuccess(
            res,
            'Implementation Proof Uploaded',
            'Implementation proof uploaded successfully. The request has been forwarded to the Operations team for the workstation and profile setup and final verification.',
            { status: 'PendingOPSAction', requestId: updated && updated.id }
        );
    } catch (err) {
        return renderError(res, err.message);
    }
};

const renderForm = async (req, res, token) => {
    let request = {};
    let role = 'HR';
    let timeline = [];

    if (token) {
        const context = await onboardingService.getFormContext(token);
        if (!context) return renderError(res, 'Invalid or Expired Token');
        request = context.request;
        role = context.role;

        // ─── Forwarded-email validation (SOFT, server-rendered hint) ──
        // The form-link route is intentionally NOT SSO-protected at GET, so
        // email-link clicks from any browser context render the form. If
        // req.user IS already populated (e.g. browser had Intranet zone trust
        // and IIS injected X-Auth-User), we do an early server-side reject
        // here so a forwarded recipient never sees the form's data. If
        // req.user is missing, the form's own JS does the same check
        // client-side via /api/auth/me as soon as it runs.
        //
        // The HARD enforcement happens at POST time: handleSubmission
        // refuses any submit whose req.user.email doesn't match the stored
        // currentStageAssigneeEmail.
        if (req.user && req.user.email && request.currentStageAssigneeEmail) {
            // Local-part only — see emailMatch.js for the rationale.
            if (!emailsMatch(req.user.email, request.currentStageAssigneeEmail)) {
                try {
                    await TimelineEvent.create({
                        requestId: request.id,
                        action: 'Unauthorized Click',
                        actorRole: 'System',
                        details: `Expected ${request.currentStageAssigneeEmail}, got ${req.user.email}`,
                        timestamp: new Date()
                    });
                } catch (e) {
                    logger.warn('[Onboarding] Could not record unauthorized-click audit event: ' + e.message);
                }
                return res.status(403).render('pages/message', {
                    title: 'Not authorized',
                    heading: 'This page is authorized only for the intended recipient',
                    titleClass: 'error',
                    icon: '⛔',
                    iconClass: 'error-icon',
                    message: `This action link was sent to ${request.currentStageAssigneeEmail}. You are signed in as ${req.user.email}, so you cannot act on this request. If you need to handle it on someone's behalf, please contact your administrator.`
                });
            }
        }

        // Load timeline events for this request to expose history within the form page
        try {
            timeline = await TimelineEvent.findAll({
                where: { requestId: request.id },
                order: [['timestamp', 'ASC']],
                attributes: ['eventId', 'action', 'actorRole', 'details', 'timestamp']
            });
            timeline = timeline.map(e => {
                const ev = e.toJSON();
                ev.actionLabel = humanizeAction(ev.action);
                ev.detailsText = humanizeDetails(ev.details);
                ev.detailsHTML = humanizeDetailsHTML(ev.details);
                ev.summary     = narrate(ev);
                return ev;
            });
        } catch (e) {
            logger.warn('[Onboarding] Could not load timeline: ' + e.message);
        }
    } else if (req.query.employeeId && role === 'HR') {
        // HR is entering an employee number — if an active request already
        // exists, refuse with a least-privilege blocked-message. HR cannot view
        // the in-flight request's trail; that's reserved for the role currently
        // holding the workflow.
        const existing = await OnboardingRequest.findOne({
            where: {
                employeeId: req.query.employeeId,
                status: { [Op.notIn]: ['Rejected', 'Completed'] }
            },
            attributes: ['id']
        });
        if (existing) {
            return res.status(409).render('pages/message', {
                title: 'Request already exists',
                heading: 'A request is already in progress',
                titleClass: 'error',
                message: `An onboarding request for employee #${req.query.employeeId} is already moving through the workflow. Please wait for it to complete before initiating a new one.`
            });
        }
    } else if (req.query.mock) {
        role = req.query.mock.toUpperCase(); // IT, HOD, DCI, OPS, HR
        if (role === 'DSI') role = 'DCI'; // Handle legacy DSI param
        request = {
            id: 'MOCK-' + role,
            fullName: 'Test User',
            employeeId: '1001',
            department: 'IT Dept',
            designation: 'Software Engineer',
            location: 'Head Office',
            joiningDate: '2023-01-01',
            officeExtension: '1234',
            requestMode: 'New',

            // IT Params (Pre-filled for later stages)
            intranetAccess: true,
            emailIncoming: true,
            emailOutgoing: true,
            deptSharePath: '\\\\Server\\Share',
            homeFolderPath: '\\\\Server\\Home',

            // Status params
            status: role === 'OPS' ? 'PendingOPSAction' : 'Pending' + role,
            approvalStatus: role === 'DCI' || role === 'OPS' ? 'Approved' : 'Pending',
            hodRemarks: (role === 'DCI' || role === 'DCIManager' || role === 'OPS') ? 'Approved by HOD with comments.' : ''
        };

        // Adjust status/role for flow logic
        if (role === 'IT') request.status = 'PendingIT';
        if (role === 'HOD') request.status = 'PendingHOD';
        if (role === 'DCI') request.status = 'PendingDCI';
        if (role === 'DCIIMPLEMENTER') {
            role = 'DCIImplementer';
            request.status = 'PendingDCIImplementation';
            request.approvalStatus = 'Approved';
        }
    }

    // Role-based Config
    const hrDisabled = role !== 'HR' ? 'disabled' : '';
    const isServiceEditable = (role === 'IT' || role === 'DCI');
    const servicesDisabled = !isServiceEditable ? 'disabled' : '';
    const configDisabled = role !== 'DCI' ? 'disabled' : '';
    const dciRemarksDisabled = role !== 'DCIManager' ? 'disabled' : '';
    const hodRemarksDisabled = role !== 'HOD' ? 'disabled' : '';

    // Auto-fill requester name from logged-in SSO user if not already set on the record
    const currentUser = req.user || null;
    if (!request.requesterName && currentUser) {
        request.requesterName = currentUser.displayName || currentUser.username;
        request.requesterEmail = currentUser.email;
    }
    // Intranet default: pre-check for brand-new HR form (no existing request)
    if (role === 'HR' && !request.id && request.intranetAccess === undefined) {
        request.intranetAccess = true;
    }

    const val = (field) => request[field] || '';
    const chk = (field) => request[field] ? 'checked' : '';

    // Form Attributes
    let formAction = `?token=${token || ''}`;
    let formEnctype = '';
    if (role === 'DCIImplementer') {
        formAction = '/api/onboarding/upload-proof';
        formEnctype = 'enctype="multipart/form-data"';
    }

    // Stepper Logic
    const getStepClass = (stepRole) => {
        const order = ['HR', 'IT', 'HOD', 'DCI', 'DCIManager', 'ITHOD', 'Approved', 'DCIImplementer', 'OPS', 'Completed'];
        const currentIdx = order.indexOf(role);
        const stepIdx = order.indexOf(stepRole);
        if (currentIdx === stepIdx) return 'active';
        if (currentIdx > stepIdx) return 'completed';
        return '';
    };

    // Simplified Mapping for Visual Stepper
    const steps = [
        { label: 'Initial Request', status: getStepClass('HR') },
        { label: 'IT Operations', status: getStepClass('IT') },
        { label: 'Approvals', status: (['HOD', 'DCI', 'DCIManager', 'ITHOD'].includes(role) || request.approvalStatus === 'Approved') ? 'active' : (['DCIImplementer', 'OPS', 'Completed'].includes(request.status) ? 'completed' : '') },
        { label: 'Fulfillment', status: (['DCIImplementer', 'OPS', 'Completed'].includes(role) || request.status === 'Completed') ? 'active' : '' }
    ];

    // OPS Checklist Generation
    let opsChecklistHTML = '';
    if (role === 'OPS') {
        const items = [];
        if (request.intranetAccess) items.push('Configure Intranet Access');
        if (request.emailIncoming || request.emailOutgoing) items.push('Configure Outlook Email');
        if (request.deptSharePath) items.push(`Map Department Share (S:): ${request.deptSharePath}`);
        if (request.homeFolderPath) items.push(`Map Home Folder (Z:): ${request.homeFolderPath}`);
        if (request.laserPrinter) items.push(`Setup Laser Printer (${request.laserPrinterLocation || 'Default'})`);
        if (request.dotMatrixPrinter) items.push(`Setup Dot Matrix Printer (${request.dotMatrixPrinterLocation || 'Default'})`);
        if (request.iflPortalLink) items.push('Add IFL Portal Shortcut');
        items.push('Verify Domain Login');

        opsChecklistHTML = `
            <div class="ops-box">
                <div class="section-title">
                    <span>OPS Verification Checklist</span>
                    <span class="section-tag">Required</span>
                </div>
                <div class="grid-2">
                    <div class="form-group"><label>Verifier Name</label><input type="text" name="opsName" required></div>
                </div>
                <div class="checkbox-card-group" style="grid-template-columns: 1fr;">
                    ${items.map(item => `
                        <label class="checkbox-card">
                            <input type="checkbox" name="check_${item}" required>
                            <span>${item}</span>
                        </label>
                    `).join('')}
                </div>
            </div>
        `;
    }

    // Load dynamic config for dropdown fields
    let printerLocations = [];
    let fileSharePaths = [];
    let sharepointPaths = [];
    try {
        const configs = await SystemConfig.findAll({ attributes: ['key', 'value'] });
        configs.forEach(c => {
            const v = c.value;
            if (c.key === 'printer_locations' && Array.isArray(v)) printerLocations = v;
            if (c.key === 'file_share_paths'  && Array.isArray(v)) fileSharePaths = v;
            if (c.key === 'sharepoint_paths'   && Array.isArray(v)) sharepointPaths = v;
        });
    } catch (e) {
        logger.warn('[Onboarding] Could not load SystemConfig for form dropdowns: ' + e.message);
    }

    return res.render('pages/onboarding_form', {
        title: `Onboarding - ${role}`,
        request,
        role,
        token,
        hrDisabled,
        servicesDisabled,
        configDisabled,
        dciRemarksDisabled,
        hodRemarksDisabled,
        val,
        chk,
        formAction,
        formEnctype,
        steps,
        opsChecklistHTML,
        printerLocations,
        fileSharePaths,
        sharepointPaths,
        timeline,
        currentUser,
        // Expected SSO email for this stage — JS does a client-side mismatch
        // check on load so a forwarded recipient sees the rejection screen
        // even before they try to submit. Hard server-side enforcement still
        // runs at POST time.
        expectedAssigneeEmail: request.currentStageAssigneeEmail || null,
        // Role-portal sidebar context — when token-bearing pages render in
        // portal mode (everyone except HR / read-only), the sidebar fetches
        // this role's pending tasks + history.
        roleKey:   FORM_ROLE_TO_QUEUE_KEY[role] || null,
        roleLabel: FORM_ROLE_TO_LABEL[role]     || role
    });
};

// Workflow form role → queue role-key + display label used by the portal sidebar.
const FORM_ROLE_TO_QUEUE_KEY = {
    HR:              null,           // HR initiates only; no portal sidebar
    IT:              'IT_OPS',
    HOD:             'HOD',
    DCI:             'DCI_TEAM',
    DCIManager:      'DCI_MANAGER',
    ITHOD:           'IT_HOD',
    DCIImplementer:  'DCI_IMPLEMENTER',
    OPS:             'IT_OPS',       // OPS verification is IT_OPS per client policy
    ReadOnly:        null
};
const FORM_ROLE_TO_LABEL = {
    IT:              'IT Operations',
    HOD:             'Head of Department',
    DCI:             'DCI Team',
    DCIManager:      'DCI Manager',
    ITHOD:           'IT HOD',
    DCIImplementer:  'DCI Implementer',
    OPS:             'IT Operations'
};

// Map a role key to the request statuses it owns/can act on
// IT Operations now owns BOTH Step 2 (PendingIT) and Step 12 (PendingOPSAction)
// per client requirement — the same user who configured the services initially
// is also responsible for verifying after desk setup. OPS_TEAM is no longer a
// separate queue; OPS-routed designations fall back into IT_OPS.
const ROLE_TO_PENDING_STATUS = {
    IT_OPS: ['PendingIT', 'PendingOPSAction'],
    HOD: ['PendingHOD'],
    DCI_TEAM: ['PendingDCI'],
    DCI_MANAGER: ['PendingDCIManager'],
    IT_HOD: ['PendingITHOD'],
    DCI_IMPLEMENTER: ['PendingDCIImplementation']
};

const ROLE_TO_HISTORY_STATUS = {
    IT_OPS: ['PendingIT', 'PendingHOD', 'PendingDCI', 'PendingDCIManager', 'PendingITHOD', 'PendingDCIImplementation', 'PendingOPSAction', 'Completed', 'Rejected'],
    HOD: ['PendingHOD', 'PendingDCI', 'PendingDCIManager', 'PendingITHOD', 'PendingDCIImplementation', 'PendingOPSAction', 'Completed', 'Rejected'],
    DCI_TEAM: ['PendingDCI', 'PendingDCIManager', 'PendingITHOD', 'PendingDCIImplementation', 'PendingOPSAction', 'Completed', 'Rejected'],
    DCI_MANAGER: ['PendingDCIManager', 'PendingITHOD', 'PendingDCIImplementation', 'PendingOPSAction', 'Completed', 'Rejected'],
    IT_HOD: ['PendingITHOD', 'PendingDCIImplementation', 'PendingOPSAction', 'Completed', 'Rejected'],
    DCI_IMPLEMENTER: ['PendingDCIImplementation', 'PendingOPSAction', 'Completed', 'Rejected']
};

// Map AD designation strings (or workflow role keys) → queue role key.
// Lets users land on the queue page automatically without picking a role.
// All OPS-flavoured designations resolve to IT_OPS (single combined queue).
const DESIGNATION_TO_ROLE = {
    HR: 'IT_OPS', // HR initiates, doesn't have a queue. Default landing role for them is informational.
    'IT OPS': 'IT_OPS',
    'IT_OPS': 'IT_OPS',
    'IT': 'IT_OPS',
    'HOD': 'HOD',
    'HEAD OF DEPARTMENT': 'HOD',
    'DCI': 'DCI_TEAM',
    'DCI TEAM': 'DCI_TEAM',
    'DCI_TEAM': 'DCI_TEAM',
    'DCI MANAGER': 'DCI_MANAGER',
    'DCI_MANAGER': 'DCI_MANAGER',
    'IT HOD': 'IT_HOD',
    'IT_HOD': 'IT_HOD',
    'DCI IMPLEMENTER': 'DCI_IMPLEMENTER',
    'DCI_IMPLEMENTER': 'DCI_IMPLEMENTER',
    // OPS-routed designations now collapse into IT_OPS
    'OPS': 'IT_OPS',
    'OPS TEAM': 'IT_OPS',
    'OPS_TEAM': 'IT_OPS'
};

/**
 * Render the role-based pending-actions page. Picks role from:
 *   1. ?role=X query parameter (explicit override)
 *   2. req.user.designation mapped via DESIGNATION_TO_ROLE
 *   3. Default to IT_OPS so the page is never empty in demos
 */
export const renderRoleQueue = async (req, res) => {
    try {
        const explicit = req.query.role ? String(req.query.role).toUpperCase() : null;
        const fromDesig = req.user && req.user.designation
            ? DESIGNATION_TO_ROLE[String(req.user.designation).toUpperCase()] || null
            : null;
        const role = explicit || fromDesig || 'IT_OPS';
        const type = String(req.query.type || 'pending').toLowerCase();
        const map = type === 'history' ? ROLE_TO_HISTORY_STATUS : ROLE_TO_PENDING_STATUS;

        const validRoles = Object.keys(ROLE_TO_PENDING_STATUS);
        const safeRole = validRoles.includes(role) ? role : 'IT_OPS';
        const statuses = map[safeRole] || [];

        const rows = statuses.length ? await OnboardingRequest.findAll({
            where: { status: { [Op.in]: statuses } },
            order: [['updatedAt', 'DESC']],
            attributes: [
                'id', 'employeeId', 'fullName', 'department', 'subDepartment',
                'designation', 'requesterName', 'requesterEmail', 'status',
                'createdAt', 'updatedAt', 'currentStageToken'
            ]
        }) : [];

        const items = rows.map(r => {
            const j = r.toJSON();
            const actionable = ROLE_TO_PENDING_STATUS[safeRole]?.includes(j.status) || false;
            // Build the action URL — actionable rows go to the form via current stage token,
            // historical rows go to the read-only history page.
            const url = actionable && j.currentStageToken
                ? `/api/onboarding/handle?token=${j.currentStageToken}`
                : `/api/onboarding/history/${j.id}`;
            return {
                requestId: j.id,
                employeeId: j.employeeId,
                fullName: j.fullName,
                department: [j.department, j.subDepartment].filter(Boolean).join(' / ') || '—',
                designation: j.designation,
                initiatorName: j.requesterName || '—',
                initiatorEmail: j.requesterEmail || '',
                // Friendly client-nomenclature label, not the raw "PendingHOD" string
                currentStage: statusLabelFor(j.status),
                currentStageLabel: statusOwnerFor(j.status),
                lastUpdated: j.updatedAt,
                actionable,
                url
            };
        });

        return res.render('pages/role_queue', {
            title: `My ${type === 'history' ? 'Workflow History' : 'Pending Actions'}`,
            role: safeRole,
            type,
            items,
            currentUser: req.user || null,
            roleOptions: validRoles
        });
    } catch (err) {
        logger.error(`[Role Queue] ${err.message}`);
        return res.status(500).render('pages/message', {
            title: 'Error',
            heading: 'Could not load your queue',
            titleClass: 'error',
            message: err.message
        });
    }
};

// queue role-key → list of TimelineEvent.actorRole values this role has produced.
// Used by the History tab so each row reflects what THIS role did to a request,
// not the request's overall status.
const QUEUE_ROLE_TO_ACTOR_ROLES = {
    IT_OPS:          ['IT', 'OPS'],         // Step 2 (configure) + Step 12 (verify)
    HOD:             ['HOD'],
    DCI_TEAM:        ['DCI'],
    DCI_MANAGER:     ['DCIManager'],
    IT_HOD:          ['ITHOD'],
    DCI_IMPLEMENTER: ['DCIImplementer']
};

// Friendly verb for each action — what gets shown as the row's primary text
// in the history sidebar ("Approved", "Configured Services", …).
const ACTION_VERB = {
    'Request Initiated':                  'Submitted Request',
    'IT Services Configured':             'Configured Services',
    'HOD Approved':                       'Approved',
    'HOD Rejected':                       'Rejected',
    'DCI Configuration Submitted':        'Submitted Identity Config',
    'DCI Manager Approved':               'Approved',
    'DCI Manager Approved (High Risk)':   'Approved (Email Routed)',
    'DCI Manager Rejected':               'Rejected',
    'DCI Manager Requested Changes':      'Requested Changes',
    'IT HOD Approved':                    'Approved',
    'IT HOD Rejected':                    'Rejected',
    'DCI Implementation Completed':       'Provisioned Account',
    'OPS Checklist Completed':            'Verified Setup',
    'Email Regenerated':                  'Resent Email',
    'Work Order PDF Emailed':             'PDF Generated'
};

function actionTone(action) {
    if (!action) return 'info';
    if (/reject/i.test(action))                      return 'danger';
    if (/approve|completed|verified|submitted/i.test(action)) return 'success';
    if (/requested changes/i.test(action))           return 'warning';
    return 'info';
}

/**
 * GET /api/onboarding/queue?role=DCI_IMPLEMENTER&type=pending|history
 *
 * Two modes:
 *   pending → rows are OnboardingRequests currently waiting on this role
 *   history → rows are TimelineEvents this role has already produced
 *             (i.e., "what I did to this request"), most-recent first
 */
export const getRoleQueue = async (req, res) => {
    try {
        const role = String(req.query.role || '').toUpperCase();
        const type = String(req.query.type || 'pending').toLowerCase();

        if (type === 'history') {
            const actorRoles = QUEUE_ROLE_TO_ACTOR_ROLES[role];
            if (!actorRoles) {
                return res.status(400).json({ success: false, error: `Unknown role "${role}". Valid: ${Object.keys(QUEUE_ROLE_TO_ACTOR_ROLES).join(', ')}` });
            }

            const events = await TimelineEvent.findAll({
                where: { actorRole: { [Op.in]: actorRoles } },
                order: [['timestamp', 'DESC']],
                attributes: ['eventId', 'requestId', 'action', 'actorRole', 'details', 'timestamp']
            });

            const requestIds = Array.from(new Set(events.map(e => e.requestId)));
            const requests = requestIds.length
                ? await OnboardingRequest.findAll({
                    where: { id: { [Op.in]: requestIds } },
                    attributes: ['id', 'employeeId', 'fullName', 'department', 'subDepartment',
                                 'designation', 'requesterName', 'requesterEmail', 'status']
                })
                : [];
            const reqMap = new Map(requests.map(r => [r.id, r.toJSON()]));

            const data = events.map(e => {
                const ev = e.toJSON();
                const req = reqMap.get(ev.requestId) || {};
                return {
                    rowId:           'evt-' + ev.eventId,
                    isEvent:         true,
                    eventId:         ev.eventId,
                    requestId:       ev.requestId,
                    actorRole:       ev.actorRole,
                    action:          ev.action,
                    actionLabel:     ACTION_VERB[ev.action] || ev.action,
                    actionTone:      actionTone(ev.action),
                    actionDetailHTML: humanizeDetailsHTML(ev.details),
                    actionDetailText: humanizeDetails(ev.details),
                    timestamp:       ev.timestamp,
                    // Employee summary — surface enough so the row stands alone
                    fullName:        req.fullName     || '',
                    employeeId:      req.employeeId   || '',
                    department:      req.department   || '',
                    subDepartment:   req.subDepartment || '',
                    designation:     req.designation  || '',
                    initiatorName:   req.requesterName  || '',
                    initiatorEmail:  req.requesterEmail || '',
                    requestStatus:   req.status || ''
                };
            });

            return res.json({ success: true, role, type, count: data.length, data });
        }

        // ─── pending mode (unchanged shape, flattened for the portal sidebar) ───
        const pendingStatuses = ROLE_TO_PENDING_STATUS[role];
        if (!pendingStatuses) {
            return res.status(400).json({ success: false, error: `Unknown role "${role}". Valid: ${Object.keys(ROLE_TO_PENDING_STATUS).join(', ')}` });
        }

        const rows = await OnboardingRequest.findAll({
            where: { status: { [Op.in]: pendingStatuses } },
            order: [['updatedAt', 'DESC']],
            attributes: ['id', 'employeeId', 'fullName', 'department', 'subDepartment', 'designation',
                         'requesterName', 'requesterEmail', 'status', 'createdAt', 'updatedAt', 'currentStageToken']
        });

        const data = rows.map(r => {
            const j = r.toJSON();
            const stage = STATUS_TO_ROLE[j.status];
            const actionable = pendingStatuses.includes(j.status);
            const url = actionable && j.currentStageToken
                ? `/api/onboarding/handle?token=${j.currentStageToken}`
                : `/api/onboarding/history/${j.id}`;
            return {
                rowId:           'req-' + j.id,
                isEvent:         false,
                requestId:       j.id,
                fullName:        j.fullName     || '',
                employeeId:      j.employeeId   || '',
                department:      j.department   || '',
                subDepartment:   j.subDepartment || '',
                designation:     j.designation  || '',
                initiatorName:   j.requesterName  || '',
                initiatorEmail:  j.requesterEmail || '',
                currentStage:    statusLabelFor(j.status),
                currentRoleOwner: stage ? stage.label : j.status,
                lastUpdated:     j.updatedAt,
                actionable,
                url
            };
        });

        return res.json({ success: true, role, type, count: data.length, data });
    } catch (err) {
        logger.error(`[Onboarding Queue] ${err.message}`);
        return res.status(500).json({ success: false, error: err.message });
    }
};

/**
 * GET /api/onboarding/:id/details
 * Returns a JSON snapshot of one request (summary + friendly timeline).
 * Powers the role-portal sidebar's "history row click" detail popup.
 * SSO-gated so only authenticated workflow users can introspect requests.
 */
export const getRequestDetails = async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'Invalid id' });

        const request = await OnboardingRequest.findByPk(id, {
            attributes: [
                'id', 'employeeId', 'fullName', 'department', 'subDepartment',
                'designation', 'location', 'requesterName', 'requesterEmail',
                'status', 'approvalStatus',
                'hrSubmittedAt', 'itSubmittedAt', 'hodApprovedAt',
                'dciSubmittedAt', 'dciManagerDecidedAt', 'itHodDecidedAt',
                'dciImplementedAt', 'opsCompletedAt', 'createdAt', 'updatedAt'
            ]
        });
        if (!request) return res.status(404).json({ success: false, error: 'Request not found' });

        const events = await TimelineEvent.findAll({
            where: { requestId: id },
            order: [['timestamp', 'ASC']],
            attributes: ['eventId', 'action', 'actorRole', 'details', 'timestamp']
        });

        const timeline = events.map(e => {
            const ev = e.toJSON();
            return {
                eventId:   ev.eventId,
                action:    ev.action,
                actorRole: ev.actorRole,
                summary:   narrate(ev),
                timestamp: ev.timestamp
            };
        });

        const r = request.toJSON();
        return res.json({
            success: true,
            request: {
                id:             r.id,
                employeeId:     r.employeeId,
                fullName:       r.fullName,
                department:     r.department,
                subDepartment:  r.subDepartment,
                designation:    r.designation,
                location:       r.location,
                requesterName:  r.requesterName,
                requesterEmail: r.requesterEmail,
                statusRaw:      r.status,
                statusLabel:    statusLabelFor(r.status),
                statusOwner:    statusOwnerFor(r.status),
                approvalStatus: r.approvalStatus,
                createdAt:      r.createdAt,
                updatedAt:      r.updatedAt
            },
            timeline
        });
    } catch (err) {
        logger.error(`[Onboarding] getRequestDetails error: ${err.message}`);
        return res.status(500).json({ success: false, error: err.message });
    }
};

/**
 * JSON lookup — does an active onboarding request exist for this employeeId?
 * Used by the HR form's "Get Employee Data" flow to redirect to history.
 */
export const lookupExistingRequest = async (req, res) => {
    try {
        const { employeeId } = req.query;
        if (!employeeId) return res.json({ existingRequestId: null });

        const existing = await OnboardingRequest.findOne({
            where: {
                employeeId,
                status: { [Op.notIn]: ['Rejected', 'Completed'] }
            },
            attributes: ['id']
        });

        // HR is the only caller of this endpoint and must not see workflow
        // state (status, name, current stage) — return only a boolean signal.
        return res.json({
            existingRequestId: existing ? existing.id : null
        });
    } catch (err) {
        logger.error(`[Onboarding Lookup] ${err.message}`);
        return res.status(500).json({ error: err.message });
    }
};

/**
 * Render history / status page for an existing onboarding request.
 * Used when a user tries to submit for an employee who already has an active request.
 */
export const renderHistory = async (req, res) => {
    try {
        const { id } = req.params;
        const request = await OnboardingRequest.findByPk(id);
        if (!request) return renderError(res, 'Onboarding request not found');

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

        const currentRecipient = await resolveCurrentRecipient(request.status);

        return res.render('pages/onboarding_history', {
            title: `Onboarding History - ${request.fullName || request.employeeId}`,
            request,
            timeline,
            currentRecipient,
            statusLabel: statusLabelFor(request.status)
        });
    } catch (err) {
        logger.error(`[Onboarding History] ${err.message}`);
        return renderError(res, err.message);
    }
};

/**
 * Render the post-action success / confirmation page.
 *
 * @param {object} res
 * @param {string} title       - Heading shown to the user
 * @param {string} message     - One-sentence confirmation (per client's nomenclature)
 * @param {object} [next]      - Optional next-status info for the resulting-status panel
 * @param {string} [next.status]   - Internal status string the request just transitioned to
 *                                   (e.g. 'PendingHOD'). The view shows the friendly label.
 * @param {number|string} [next.requestId] - Request reference number to display
 */
const renderSuccess = (res, title, message, next = {}) => {
    const view = {
        title: 'Success',
        heading: title,
        titleClass: 'success',
        icon: '✅',
        iconClass: 'success-icon',
        message: message
    };
    if (next.status) {
        view.nextStatus      = statusLabelFor(next.status);
        view.nextOwner       = statusOwnerFor(next.status);
        view.nextStatusColor = statusColorFor(next.status);
    }
    if (next.requestId) view.requestRef = next.requestId;
    return res.render('pages/message', view);
};

const renderError = (res, message) => {
    return res.render('pages/message', {
        title: 'Error',
        heading: 'Error',
        titleClass: 'error',
        icon: '❌',
        iconClass: 'error-icon',
        message: message
    });
};

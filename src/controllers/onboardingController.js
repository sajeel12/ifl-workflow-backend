import * as onboardingService from '../services/onboardingService.js';
import logger from '../utils/logger.js';
import SystemConfig from '../models/SystemConfig.js';
import OnboardingRequest from '../models/OnboardingRequest.js';
import TimelineEvent from '../models/TimelineEvent.js';
import { Op } from 'sequelize';
import { humanizeDetails, humanizeDetailsHTML, humanizeAction, narrate } from '../utils/historyFormatter.js';
import WorkflowApproverConfig from '../models/WorkflowApproverConfig.js';

// Map workflow status -> the role currently responsible for it
const STATUS_TO_ROLE = {
    PendingIT: { key: 'IT_OPS', label: 'IT Operations' },
    PendingHOD: { key: 'HOD', label: 'Head of Department' },
    PendingDCI: { key: 'DCI_TEAM', label: 'DCI Team' },
    PendingDCIManager: { key: 'DCI_MANAGER', label: 'DCI Manager' },
    PendingITHOD: { key: 'IT_HOD', label: 'IT HOD' },
    PendingDCIImplementation: { key: 'DCI_IMPLEMENTER', label: 'DCI Implementer' },
    PendingOPSAction: { key: 'OPS_TEAM', label: 'OPS Team' },
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

            await onboardingService.createRequest(data);
            return renderSuccess(res, 'Request Submitted', 'The request has been sent to IT Operations for service configuration.');
        } else {
            const context = await onboardingService.getFormContext(token);
            if (!context) return renderError(res, 'Invalid or Expired Token');

            const { role, request } = context;

            if (role === 'IT') {
                await onboardingService.updateITDetails(token, data);
                return renderSuccess(res, 'Services Configured', 'The request has been forwarded to the HOD for review.');
            }
            else if (role === 'HOD') {
                const { action, hodRemarks } = data;
                await onboardingService.handleHODApproval(token, action, hodRemarks);
                return renderSuccess(res, `Request ${action}ed`, `The request has been forwarded to the DCI Team. (Action: ${action})`);
            }
            else if (role === 'DCI') {
                await onboardingService.updateDCIDetails(token, data);
                return renderSuccess(res, 'Configuration Saved', 'The request has been forwarded to the DCI Manager for final approval.');
            }
            else if (role === 'DCIManager') {
                const { action, dciRemarks } = data;
                await onboardingService.handleDCIManagerApproval(token, action, dciRemarks);
                return renderSuccess(res, `Decision Recorded`, `The request has been processed. (Action: ${action})`);
            }
            else if (role === 'ITHOD') {
                const { action, itHodRemarks } = data;
                await onboardingService.handleITHODApproval(token, action, itHodRemarks);
                return renderSuccess(res, `Decision Recorded`, `The request has been finalized. (Action: ${action})`);
            }
            else if (role === 'OPS') {
                // OPS action is reached via the email-link token flow (no SSO
                // middleware), but if the OPS user happens to be signed in via
                // SSO we prefer that identity over the form-supplied opsName so
                // it can't be misattributed.
                const opsName = (req.user && (req.user.displayName || req.user.username)) || data.opsName;
                // Parse checklist from body keys starting with "check_"
                const checklistData = [];
                Object.keys(data).forEach(key => {
                    if (key.startsWith('check_')) {
                        checklistData.push({ item: key.replace('check_', ''), checked: data[key] === 'on' });
                    }
                });
                await onboardingService.handleOPSAction(token, checklistData, opsName);
                return renderSuccess(res, 'Setup Completed', 'The workstation setup has been verified and recorded.');
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
        await onboardingService.handleDCIImplementation(token, filePaths, implementerName);

        return renderSuccess(res, 'Proofs Uploaded', 'Implementation proofs have been submitted. Request forwarded to OPS.');
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
        currentUser
    });
};

// Map a role key to the request statuses it owns/can act on
const ROLE_TO_PENDING_STATUS = {
    IT_OPS: ['PendingIT'],
    HOD: ['PendingHOD'],
    DCI_TEAM: ['PendingDCI'],
    DCI_MANAGER: ['PendingDCIManager'],
    IT_HOD: ['PendingITHOD'],
    DCI_IMPLEMENTER: ['PendingDCIImplementation'],
    OPS_TEAM: ['PendingOPSAction']
};

const ROLE_TO_HISTORY_STATUS = {
    IT_OPS: ['PendingIT', 'PendingHOD', 'PendingDCI', 'PendingDCIManager', 'PendingITHOD', 'PendingDCIImplementation', 'PendingOPSAction', 'Completed', 'Rejected'],
    HOD: ['PendingHOD', 'PendingDCI', 'PendingDCIManager', 'PendingITHOD', 'PendingDCIImplementation', 'PendingOPSAction', 'Completed', 'Rejected'],
    DCI_TEAM: ['PendingDCI', 'PendingDCIManager', 'PendingITHOD', 'PendingDCIImplementation', 'PendingOPSAction', 'Completed', 'Rejected'],
    DCI_MANAGER: ['PendingDCIManager', 'PendingITHOD', 'PendingDCIImplementation', 'PendingOPSAction', 'Completed', 'Rejected'],
    IT_HOD: ['PendingITHOD', 'PendingDCIImplementation', 'PendingOPSAction', 'Completed', 'Rejected'],
    DCI_IMPLEMENTER: ['PendingDCIImplementation', 'PendingOPSAction', 'Completed', 'Rejected'],
    OPS_TEAM: ['PendingOPSAction', 'Completed', 'Rejected']
};

// Map AD designation strings (or workflow role keys) → queue role key.
// Lets users land on the queue page automatically without picking a role.
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
    'OPS': 'OPS_TEAM',
    'OPS TEAM': 'OPS_TEAM',
    'OPS_TEAM': 'OPS_TEAM'
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
            const stage = STATUS_TO_ROLE[j.status];
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
                currentStage: j.status,
                currentStageLabel: stage ? stage.label : j.status,
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

/**
 * GET /api/onboarding/queue?role=DCI_IMPLEMENTER&type=pending|history
 * Returns the list of requests visible to a given role.
 * Each row includes id, employee, status, currentRecipient.
 */
export const getRoleQueue = async (req, res) => {
    try {
        const role = String(req.query.role || '').toUpperCase();
        const type = String(req.query.type || 'pending').toLowerCase();
        const map = type === 'history' ? ROLE_TO_HISTORY_STATUS : ROLE_TO_PENDING_STATUS;

        if (!map[role]) {
            return res.status(400).json({ success: false, error: `Unknown role "${role}". Valid: ${Object.keys(map).join(', ')}` });
        }

        const rows = await OnboardingRequest.findAll({
            where: { status: { [Op.in]: map[role] } },
            order: [['updatedAt', 'DESC']],
            attributes: ['id', 'employeeId', 'fullName', 'department', 'subDepartment', 'designation',
                         'requesterName', 'requesterEmail', 'status', 'createdAt', 'updatedAt']
        });

        // Uniform shape so all role UIs look the same
        const data = rows.map(r => {
            const j = r.toJSON();
            const stage = STATUS_TO_ROLE[j.status];
            return {
                requestId: j.id,
                employee: { id: j.employeeId, name: j.fullName, designation: j.designation,
                            department: j.department, subDepartment: j.subDepartment },
                initiator: { name: j.requesterName, email: j.requesterEmail },
                currentStage: j.status,
                currentRole: stage ? stage.label : j.status,
                lastUpdated: j.updatedAt,
                actionable: ROLE_TO_PENDING_STATUS[role]?.includes(j.status) || false
            };
        });

        return res.json({ success: true, role, type, count: data.length, data });
    } catch (err) {
        logger.error(`[Onboarding Queue] ${err.message}`);
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
            currentRecipient
        });
    } catch (err) {
        logger.error(`[Onboarding History] ${err.message}`);
        return renderError(res, err.message);
    }
};

const renderSuccess = (res, title, message) => {
    return res.render('pages/message', {
        title: 'Success',
        heading: title,
        titleClass: 'success',
        icon: '✅',
        iconClass: 'success-icon',
        message: message
    });
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

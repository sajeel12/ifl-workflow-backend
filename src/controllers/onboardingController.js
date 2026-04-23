import * as onboardingService from '../services/onboardingService.js';
import logger from '../utils/logger.js';
import SystemConfig from '../models/SystemConfig.js';
import OnboardingRequest from '../models/OnboardingRequest.js';
import TimelineEvent from '../models/TimelineEvent.js';
import { Op } from 'sequelize';

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
            // HR Submission — attach requester info from SSO user
            if (req.user) {
                data.requesterName = data.requesterName || req.user.displayName || req.user.username;
                data.requesterEmail = req.user.email || null;
            }

            // Guard: block duplicate active request for same employee
            if (data.employeeId) {
                const existing = await OnboardingRequest.findOne({
                    where: {
                        employeeId: data.employeeId,
                        status: { [Op.notIn]: ['Rejected', 'Completed'] }
                    }
                });
                if (existing) {
                    return res.redirect(`/api/onboarding/history/${existing.id}`);
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
                const { opsName } = data;
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

        // Auto-fill implementer from Windows/SSO login; fall back to form field if no SSO session
        const implementerName =
            (req.user && (req.user.displayName || req.user.username)) ||
            req.body.implementerName ||
            'Unknown Implementer';

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
            timeline = timeline.map(e => e.toJSON());
        } catch (e) {
            logger.warn('[Onboarding] Could not load timeline: ' + e.message);
        }
    } else if (req.query.employeeId && role === 'HR') {
        // HR entered an employeeId on the initiate form — if an active request exists,
        // redirect them to its history/status page.
        const existing = await OnboardingRequest.findOne({
            where: {
                employeeId: req.query.employeeId,
                status: { [Op.notIn]: ['Rejected', 'Completed'] }
            }
        });
        if (existing) {
            return res.redirect(`/api/onboarding/history/${existing.id}`);
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
        { label: 'IT Services', status: getStepClass('IT') },
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
            attributes: ['id', 'status', 'fullName']
        });

        return res.json({
            existingRequestId: existing ? existing.id : null,
            status: existing ? existing.status : null,
            fullName: existing ? existing.fullName : null
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

        return res.render('pages/onboarding_history', {
            title: `Onboarding History - ${request.fullName || request.employeeId}`,
            request,
            timeline: events.map(e => e.toJSON())
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

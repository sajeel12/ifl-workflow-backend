import * as onboardingService from '../services/onboardingService.js';
import logger from '../utils/logger.js';

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
            // HR Submission
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
                const { action } = data;
                await onboardingService.handleITHODApproval(token, action);
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
        const { token, implementerName } = req.body;
        if (!req.files || req.files.length === 0) {
            return renderError(res, 'No files uploaded.');
        }

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

    if (token) {
        const context = await onboardingService.getFormContext(token);
        if (!context) return renderError(res, 'Invalid or Expired Token');
        request = context.request;
        role = context.role;
    } else if (req.query.mock) {
        role = req.query.mock.toUpperCase(); // IT, HOD, DCI, OPS, HR
        if (role === 'DSI') role = 'DCI'; // Handle legacy DSI param
        request = {
            id: 'MOCK-' + role,
            fullName: 'Test User',
            employeeId: '1001',
            department: 'IT Dept',
            designation: 'Software Engineer',
            projectUnit: 'Head Office',
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
        opsChecklistHTML
    });
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

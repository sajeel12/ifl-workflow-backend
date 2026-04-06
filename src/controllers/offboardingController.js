import * as offboardingService from '../services/offboardingService.js';
import OffboardingRequest from '../models/OffboardingRequest.js'; // Keep for direct DB queries like findAll
import logger from '../utils/logger.js';

// Unified renderHelper based on onboardingController
const renderSuccess = (res, title, message) => {
    return res.render('pages/message', { title: 'Success', heading: title, message, titleClass: 'success' });
};
const renderError = (res, message) => {
    return res.status(400).render('pages/message', { title: 'Error', heading: 'Error', message, titleClass: 'error' });
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
        return renderError(res, err.message);
    }
};

const handleSubmission = async (req, res, token) => {
    const data = req.body;
    
    // Normalize checkbox values
    const checkboxFields = ['adRevoked', 'physicalAccessRevoked'];
    checkboxFields.forEach(field => {
        data[field] = data[field] === 'on' || data[field] === 'true'; // Fallback for old tests
    });

    try {
        if (!token) {
            // HR Submission from standalone form
            const initiatedBy = req.user?.username || 'SYSTEM_ADMIN';
            await offboardingService.createRequest(data, initiatedBy);
            
            if (req.headers.accept && req.headers.accept.includes('text/html')) {
                return renderSuccess(res, 'Offboarding Initiated', 'Request created and sent to System Manager.');
            }
            return res.json({ success: true, message: 'Offboarding initiated successfully.' });
        } else {
            const context = await offboardingService.getFormContext(token);
            if (!context) return renderError(res, 'Invalid or Expired Token');

            const { role, request } = context;

            if (role === 'SystemManager') {
                const { action, managerRemarks, assignedSystemAgentId } = data;
                await offboardingService.handleManagerApproval(token, action || 'Approve', assignedSystemAgentId, managerRemarks);
                return renderSuccess(res, 'Request Assigned', `Assigned to ${assignedSystemAgentId}. Agent has been emailed.`);
            }
            else if (role === 'SystemTeam') {
                const { action, checklistNotes } = data;
                const result = await offboardingService.handleSystemTasks(token, action, data, checklistNotes);
                
                if (result.status === 'Completed') {
                    return renderSuccess(res, 'Offboarding Completed', 'All privileges revoked successfully.');
                } else {
                    return renderSuccess(res, 'Checklist Updated', 'Progress saved. Complete remaining items to finish.');
                }
            }
            else {
                return renderError(res, 'Action not permitted.');
            }
        }
    } catch (err) {
        if (req.headers.accept && req.headers.accept.includes('text/html')) {
            return renderError(res, err.message);
        }
        return res.status(500).json({ success: false, error: err.message });
    }
};

const renderForm = async (req, res, token) => {
    // If no token, maybe they want the standalone initiation form?
    if (!token && req.originalUrl.includes('/initiate')) {
        return res.render('pages/offboarding_initiate');
    }

    let request = {};
    let role = 'ReadOnly';

    if (token) {
        const context = await offboardingService.getFormContext(token);
        if (!context) return renderError(res, 'Invalid or Expired Token');
        request = context.request;
        role = context.role;
    }

    const steps = [
        { id: 'init', label: 'HR Initiation' },
        { id: 'manager', label: 'Manager Approval' },
        { id: 'system', label: 'System Tasks' },
        { id: 'complete', label: 'Completed' }
    ];

    let currentStateIndex = 0;
    if (request.status === 'Draft' || request.status === 'PendingManagerApproval') {
        currentStateIndex = 1;
    } else if (request.status === 'PendingSystemTeam') {
        currentStateIndex = 2;
    } else if (request.status === 'Completed') {
        currentStateIndex = 4;
    }

    steps.forEach((step, index) => {
        if (index < currentStateIndex) step.status = 'completed';
        else if (index === currentStateIndex) step.status = 'active';
        else step.status = 'pending';
    });

    res.render('pages/offboarding_status', { request, steps, role, token });
};

// Backwards capability POST for old API scripts (if any)
export const initiate = async (req, res) => {
    return handleRequest(req, res);
};

export const getPendingManager = async (req, res) => {
    try {
        const requests = await OffboardingRequest.findAll({
            where: { status: 'PendingManagerApproval' },
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
            where: { status: 'PendingSystemTeam' },
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
        const requests = await OffboardingRequest.findAll({
            order: [['createdAt', 'DESC']]
        });
        res.json({ success: true, data: requests });
    } catch (error) {
        logger.error(`[Offboarding API] ${error.message}`);
        res.status(500).json({ success: false, error: 'Server error' });
    }
};

import crypto from 'crypto';
import OffboardingRequest from '../models/OffboardingRequest.js';
import TimelineEvent from '../models/TimelineEvent.js';
import * as emailService from './emailService.js';
import logger from '../utils/logger.js';
import Employee from '../models/Employee.js';

// Setup basic Recipient abstractions here since RecipientService didn't have all of them.
const getRecipientEmail = async (roleKey, context = {}) => {
    // Basic mapping matching the pattern
    const roleMap = {
        'SYSTEM_MANAGER': process.env.EMAIL_SYSTEM_MANAGER || 'system.manager@ifl.com',
        'SYSTEM_AGENT': process.env.EMAIL_IT_AGENT || 'it.agent@ifl.com',
        'IT_HOD': process.env.EMAIL_IT_HOD || 'it.hod@ifl.com',
        'HR_HOD': process.env.EMAIL_HR_HOD || 'hr.hod@ifl.com'
    };
    return roleMap[roleKey] || 'default@ifl.com';
};

const sendStageEmail = async (email, request, token, type) => {
    try {
        const actionLink = `http://localhost:3000/api/offboarding/handle?token=${token}`;
        
        // Mocking the emailService implementation for offboarding
        console.log(`\n==============================================`);
        console.log(`[EmailService] DEPARTURE NOTIFICATION (${type})`);
        console.log(`To: ${email}`);
        console.log(`Subject: Offboarding Action Required - ${request.fullName}`);
        console.log(`Body: A new offboarding action requires your attention / review.`);
        console.log(`Action Link: ${actionLink}`);
        console.log(`==============================================\n`);
        
        logger.info(`[Offboarding] Sent ${type} email to ${email}`);
    } catch (err) {
        logger.error(`[Offboarding] Failed to send ${type} email: ${err.message}`);
    }
};

const logTimelineEvent = async (requestId, action, actorRole, details = null) => {
    try {
        await TimelineEvent.create({
            requestId,
            action,
            actorRole,
            details,
            timestamp: new Date()
        });
        logger.info(`[Timeline] Logged event: ${action} by ${actorRole} for Offboarding #${requestId}`);
    } catch (err) {
        logger.error(`[Timeline] Error logging event: ${err.message}`);
    }
};

export const getFormContext = async (token) => {
    if (!token) return null;
    const request = await OffboardingRequest.findOne({ where: { currentStageToken: token } });
    if (!request) return null;

    let role = 'ReadOnly';
    if (request.status === 'PendingManagerApproval') role = 'SystemManager';
    if (request.status === 'PendingSystemTeam') role = 'SystemTeam';

    return { request, role };
};

export const createRequest = async (data, initiatedBy) => {
    logger.info('[Offboarding] Creating new request');
    try {
        const { employeeId } = data;
        if (!employeeId) throw new Error('Employee ID is required.');

        const employee = await Employee.findByPk(employeeId);
        if (!employee) throw new Error('Employee not found.');

        const existing = await OffboardingRequest.findOne({
            where: { employeeId: employee.employeeId, status: ['Draft', 'PendingManagerApproval', 'PendingSystemTeam'] }
        });

        if (existing) throw new Error('An active offboarding request already exists for this employee.');

        const token = crypto.randomBytes(20).toString('hex');

        const request = await OffboardingRequest.create({
            employeeId: employee.employeeId,
            fullName: employee.name,
            department: employee.mainDept,
            designation: employee.designation,
            initiatedBy,
            initiatedAt: new Date(),
            status: 'PendingManagerApproval',
            currentStageToken: token
        });

        await logTimelineEvent(request.id, 'Request Initiated', 'HR', `Offboarding initiated for ${employee.name}`);
        
        const managerEmail = await getRecipientEmail('SYSTEM_MANAGER');
        await sendStageEmail(managerEmail, request, token, 'SYSTEM_MANAGER_APPROVAL');

        return request;
    } catch (err) {
        logger.error(`[Offboarding] Create Error: ${err.message}`);
        throw err;
    }
};

export const handleManagerApproval = async (token, action, assignAgentId, remarks) => {
    logger.info(`[Offboarding] Manager Approval Phase`);
    try {
        const request = await OffboardingRequest.findOne({ where: { currentStageToken: token } });
        if (!request || request.status !== 'PendingManagerApproval') throw new Error('Invalid Token');

        if (action === 'Reject') {
            await request.update({ status: 'Rejected', managerRemarks: remarks, currentStageToken: null });
            await logTimelineEvent(request.id, 'Manager Rejected', 'SystemManager', remarks);
            return request;
        }

        const newToken = crypto.randomBytes(20).toString('hex');
        await request.update({
            status: 'PendingSystemTeam',
            assignedSystemAgentId: assignAgentId,
            managerRemarks: remarks,
            managerApprovedAt: new Date(),
            currentStageToken: newToken
        });

        await logTimelineEvent(request.id, 'Manager Assigned Agent', 'SystemManager', `Assigned to ${assignAgentId}`);
        
        const agentEmail = await getRecipientEmail('SYSTEM_AGENT');
        await sendStageEmail(agentEmail, request, newToken, 'SYSTEM_TASKS_REQUIRED');

        return request;
    } catch (err) {
        logger.error(`[Offboarding] Manager Error: ${err.message}`);
        throw err;
    }
};

export const handleSystemTasks = async (token, action, checklistData, notes) => {
    logger.info(`[Offboarding] System Tasks Phase`);
    try {
        const request = await OffboardingRequest.findOne({ where: { currentStageToken: token } });
        if (!request || request.status !== 'PendingSystemTeam') throw new Error('Invalid Token');

        const adRevoked = checklistData.adRevoked;
        const physicalRevoked = checklistData.physicalAccessRevoked;

        await request.update({
            adRevoked,
            physicalAccessRevoked: physicalRevoked,
            checklistNotes: notes
        });

        if (adRevoked && physicalRevoked) {
            await request.update({
                status: 'Completed',
                completedAt: new Date(),
                currentStageToken: null
            });
            await logTimelineEvent(request.id, 'System Tasks Completed', 'SystemTeam', 'All access has been revoked successfully.');
            
            // Final completion notifications
            const itHodEmail = await getRecipientEmail('IT_HOD');
            const hrHodEmail = await getRecipientEmail('HR_HOD');
            await sendStageEmail(itHodEmail, request, 'NO_TOKEN', 'FINAL_NOTIFICATION_IT');
            await sendStageEmail(hrHodEmail, request, 'NO_TOKEN', 'FINAL_NOTIFICATION_HR');
            
            logger.info(`[Offboarding] Request ${request.id} COMPLETED.`);
        } else {
            await logTimelineEvent(request.id, 'System Tasks Progress Updated', 'SystemTeam', `AD: ${adRevoked}, Physical: ${physicalRevoked}`);
        }

        return request;
    } catch (err) {
        logger.error(`[Offboarding] System Tasks Error: ${err.message}`);
        throw err;
    }
};

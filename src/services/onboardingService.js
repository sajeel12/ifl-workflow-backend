import crypto from 'crypto';
import OnboardingRequest from '../models/OnboardingRequest.js';
import * as emailService from './emailService.js';
import logger from '../utils/logger.js';
import * as pdfService from './pdfService.js';
import path from 'path';

// Dummy emails for workflow stages
// Dummy emails for workflow stages
// Dummy emails
const IT_EMAIL = 'sajeel.dilshad@perception-it.com';
const DSI_EMAIL = 'sajeel.dilshad@perception-it.com';
const HOD_EMAIL_DUMMY = 'sajeel.dilshad@perception-it.com';
const DSI_MANAGER_EMAIL = 'sajeel.dilshad@perception-it.com';
const IT_HOD_EMAIL = 'sajeel.dilshad@perception-it.com';
const DCI_IMPLEMENTER_EMAIL = 'sajeel.dilshad@perception-it.com';
const OPS_TEAM_EMAIL = 'sajeel.dilshad@perception-it.com';


// Generic notification sender helper
const sendStageEmail = async (email, request, token, type) => {
    try {
        const actionLink = `${process.env.APP_URL}/api/onboarding/handle?token=${token}`;
        await emailService.sendOnboardingNotification(email, request, actionLink, type);
        logger.info(`[Onboarding] Sent ${type} email to ${email}`);
    } catch (err) {
        logger.error(`[Onboarding] Failed to send ${type} email: ${err.message}`);
    }
};

// ... (existing functions) ...

export const handleDSIManagerApproval = async (token, action, remarks) => {
    logger.info(`[Onboarding] DSI Manager Approval`);
    try {
        const request = await OnboardingRequest.findOne({ where: { currentStageToken: token } });
        if (!request || request.status !== 'PendingDSIManager') throw new Error('Invalid Token');

        if (action === 'Reject') {
            await request.update({ status: 'Rejected', approvalStatus: 'Rejected', dsiRemarks: remarks, currentStageToken: null });
            return request;
        }

        const needsEmailApproval = request.emailIncoming || request.emailOutgoing;

        if (needsEmailApproval) {
            const newToken = crypto.randomBytes(20).toString('hex');
            await request.update({
                status: 'PendingITHOD',
                dsiRemarks: remarks,
                currentStageToken: newToken,
                dsiManagerDecidedAt: new Date()
            });
            await sendStageEmail(IT_HOD_EMAIL, request, newToken, 'IT_HOD_APPROVAL');
        } else {
            // Move to Implementation Phase
            const newToken = crypto.randomBytes(20).toString('hex');
            await request.update({
                status: 'PendingDCIImplementation',
                approvalStatus: 'Approved',
                dsiRemarks: remarks,
                currentStageToken: newToken,
                dsiManagerDecidedAt: new Date()
            });
            await generateAndStorePDF(request); // PDF serves as Work Order
            await sendStageEmail(DCI_IMPLEMENTER_EMAIL, request, newToken, 'DCI_IMPLEMENTATION');
        }
        return request;
    } catch (err) {
        logger.error(`[Onboarding] DSI Manager Error: ${err.message}`);
        throw err;
    }
};

export const handleITHODApproval = async (token, action) => {
    logger.info(`[Onboarding] IT HOD Approval`);
    try {
        const request = await OnboardingRequest.findOne({ where: { currentStageToken: token } });
        if (!request || request.status !== 'PendingITHOD') throw new Error('Invalid Token');

        if (action === 'Reject') {
            await request.update({ status: 'Rejected', approvalStatus: 'Rejected', currentStageToken: null, itHodDecidedAt: new Date() });
            return request;
        }

        // Approve -> Move to Implementation
        const newToken = crypto.randomBytes(20).toString('hex');
        await request.update({
            status: 'PendingDCIImplementation',
            approvalStatus: 'Approved',
            currentStageToken: newToken,
            itHodDecidedAt: new Date()
        });
        await generateAndStorePDF(request);
        await sendStageEmail(DCI_IMPLEMENTER_EMAIL, request, newToken, 'DCI_IMPLEMENTATION');

        return request;
    } catch (err) {
        logger.error(`[Onboarding] IT HOD Error: ${err.message}`);
        throw err;
    }
};

export const handleDCIImplementation = async (token, filePaths, implementerName) => {
    logger.info(`[Onboarding] DCI Implementation`);
    try {
        const request = await OnboardingRequest.findOne({ where: { currentStageToken: token } });
        if (!request || request.status !== 'PendingDCIImplementation') throw new Error('Invalid Token');

        const newToken = crypto.randomBytes(20).toString('hex');
        await request.update({
            status: 'PendingOPSAction',
            dciImplementer: implementerName,
            dciProofAttachments: filePaths, // Array of strings
            dciImplementedAt: new Date(),
            currentStageToken: newToken
        });
        await sendStageEmail(OPS_TEAM_EMAIL, request, newToken, 'OPS_ACTION');
        return request;
    } catch (err) {
        logger.error(`[Onboarding] DCI Implementation Error: ${err.message}`);
        throw err;
    }
};

export const handleOPSAction = async (token, checklistData, opsName) => {
    logger.info(`[Onboarding] OPS Action`);
    try {
        const request = await OnboardingRequest.findOne({ where: { currentStageToken: token } });
        if (!request || request.status !== 'PendingOPSAction') throw new Error('Invalid Token');

        await request.update({
            status: 'Completed',
            opsCompletedBy: opsName,
            opsChecklist: checklistData,
            opsCompletedAt: new Date(),
            currentStageToken: null // Flow Ends
        });
        // Notify HR/User? For now just log.
        logger.info(`[Onboarding] Request ${request.id} COMPLETED.`);
        return request;
    } catch (err) {
        logger.error(`[Onboarding] OPS Error: ${err.message}`);
        throw err;
    }
};

export const getFormContext = async (token) => {
    if (!token) return null;
    const request = await OnboardingRequest.findOne({ where: { currentStageToken: token } });
    if (!request) return null;

    let role = 'ReadOnly';
    if (request.status === 'PendingIT') role = 'IT';
    if (request.status === 'PendingHOD') role = 'HOD';
    if (request.status === 'PendingDSI') role = 'DSI';
    if (request.status === 'PendingDSIManager') role = 'DSIManager';
    if (request.status === 'PendingITHOD') role = 'ITHOD';
    if (request.status === 'PendingDCIImplementation') role = 'DCIImplementer';
    if (request.status === 'PendingOPSAction') role = 'OPS';

    return { request, role };
};

export const createRequest = async (data) => {
    logger.info('[Onboarding] Creating new request');
    try {
        const token = crypto.randomBytes(20).toString('hex');
        const request = await OnboardingRequest.create({
            ...data,
            status: 'PendingIT',
            currentStageToken: token,
            hrSubmittedAt: new Date()
        });
        await sendStageEmail(IT_EMAIL, request, token, 'IT_OPS');
        return request;
    } catch (err) {
        logger.error(`[Onboarding] Error creating request: ${err.message}`);
        throw err;
    }
};

export const updateITDetails = async (token, data) => {
    logger.info(`[Onboarding] Updating IT details`);
    try {
        const request = await OnboardingRequest.findOne({ where: { currentStageToken: token } });
        if (!request || request.status !== 'PendingIT') throw new Error('Invalid Token or Stage');

        const newToken = crypto.randomBytes(20).toString('hex');
        await request.update({
            ...data,
            status: 'PendingHOD',
            currentStageToken: newToken,
            itSubmittedAt: new Date()
        });
        // In real app, look up HOD email based on employeeId/Dep
        await sendStageEmail(HOD_EMAIL_DUMMY, request, newToken, 'HOD_REVIEW');
        return request;
    } catch (err) {
        logger.error(`[Onboarding] IT Update Error: ${err.message}`);
        throw err;
    }
};

// HOD just approves (no changes typically, or comments)
export const handleHODApproval = async (token, action) => {
    logger.info(`[Onboarding] HOD Approval`);
    try {
        const request = await OnboardingRequest.findOne({ where: { currentStageToken: token } });
        if (!request || request.status !== 'PendingHOD') throw new Error('Invalid Token');

        if (action === 'Reject') {
            await request.update({ status: 'Rejected', approvalStatus: 'Rejected', currentStageToken: null });
            return request;
        }

        const newToken = crypto.randomBytes(20).toString('hex');
        await request.update({
            status: 'PendingDSI',
            currentStageToken: newToken,
            hodApprovedAt: new Date()
        });
        await sendStageEmail(DSI_EMAIL, request, newToken, 'DSI_INPUT');
        return request;
    } catch (err) {
        logger.error(`[Onboarding] HOD Error: ${err.message}`);
        throw err;
    }
};

export const updateDSIDetails = async (token, data) => {
    logger.info(`[Onboarding] Updating DSI details`);
    try {
        const request = await OnboardingRequest.findOne({ where: { currentStageToken: token } });
        if (!request || request.status !== 'PendingDSI') throw new Error('Invalid Token');

        const newToken = crypto.randomBytes(20).toString('hex');
        await request.update({
            ...data,
            status: 'PendingDSIManager',
            currentStageToken: newToken,
            dsiSubmittedAt: new Date()
        });
        await sendStageEmail(DSI_MANAGER_EMAIL, request, newToken, 'DSI_MANAGER_APPROVAL');
        return request;
    } catch (err) {
        logger.error(`[Onboarding] DSI Update Error: ${err.message}`);
        throw err;
    }
};


const generateAndStorePDF = async (request) => {
    try {
        const filename = `Onboarding_${request.employeeId}_${request.id}.pdf`;
        const outputPath = path.resolve('generated_pdfs', filename);
        await pdfService.generateOnboardingPDF(request, outputPath);
        logger.info(`[Onboarding] PDF Generated: ${outputPath}`);
        return outputPath;
    } catch (err) {
        logger.error(`[Onboarding] PDF Gen Error: ${err.message}`);
    }
};


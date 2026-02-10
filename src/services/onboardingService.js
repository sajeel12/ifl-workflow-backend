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
const DCI_EMAIL = 'sajeel.dilshad@perception-it.com';
const HOD_EMAIL_DUMMY = 'sajeel.dilshad@perception-it.com';
const DCI_MANAGER_EMAIL = 'sajeel.dilshad@perception-it.com';
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

export const handleDCIManagerApproval = async (token, action, remarks) => {
    logger.info(`[Onboarding] DCI Manager Approval`);
    try {
        const request = await OnboardingRequest.findOne({ where: { currentStageToken: token } });
        if (!request || request.status !== 'PendingDCIManager') throw new Error('Invalid Token');

        if (action === 'Reject') {
            await request.update({ status: 'Rejected', approvalStatus: 'Rejected', dciRemarks: remarks, currentStageToken: null });
            return request;
        }

        const needsEmailApproval = request.emailIncoming || request.emailOutgoing;

        if (needsEmailApproval) {
            const newToken = crypto.randomBytes(20).toString('hex');
            await request.update({
                status: 'PendingITHOD',
                dciRemarks: remarks,
                currentStageToken: newToken,
                dciManagerDecidedAt: new Date()
            });
            await sendStageEmail(IT_HOD_EMAIL, request, newToken, 'IT_HOD_APPROVAL');
        } else {
            // Move to Implementation Phase
            const newToken = crypto.randomBytes(20).toString('hex');
            await request.update({
                status: 'PendingDCIImplementation',
                approvalStatus: 'Approved',
                dciRemarks: remarks,
                currentStageToken: newToken,
                dciManagerDecidedAt: new Date()
            });
            await generateAndStorePDF(request); // PDF serves as Work Order
            await sendStageEmail(DCI_IMPLEMENTER_EMAIL, request, newToken, 'DCI_IMPLEMENTATION');
        }
        return request;
    } catch (err) {
        logger.error(`[Onboarding] DCI Manager Error: ${err.message}`);
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
    if (request.status === 'PendingDCI') role = 'DCI';
    if (request.status === 'PendingDCIManager') role = 'DCIManager';
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
export const handleHODApproval = async (token, action, remarks) => {
    logger.info(`[Onboarding] HOD Approval`);
    try {
        const request = await OnboardingRequest.findOne({ where: { currentStageToken: token } });
        if (!request || request.status !== 'PendingHOD') throw new Error('Invalid Token');

        if (action === 'Reject') {
            await request.update({ status: 'Rejected', approvalStatus: 'Rejected', hodRemarks: remarks, currentStageToken: null });
            return request;
        }

        const newToken = crypto.randomBytes(20).toString('hex');
        await request.update({
            status: 'PendingDCI',
            hodRemarks: remarks,
            currentStageToken: newToken,
            hodApprovedAt: new Date()
        });
        await sendStageEmail(DCI_EMAIL, request, newToken, 'DCI_INPUT');
        return request;
    } catch (err) {
        logger.error(`[Onboarding] HOD Error: ${err.message}`);
        throw err;
    }
};

export const updateDCIDetails = async (token, data) => {
    logger.info(`[Onboarding] Updating DCI details`);
    try {
        const request = await OnboardingRequest.findOne({ where: { currentStageToken: token } });
        if (!request || request.status !== 'PendingDCI') throw new Error('Invalid Token');

        const newToken = crypto.randomBytes(20).toString('hex');
        await request.update({
            ...data,
            status: 'PendingDCIManager',
            currentStageToken: newToken,
            dciSubmittedAt: new Date()
        });
        await sendStageEmail(DCI_MANAGER_EMAIL, request, newToken, 'DCI_MANAGER_APPROVAL');
        return request;
    } catch (err) {
        logger.error(`[Onboarding] DCI Update Error: ${err.message}`);
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


import crypto from 'crypto';
import OnboardingRequest from '../models/OnboardingRequest.js';
import * as emailService from './emailService.js';
import logger from '../utils/logger.js';

// Dummy emails for workflow stages
const IT_EMAIL = 'it.ops@example.com';
const DSI_EMAIL = 'dsi.head@example.com';

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

        // Send email to IT
        try {
            const actionLink = `${process.env.APP_URL}/api/onboarding/handle?token=${token}`;
            await emailService.sendOnboardingITNotification(IT_EMAIL, request, actionLink);
            logger.info(`[Onboarding] Request created, sent to IT`);
        } catch (emailErr) {
            logger.error(`[Onboarding] Failed to send IT email: ${emailErr.message}`);
        }

        return request;
    } catch (err) {
        logger.error(`[Onboarding] Error creating request: ${err.message}`);
        throw err;
    }
};

export const updateITDetails = async (token, data) => {
    logger.info(`[Onboarding] Updating IT details for token ${token}`);
    try {
        const request = await OnboardingRequest.findOne({ where: { currentStageToken: token } });
        if (!request) throw new Error('Invalid Token');

        if (request.status !== 'PendingIT') {
            throw new Error('Request is not in IT stage');
        }

        const newToken = crypto.randomBytes(20).toString('hex');

        await request.update({
            ...data,
            status: 'PendingDSI',
            currentStageToken: newToken,
            itSubmittedAt: new Date()
        });

        // Send email to DSI
        try {
            const actionLink = `${process.env.APP_URL}/api/onboarding/handle?token=${newToken}`;
            await emailService.sendOnboardingDSINotification(DSI_EMAIL, request, actionLink);
            logger.info(`[Onboarding] Request IT details updated, sent to DSI`);
        } catch (emailErr) {
            logger.error(`[Onboarding] Failed to send DSI email: ${emailErr.message}`);
        }

        return request;
    } catch (err) {
        logger.error(`[Onboarding] Error updating IT details: ${err.message}`);
        throw err;
    }
};

export const finalizeRequest = async (token, decision, remarks) => {
    logger.info(`[Onboarding] Finalizing request for token ${token}`);
    try {
        const request = await OnboardingRequest.findOne({ where: { currentStageToken: token } });
        if (!request) throw new Error('Invalid Token');

        if (request.status !== 'PendingDSI') {
            throw new Error('Request is not in DSI stage');
        }

        const finalStatus = decision === 'Approve' ? 'Approved' : (decision === 'Reject' ? 'Rejected' : 'Cancelled');

        await request.update({
            dsiRemarks: remarks,
            approvalStatus: finalStatus,
            status: finalStatus,
            currentStageToken: null, // Clear token to prevent further edits
            dsiDecidedAt: new Date()
        });

        // Notify HR/Requester (Using a generic notification for now, assumed HR initiated)
        // Since we don't have a direct requester email field from HR (only employeeId etc), 
        // we might notify a central HR email or if we had the initiator's email.
        // For now, let's log it and maybe send to IT as well for closing.

        // await emailService.sendOnboardingCompletionNotification(HR_EMAIL, request);

        logger.info(`[Onboarding] Request #${request.id} finalized: ${finalStatus}`);
        return request;
    } catch (err) {
        logger.error(`[Onboarding] Error finalizing request: ${err.message}`);
        throw err;
    }
};

export const getFormContext = async (token) => {
    if (!token) return null;

    const request = await OnboardingRequest.findOne({ where: { currentStageToken: token } });
    if (!request) return null;

    let role = 'ReadOnly';
    if (request.status === 'PendingIT') role = 'IT';
    if (request.status === 'PendingDSI') role = 'DSI';

    return { request, role };
};

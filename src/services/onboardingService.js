import crypto from 'crypto';
import OnboardingRequest from '../models/OnboardingRequest.js';
import TimelineEvent from '../models/TimelineEvent.js';
import SystemConfig from '../models/SystemConfig.js';
import * as emailService from './emailService.js';
import logger from '../utils/logger.js';
import * as pdfService from './pdfService.js';
import path from 'path';

import RecipientService from './recipientService.js';


// Email type → portal slug. Types without a portal (HOD_REVIEW) use the
// direct action URL so the approver isn't redirected to a non-existent portal.
const EMAIL_TYPE_TO_PORTAL_SLUG = {
    IT_OPS:               'it-ops',
    DCI_INPUT:            'dci-team',
    DCI_CHANGES_REQUESTED:'dci-team',
    DCI_MANAGER_APPROVAL: 'dci-manager',
    IT_HOD_APPROVAL:      'it-hod',
    DCI_IMPLEMENTATION:   'dci-implementer',
    OPS_ACTION:           'it-ops',
};

// Generic notification sender helper
const sendStageEmail = async (email, request, token, type) => {
    try {
        const slug = EMAIL_TYPE_TO_PORTAL_SLUG[type];
        const actionLink = slug
            ? `${process.env.APP_URL}/portal/${slug}/enter?action=${token}`
            : `${process.env.APP_URL}/api/onboarding/handle?token=${token}`;
        await emailService.sendOnboardingNotification(email, request, actionLink, type);
        logger.info(`[Onboarding] Sent ${type} email to ${email}`);
    } catch (err) {
        logger.error(`[Onboarding] Failed to send ${type} email: ${err.message}`);
    }
};

// Helper to log timeline events
const logTimelineEvent = async (requestId, action, actorRole, details = null) => {
    try {
        await TimelineEvent.create({
            requestId,
            action,
            actorRole,
            details,
            timestamp: new Date()
        });
        logger.info(`[Timeline] Logged event: ${action} by ${actorRole} for Request #${requestId}`);
    } catch (err) {
        logger.error(`[Timeline] Error logging event: ${err.message}`);
    }
};

// Resolves a recipient using 2-day primary/secondary fallback where configured.
// Always returns { email, username } — username is the AD sAMAccountName for
// portal-based roles; null for HRMS-sourced roles (e.g. HOD).
const resolveRecipient = async (roleKey, context) => {
    if (roleKey === 'HOD') {
        const email = await RecipientService.get('HOD', context);
        return { email, username: null };
    }
    const resolved = await RecipientService.getWithFallback(roleKey, context);
    if (resolved && resolved.email) return { email: resolved.email, username: resolved.username || null };
    const email = await RecipientService.get(roleKey, context);
    return { email, username: null };
};

export const handleDCIManagerApproval = async (token, action, remarks) => {
    logger.info(`[Onboarding] DCI Manager Approval`);
    try {
        const request = await OnboardingRequest.findOne({ where: { currentStageToken: token } });
        if (!request || request.status !== 'PendingDCIManager') throw new Error('Invalid Token');

        if (action === 'Reject') {
            await request.update({
                status: 'Rejected',
                approvalStatus: 'Rejected',
                dciRemarks: remarks,
                currentStageToken: null,
                currentStageAssigneeEmail: null,
                currentStageAssigneeUsername: null
            });
            await logTimelineEvent(request.id, 'DCI Manager Rejected', 'DCIManager', remarks);
            return request;
        }

        // NEW: DCI Manager can request changes — sends back to DCI Team
        if (action === 'RequestChanges') {
            const newToken = crypto.randomBytes(20).toString('hex');
            const dciRecipient = await resolveRecipient('DCI_TEAM', { location: request.location, requestId: request.id });
            await request.update({
                status: 'PendingDCI',
                dciChangeRequestRemarks: remarks,
                currentStageToken: newToken,
                currentStageAssigneeEmail:    dciRecipient.email    || null,
                currentStageAssigneeUsername: dciRecipient.username || null
            });
            await logTimelineEvent(request.id, 'DCI Manager Requested Changes', 'DCIManager', remarks);
            await sendStageEmail(dciRecipient.email, request, newToken, 'DCI_CHANGES_REQUESTED');
            return request;
        }

        const needsEmailApproval = request.emailIncoming || request.emailOutgoing;

        if (needsEmailApproval) {
            const newToken = crypto.randomBytes(20).toString('hex');
            const itHodRecipient = await resolveRecipient('IT_HOD', { location: request.location, requestId: request.id });
            await request.update({
                status: 'PendingITHOD',
                dciRemarks: remarks,
                currentStageToken: newToken,
                currentStageAssigneeEmail:    itHodRecipient.email    || null,
                currentStageAssigneeUsername: itHodRecipient.username || null,
                dciManagerDecidedAt: new Date()
            });
            await logTimelineEvent(request.id, 'DCI Manager Approved (High Risk)', 'DCIManager', remarks);
            await sendStageEmail(itHodRecipient.email, request, newToken, 'IT_HOD_APPROVAL');
        } else {
            // Move to Implementation Phase
            const newToken = crypto.randomBytes(20).toString('hex');
            const implRecipient = await resolveRecipient('DCI_IMPLEMENTER', { location: request.location, requestId: request.id });
            await request.update({
                status: 'PendingDCIImplementation',
                approvalStatus: 'Approved',
                dciRemarks: remarks,
                currentStageToken: newToken,
                currentStageAssigneeEmail:    implRecipient.email    || null,
                currentStageAssigneeUsername: implRecipient.username || null,
                dciManagerDecidedAt: new Date()
            });
            await logTimelineEvent(request.id, 'DCI Manager Approved', 'DCIManager', remarks);
            await generateAndStorePDF(request); // PDF serves as Work Order
            await sendStageEmail(implRecipient.email, request, newToken, 'DCI_IMPLEMENTATION');
        }
        return request;
    } catch (err) {
        logger.error(`[Onboarding] DCI Manager Error: ${err.message}`);
        throw err;
    }
};

export const handleITHODApproval = async (token, action, remarks = null) => {
    logger.info(`[Onboarding] IT HOD Approval`);
    try {
        const request = await OnboardingRequest.findOne({ where: { currentStageToken: token } });
        if (!request || request.status !== 'PendingITHOD') throw new Error('Invalid Token');

        if (action === 'Reject') {
            await request.update({
                status: 'Rejected',
                approvalStatus: 'Rejected',
                itHodRemarks: remarks,
                currentStageToken: null,
                currentStageAssigneeEmail: null,
                currentStageAssigneeUsername: null,
                itHodDecidedAt: new Date()
            });
            await logTimelineEvent(request.id, 'IT HOD Rejected', 'ITHOD', remarks);
            return request;
        }

        // Approve -> Move to Implementation
        const newToken = crypto.randomBytes(20).toString('hex');
        const implRecipient = await resolveRecipient('DCI_IMPLEMENTER', { location: request.location, requestId: request.id });
        await request.update({
            status: 'PendingDCIImplementation',
            approvalStatus: 'Approved',
            itHodRemarks: remarks,
            currentStageToken: newToken,
            currentStageAssigneeEmail:    implRecipient.email    || null,
            currentStageAssigneeUsername: implRecipient.username || null,
            itHodDecidedAt: new Date()
        });
        await logTimelineEvent(request.id, 'IT HOD Approved', 'ITHOD', remarks);
        await generateAndStorePDF(request);
        await sendStageEmail(implRecipient.email, request, newToken, 'DCI_IMPLEMENTATION');

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
        // Per client requirement: the IT Ops user who handled Step 2 is also
        // responsible for Step 12 (post-desk-setup verification), so routing
        // for OPS verification uses IT_OPS — not a separate OPS_TEAM group.
        const opsRecipient = await resolveRecipient('IT_OPS', { location: request.location, requestId: request.id });
        await request.update({
            status: 'PendingOPSAction',
            dciImplementer: implementerName,
            dciProofAttachments: filePaths, // Array of strings
            dciImplementedAt: new Date(),
            currentStageToken: newToken,
            currentStageAssigneeEmail:    opsRecipient.email    || null,
            currentStageAssigneeUsername: opsRecipient.username || null
        });
        await logTimelineEvent(request.id, 'DCI Implementation Completed', 'DCIImplementer', `Implemented by ${implementerName}`);
        await sendStageEmail(opsRecipient.email, request, newToken, 'OPS_ACTION');
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
            currentStageToken: null, // Flow Ends
            currentStageAssigneeEmail: null
        });
        await logTimelineEvent(request.id, 'OPS Checklist Completed', 'OPS', JSON.stringify(checklistData));
        logger.info(`[Onboarding] Request ${request.id} COMPLETED.`);

        // Final completion notification to configurable recipients (DCI + OPS managers)
        await sendCompletionNotification(request).catch(err => {
            logger.error(`[Onboarding] Completion email failed (non-fatal): ${err.message}`);
        });

        return request;
    } catch (err) {
        logger.error(`[Onboarding] OPS Error: ${err.message}`);
        throw err;
    }
};

/**
 * Send final completion notification to admin-configured recipient list.
 * Recipients are stored in SystemConfig under key `completion_notification_recipients`.
 * Falls back to DCI_MANAGER + IT_OPS recipients if not configured.
 */
const sendCompletionNotification = async (request) => {
    let recipients = [];

    try {
        const cfg = await SystemConfig.findOne({ where: { key: 'completion_notification_recipients' } });
        const v = cfg ? cfg.value : null;
        if (Array.isArray(v)) {
            recipients = v.map(r => typeof r === 'string' ? r : r?.email).filter(Boolean);
        }
    } catch (e) {
        logger.warn(`[Onboarding] Could not load completion recipients config: ${e.message}`);
    }

    // Fallback: use DCI Manager + IT Operations (which now also covers OPS verification)
    if (recipients.length === 0) {
        const dciMgr = await RecipientService.get('DCI_MANAGER', { location: request.location });
        const itOps = await RecipientService.get('IT_OPS', { location: request.location });
        recipients = [dciMgr, itOps].filter(Boolean);
    }

    if (recipients.length === 0) {
        logger.warn('[Onboarding] No completion recipients configured — skipping notification');
        return;
    }

    const toList = [...new Set(recipients)].join(',');
    const subject = `Onboarding Completed: Request #${request.id} — ${request.fullName}`;
    const body = `Onboarding request #${request.id} for ${request.fullName} (${request.designation || '—'}, ${request.department || '—'}) has been successfully completed by OPS on ${new Date().toLocaleString()}.`;

    try {
        await emailService.sendRequesterNotification(toList, subject, body, {
            requestId: request.id,
            requestType: 'Onboarding',
            status: 'Approved',
            currentStage: 'Completed'
        });
        logger.info(`[Onboarding] Completion notification sent to: ${toList}`);
    } catch (err) {
        logger.error(`[Onboarding] Completion notification error: ${err.message}`);
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
        const initiatorLabel = data.requesterName
            ? `Initiated by ${data.requesterName}${data.requesterEmail ? ' <' + data.requesterEmail + '>' : ''}`
            : 'Initial submission';
        await logTimelineEvent(request.id, 'Request Initiated', 'HR', initiatorLabel);
        const itRecipient = await resolveRecipient('IT_OPS', { location: request.location, requestId: request.id });
        await request.update({
            currentStageAssigneeEmail:    itRecipient.email    || null,
            currentStageAssigneeUsername: itRecipient.username || null
        });
        await sendStageEmail(itRecipient.email, request, token, 'IT_OPS');
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
        const hodRecipient = await resolveRecipient('HOD', { employeeId: request.employeeId, location: request.location });
        await request.update({
            ...data,
            status: 'PendingHOD',
            currentStageToken: newToken,
            currentStageAssigneeEmail:    hodRecipient.email    || null,
            currentStageAssigneeUsername: hodRecipient.username || null,
            itSubmittedAt: new Date()
        });
        await logTimelineEvent(request.id, 'IT Services Configured', 'IT', JSON.stringify(data));
        await sendStageEmail(hodRecipient.email, request, newToken, 'HOD_REVIEW');
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
            await request.update({
                status: 'Rejected',
                approvalStatus: 'Rejected',
                hodRemarks: remarks,
                currentStageToken: null,
                currentStageAssigneeEmail: null,
                currentStageAssigneeUsername: null
            });
            await logTimelineEvent(request.id, 'HOD Rejected', 'HOD', remarks);
            return request;
        }

        const newToken = crypto.randomBytes(20).toString('hex');
        const dciRecipient = await resolveRecipient('DCI_TEAM', { location: request.location, requestId: request.id });
        await request.update({
            status: 'PendingDCI',
            hodRemarks: remarks,
            currentStageToken: newToken,
            currentStageAssigneeEmail:    dciRecipient.email    || null,
            currentStageAssigneeUsername: dciRecipient.username || null,
            hodApprovedAt: new Date()
        });
        await logTimelineEvent(request.id, 'HOD Approved', 'HOD', remarks);
        await sendStageEmail(dciRecipient.email, request, newToken, 'DCI_INPUT');
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
        const dciMgrRecipient = await resolveRecipient('DCI_MANAGER', { location: request.location, requestId: request.id });
        await request.update({
            ...data,
            status: 'PendingDCIManager',
            currentStageToken: newToken,
            currentStageAssigneeEmail:    dciMgrRecipient.email    || null,
            currentStageAssigneeUsername: dciMgrRecipient.username || null,
            dciSubmittedAt: new Date()
        });
        await logTimelineEvent(request.id, 'DCI Configuration Submitted', 'DCI', JSON.stringify(data));
        await sendStageEmail(dciMgrRecipient.email, request, newToken, 'DCI_MANAGER_APPROVAL');
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

        // Email the Work Order PDF to the DCI Manager for record-keeping.
        // CC the IT HOD only if their approval was part of this request.
        try {
            const dciManagerEmail = await RecipientService.get('DCI_MANAGER', { location: request.location });
            const ccList = [];
            if (request.itHodDecidedAt) {
                const itHodEmail = await RecipientService.get('IT_HOD', { location: request.location });
                if (itHodEmail && itHodEmail !== dciManagerEmail) ccList.push(itHodEmail);
            }
            await emailService.sendWorkOrderPDF(dciManagerEmail, request, outputPath, ccList);
            await logTimelineEvent(
                request.id,
                'Work Order PDF Emailed',
                'System',
                `PDF "${filename}" sent to DCI Manager${ccList.length ? ' (cc: ' + ccList.join(', ') + ')' : ''}.`
            );
        } catch (mailErr) {
            // Non-fatal — the workflow continues even if the courtesy email fails
            logger.error(`[Onboarding] Work Order PDF email failed (non-fatal): ${mailErr.message}`);
        }

        return outputPath;
    } catch (err) {
        logger.error(`[Onboarding] PDF Gen Error: ${err.message}`);
    }
};


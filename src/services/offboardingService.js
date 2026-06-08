import crypto from 'crypto';
import OffboardingRequest from '../models/OffboardingRequest.js';
import TimelineEvent from '../models/TimelineEvent.js';
import * as emailService from './emailService.js';
import RecipientService from './recipientService.js';
import HRMSService from './hrmsService.js';
import logger from '../utils/logger.js';

// Map each offboarding email type → the portal slug we want to bounce the
// recipient through. Mirrors EMAIL_TYPE_TO_PORTAL_SLUG in onboardingService.
// The portal slug is responsible for verifying the user's identity, then
// redirecting into /portal/<slug>/view with the matching request expanded.
const OFFBOARDING_TYPE_TO_PORTAL_SLUG = {
    DCI_MANAGER_APPROVAL: 'dci-manager',
    DCI_IMPLEMENTER:      'dci-implementer',
};

// Generic stage-email helper — wraps emailService and logs success/failure.
// Action links route through the portal (matching the onboarding flow per
// Israr's request): click email → /portal/<slug>/enter?action=TOKEN → portal
// dashboard with this request highlighted/expanded → Review & Act opens the
// form. Falls back to the direct form URL only if no portal slug is mapped
// (e.g. completion notifications which are read-only).
const sendStageEmail = async (email, request, token, type) => {
    if (!email) {
        logger.warn(`[Offboarding] No recipient resolved for ${type} (request #${request.id}); skipping email.`);
        return;
    }
    try {
        const base = process.env.APP_URL || 'http://localhost:3000';
        const slug = OFFBOARDING_TYPE_TO_PORTAL_SLUG[type];
        const actionLink = slug
            ? `${base}/portal/${slug}/enter?action=${token}`
            : `${base}/api/offboarding/handle?token=${token}`;
        await emailService.sendOffboardingNotification(email, request, actionLink, type);
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

// Map status → portal role label. Read by getFormContext + the renderForm
// branching in offboardingController.
export const getFormContext = async (token) => {
    if (!token) return null;
    const request = await OffboardingRequest.findOne({ where: { currentStageToken: token } });
    if (!request) return null;

    let role = 'ReadOnly';
    if (request.status === 'PendingDCIManager') role = 'DCIManager';
    if (request.status === 'PendingDCIImplementation') role = 'DCIImplementer';

    return { request, role };
};

// HR or IT Ops initiates an offboarding. The caller (offboardingController)
// has already validated the SSO user is in either the HR_INITIATOR or IT_OPS
// list for the location. The router (DCI Manager) is resolved via the
// standard RecipientService.getWithFallback path so delegation + 2-day
// fallback are honoured automatically.
export const createRequest = async (data, initiator) => {
    logger.info('[Offboarding] Creating new request');
    if (!data.employeeId) throw new Error('Employee ID is required.');

    // Guard: refuse if an active offboarding already exists for this employee.
    const existing = await OffboardingRequest.findOne({
        where: { employeeId: data.employeeId, status: ['Draft', 'PendingDCIManager', 'PendingDCIImplementation'] }
    });
    if (existing) throw new Error('An active offboarding request already exists for this employee.');

    const token = crypto.randomBytes(20).toString('hex');

    // Resolve DCI Manager (honours delegation via getWithFallback).
    const recipient = await RecipientService.getWithFallback('DCI_MANAGER', {
        location: data.location,
        employeeId: data.employeeId,
        requestId: null   // request not created yet — stamped after create
    });

    const request = await OffboardingRequest.create({
        employeeId:   data.employeeId,
        fullName:     data.fullName     || null,
        department:   data.department   || null,
        designation:  data.designation  || null,
        location:     data.location     || null,
        initiatedBy:  initiator && (initiator.email || initiator.username),
        initiatedAt:  new Date(),
        status:       'PendingDCIManager',
        currentStageToken:            token,
        currentStageAssigneeEmail:    recipient.email    || null,
        currentStageAssigneeUsername: recipient.username || null
    });

    const initiatorLabel = initiator
        ? `Initiated by ${initiator.displayName || initiator.username}${initiator.email ? ' <' + initiator.email + '>' : ''}`
        : 'Initial submission';
    await logTimelineEvent(request.id, 'Offboarding Initiated', 'HR', initiatorLabel);

    await sendStageEmail(recipient.email, request, token, 'DCI_MANAGER_APPROVAL');
    return request;
};

// DCI Manager either approves (→ DCI Implementer) or rejects.
export const handleManagerApproval = async (token, action, remarks) => {
    logger.info('[Offboarding] DCI Manager decision');
    const request = await OffboardingRequest.findOne({ where: { currentStageToken: token } });
    if (!request || request.status !== 'PendingDCIManager') throw new Error('Invalid Token');

    if (action === 'Reject') {
        await request.update({
            status: 'Rejected',
            managerRemarks: remarks,
            managerApprovedAt: new Date(),
            currentStageToken: null,
            currentStageAssigneeEmail: null,
            currentStageAssigneeUsername: null,
            delegationEvent: null
        });
        await logTimelineEvent(request.id, 'Offboarding Rejected', 'DCIManager', remarks);
        return request;
    }

    // Approve → forward to DCI Implementer.
    const newToken  = crypto.randomBytes(20).toString('hex');
    const recipient = await RecipientService.getWithFallback('DCI_IMPLEMENTER', {
        location: request.location,
        employeeId: request.employeeId,
        requestId: request.id
    });

    await request.update({
        status:                       'PendingDCIImplementation',
        managerRemarks:               remarks,
        managerApprovedAt:            new Date(),
        currentStageToken:            newToken,
        currentStageAssigneeEmail:    recipient.email    || null,
        currentStageAssigneeUsername: recipient.username || null,
        delegationEvent:              null   // any pending delegation cleared by acting
    });
    await logTimelineEvent(request.id, 'DCI Manager Approved (Offboarding)', 'DCIManager', remarks);
    await sendStageEmail(recipient.email, request, newToken, 'DCI_IMPLEMENTER');
    return request;
};

// DCI Implementer submits the single revocation form. All three booleans
// (adRevoked, smartXRevoked, doorAccessRevoked) must be true. Optional
// notes + proof attachments are persisted. On submit the request flips to
// Completed and the completion notification fires.
export const handleImplementerCompletion = async (token, data, implementerName, proofPaths) => {
    logger.info('[Offboarding] DCI Implementer revocation');
    const request = await OffboardingRequest.findOne({ where: { currentStageToken: token } });
    if (!request || request.status !== 'PendingDCIImplementation') throw new Error('Invalid Token');

    const adRevoked         = !!data.adRevoked;
    const smartXRevoked     = !!data.smartXRevoked;
    const doorAccessRevoked = !!data.doorAccessRevoked;
    if (!adRevoked || !smartXRevoked || !doorAccessRevoked) {
        throw new Error('All three revocations must be confirmed before submitting.');
    }

    await request.update({
        adRevoked,
        smartXRevoked,
        doorAccessRevoked,
        physicalAccessRevoked: doorAccessRevoked,   // legacy mirror
        checklistNotes:        data.checklistNotes || null,
        dciImplementerName:    implementerName,
        dciImplementerCompletedAt: new Date(),
        dciProofAttachments:   Array.isArray(proofPaths) && proofPaths.length ? proofPaths : null,
        status:                'Completed',
        completedAt:           new Date(),
        currentStageToken:            null,
        currentStageAssigneeEmail:    null,
        currentStageAssigneeUsername: null,
        delegationEvent:              null
    });
    await logTimelineEvent(
        request.id,
        'AD/SmartX/Door Revoked',
        'DCIImplementer',
        `By ${implementerName}. AD: true, SmartX: true, Door: true.`
    );
    await logTimelineEvent(request.id, 'Offboarding Completed', 'System', 'All revocations confirmed.');

    await sendCompletionNotification(request).catch(err => {
        logger.error(`[Offboarding] Completion notification failed (non-fatal): ${err.message}`);
    });

    return request;
};

// Final notification to: employee's HOD (resolved from HRMS) + IT HOD.
// No HR HOD per requirements (email 2 supersedes email 1 on that point).
const sendCompletionNotification = async (request) => {
    const recipients = [];

    try {
        const manager = await HRMSService.getManager(request.employeeId);
        if (manager && manager.email) recipients.push(manager.email);
    } catch (e) {
        logger.warn(`[Offboarding] Could not resolve HOD for ${request.employeeId}: ${e.message}`);
    }

    const itHodEmail = await RecipientService.get('IT_HOD', { location: request.location });
    if (itHodEmail) recipients.push(itHodEmail);

    const toList = [...new Set(recipients.filter(Boolean))];
    if (!toList.length) {
        logger.warn(`[Offboarding] No completion recipients resolved for request #${request.id}; skipping.`);
        return;
    }

    try {
        await emailService.sendOffboardingCompletedNotification(toList.join(','), request);
        logger.info(`[Offboarding] Completion notification sent to ${toList.join(', ')}`);
    } catch (err) {
        logger.error(`[Offboarding] Completion notification error: ${err.message}`);
    }
};

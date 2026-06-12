import crypto from 'crypto';
import InternetBrowsingRequest from '../models/InternetBrowsingRequest.js';
import Employee from '../models/Employee.js';
import TimelineEvent from '../models/TimelineEvent.js';
import * as emailService from './emailService.js';
import RecipientService from './recipientService.js';
import HRMSService from './hrmsService.js';
import SystemConfig from '../models/SystemConfig.js';
import { searchUsersByName, findUserByEmployeeIdViaSidecar } from './adService.js';
import { groupKeyForAdOffice, normalizeLoc, LOCATION_GROUPS } from '../utils/locationGroups.js';
import logger from '../utils/logger.js';

const LOCATION_GROUP_KEYS = LOCATION_GROUPS.map(g => g.key);

// Admin-configurable AD office → location-group map (SystemConfig key).
// Shape stored as JSON: { "head office": "HO_FSD", "lahore": "LHR", ... }.
const AD_LOC_MAP_KEY = 'ad_location_group_map';
let _adLocMapCache = null;
let _adLocMapAt = 0;
const AD_LOC_MAP_TTL_MS = 60 * 1000; // re-read at most once a minute

// Load the AD-office → group-key alias map from SystemConfig, normalizing keys.
export const loadAdLocationGroupMap = async () => {
    if (_adLocMapCache && (Date.now() - _adLocMapAt) < AD_LOC_MAP_TTL_MS) return _adLocMapCache;
    let map = {};
    try {
        const cfg = await SystemConfig.findOne({ where: { key: AD_LOC_MAP_KEY } });
        const v = cfg && cfg.value;
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            for (const [k, grp] of Object.entries(v)) map[normalizeLoc(k)] = grp;
        }
    } catch (e) {
        logger.warn(`[IBR] could not load ${AD_LOC_MAP_KEY} from SystemConfig: ${e.message}`);
    }
    _adLocMapCache = map;
    _adLocMapAt = Date.now();
    return map;
};

// Resolve the user's LOCATION GROUP from their AD office (physicalDeliveryOfficeName).
// Returns { adOffice, group }. `group` is null when the office maps to nothing —
// the caller blocks the request in that case (we never fall back to HRMS location).
export const resolveLocationGroupForEmployee = async (employee, ssoUser = {}) => {
    let adOffice = null;
    // Preferred: exact employeeID lookup via the adsearch sidecar.
    try {
        if (employee && employee.employeeId) {
            const rec = await findUserByEmployeeIdViaSidecar(String(employee.employeeId));
            if (rec && rec.office) adOffice = rec.office;
        }
    } catch (e) {
        logger.warn(`[IBR] AD office lookup by employeeId failed: ${e.message}`);
    }
    // Fallback: search by AD username / email and take the matched record's office.
    if (!adOffice) {
        const needle = (ssoUser.username || ssoUser.email || '').trim();
        if (needle.length >= 2) {
            try {
                const results = await searchUsersByName(needle);
                const un = (ssoUser.username || '').toLowerCase();
                const lc = (ssoUser.email || '').toLowerCase();
                const m = results.find(r =>
                    (r.sAMAccountName && r.sAMAccountName.toLowerCase() === un) ||
                    (r.mail && r.mail.toLowerCase() === lc)
                ) || (results.length === 1 ? results[0] : null);
                if (m && m.office) adOffice = m.office;
            } catch (e) {
                logger.warn(`[IBR] AD office fallback search failed: ${e.message}`);
            }
        }
    }

    const aliasMap = await loadAdLocationGroupMap();
    const group = groupKeyForAdOffice(adOffice, aliasMap);
    if (group) {
        logger.info(`[IBR] AD office "${adOffice}" (emp #${employee && employee.employeeId}) → location group ${group}`);
    } else {
        logger.warn(`[IBR] AD office "${adOffice || '∅'}" (emp #${employee && employee.employeeId}) maps to no location group — ` +
            `add it to SystemConfig "${AD_LOC_MAP_KEY}" (one of: ${LOCATION_GROUP_KEYS.join(', ')}).`);
    }
    return { adOffice: adOffice || null, group };
};

// Map each IBR email type → the portal slug we want to bounce the
// recipient through. Mirrors EMAIL_TYPE_TO_PORTAL_SLUG in onboardingService
// and OFFBOARDING_TYPE_TO_PORTAL_SLUG in offboardingService.
//
// HOD_APPROVAL has no portal slug — HODs always act via the emailed direct
// link. The RN Approval stage (IT_OPS_MGR email type) routes to the existing
// IT_OPS team + portal — the same Location Ops / IT Ops pool that handles
// stage 2 validation — per client decision (no separate IT Ops Manager role).
const IBR_TYPE_TO_PORTAL_SLUG = {
    IT_OPS_VALIDATION: 'it-ops',
    HOD_APPROVAL:       null,
    FMS_VALIDATION:    'network-validator',
    IT_OPS_MGR:        'it-ops',
    IT_HOD_APPROVAL:   'it-hod',
    IMPLEMENTATION:    'network-implementer',
};

const ACTIVE_STATUSES = [
    'Draft',
    'PendingITOpsValidation',
    'PendingHOD',
    'PendingFMS',
    'PendingITOpsMgr',
    'PendingITHOD',
    'PendingImplementation'
];

// Generic stage-email helper — wraps emailService and logs success/failure.
// Action links route through the portal when a slug is mapped, falling back
// to the direct form URL when not (e.g. HOD).
const sendStageEmail = async (email, request, token, type) => {
    if (!email) {
        logger.warn(`[IBR] No recipient resolved for ${type} (request #${request.id}); skipping email.`);
        return;
    }
    try {
        const base = process.env.APP_URL || 'http://localhost:3000';
        const slug = IBR_TYPE_TO_PORTAL_SLUG[type];
        const actionLink = slug
            ? `${base}/portal/${slug}/enter?action=${token}`
            : `${base}/api/internet-browsing/handle?token=${token}`;
        await emailService.sendInternetBrowsingNotification(email, request, actionLink, type);
        logger.info(`[IBR] Sent ${type} email to ${email}`);
    } catch (err) {
        logger.error(`[IBR] Failed to send ${type} email: ${err.message}`);
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
        logger.info(`[Timeline] Logged event: ${action} by ${actorRole} for IBR #${requestId}`);
    } catch (err) {
        logger.error(`[Timeline] Error logging event: ${err.message}`);
    }
};

// Map status → role label. Read by getFormContext + the renderForm
// branching in internetBrowsingController.
export const getFormContext = async (token) => {
    if (!token) return null;
    const request = await InternetBrowsingRequest.findOne({ where: { currentStageToken: token } });
    if (!request) return null;

    let role = 'ReadOnly';
    if (request.status === 'PendingITOpsValidation') role = 'ITOps';
    else if (request.status === 'PendingHOD')        role = 'HOD';
    else if (request.status === 'PendingFMS')        role = 'FMS';
    else if (request.status === 'PendingITOpsMgr')   role = 'ITOpsMgr';
    else if (request.status === 'PendingITHOD')      role = 'ITHOD';
    else if (request.status === 'PendingImplementation') role = 'NetworkImplementer';

    return { request, role };
};

// Look up the requesting employee in our local Employee table by SSO email,
// falling back to a case-insensitive match if the obvious where: { email }
// misses (Oracle sync sometimes capitalises domain parts inconsistently).
export const lookupEmployeeByEmail = async (email) => {
    if (!email) return null;
    let row = await Employee.findOne({ where: { email } });
    if (row) return row;
    const all = await Employee.findAll();
    const lower = String(email).toLowerCase();
    return all.find(e => (e.email || '').toLowerCase() === lower) || null;
};

// Resolve the requesting employee from the SSO identity.
//
// The SSO email comes from Active Directory and frequently differs from the
// HRMS/DB email (e.g. ad: israr.haq@igc.com.pk vs hrms: israr.haq@ifl.net), so
// an email match alone misses. The stable key shared by AD and the DB is the
// Employee Number. We therefore:
//   1) try a direct DB email match (cheap; works when the two emails agree), then
//   2) pivot on the Employee Number — resolve the AD account's `employeeID`
//      attribute via the adsearch.aspx sidecar (the same proven path used by the
//      360° profile / approver lookups) and load the DB row by that number.
//
// `ssoUser` is req.user — { username (sAMAccountName), email, ... }.
export const resolveInitiatorEmployee = async (ssoUser) => {
    if (!ssoUser) return null;
    const email = (ssoUser.email || '').trim();
    const uname = (ssoUser.username || '').trim();

    // 1) Exact DB email (AD email == HRMS email).
    let row = email ? await Employee.findOne({ where: { email } }) : null;
    if (row) { logger.info(`[IBR] initiator matched by DB email: ${email} → #${row.employeeId}`); return row; }

    // Load the table once for the in-memory, case-insensitive joins below.
    const all = await Employee.findAll();

    // 2) erpUser == AD sAMAccountName — the ERP login usually IS the AD login,
    //    so this is a direct DB join with no AD round-trip (most reliable).
    if (uname) {
        const un = uname.toLowerCase();
        const byErp = all.find(e => (e.erpUser || '').toLowerCase() === un);
        if (byErp) { logger.info(`[IBR] initiator matched by erpUser="${uname}" → #${byErp.employeeId}`); return byErp; }
    }

    // 3) Same email local-part, different domain — the exact AD↔HRMS domain
    //    split (israr.haq@igc.com.pk vs israr.haq@ifl.net). Accept only when it
    //    is unambiguous so we never bind to the wrong person.
    const localPart = email.split('@')[0].toLowerCase();
    if (localPart) {
        const matches = all.filter(e => (e.email || '').split('@')[0].toLowerCase() === localPart);
        if (matches.length === 1) {
            logger.info(`[IBR] initiator matched by email local-part "${localPart}" → #${matches[0].employeeId}`);
            return matches[0];
        }
        if (matches.length > 1) {
            logger.warn(`[IBR] email local-part "${localPart}" matched ${matches.length} employees — ambiguous, skipping`);
        }
    }

    logger.info(`[IBR] no DB email/erpUser/local-part match for "${email}" (user=${uname || '∅'}); pivoting on Employee Number via AD…`);

    // Try both the AD username (sAMAccountName) and the email as adsearch needles
    // — whichever finds the account first wins.
    const needles = [ssoUser.username, ssoUser.email].map(s => (s || '').trim()).filter(s => s.length >= 2);
    const un = (ssoUser.username || '').toLowerCase();
    const lc = (ssoUser.email || '').toLowerCase();

    let employeeId = null;
    for (const needle of needles) {
        try {
            const results = await searchUsersByName(needle);
            logger.info(`[IBR] adsearch("${needle}") → ${results.length} result(s): ` +
                (results.map(r => `${r.sAMAccountName || '?'}|${r.mail || '?'}|empID=${r.employeeID || '∅'}`).join('  ') || '(none)'));
            const match = results.find(r =>
                (r.sAMAccountName && r.sAMAccountName.toLowerCase() === un) ||
                (r.mail && r.mail.toLowerCase() === lc)
            ) || (results.length === 1 ? results[0] : null);
            if (match && match.employeeID) {
                employeeId = String(match.employeeID).trim();
                logger.info(`[IBR] AD match: ${match.sAMAccountName || '?'} → employeeID=${employeeId}`);
                break;
            }
            if (match) logger.warn(`[IBR] AD matched ${match.sAMAccountName || '?'} but its employeeID attribute is EMPTY — cannot pivot.`);
        } catch (e) {
            logger.warn(`[IBR] adsearch("${needle}") failed: ${e.message}`);
        }
    }

    if (employeeId) {
        const byId = await Employee.findByPk(employeeId);
        if (byId) {
            logger.info(`[IBR] Resolved ${ssoUser.email || un} → employee #${employeeId} via AD employee-number pivot`);
            return byId;
        }
        logger.warn(`[IBR] AD gave employeeID="${employeeId}" but no DB Employee row has that primary key (number/format mismatch?).`);
    } else {
        logger.warn(`[IBR] Could not derive an Employee Number from AD for user="${ssoUser.username || ssoUser.email}".`);
    }
    return null;
};

// Stage 1: employee self-initiates. The caller (controller) has already
// resolved the employee record + snapshotted the auto-collected fields onto
// `data`. We just persist the row, log it, and dispatch the IT Ops email.
export const createRequest = async (data, initiator) => {
    logger.info('[IBR] Creating new request');
    if (!data.employeeId) throw new Error('Employee record could not be resolved for your SSO identity.');
    if (!data.ntLogin) throw new Error('NT Login is required.');
    if (!data.userType) throw new Error('User Type is required.');
    if (!data.facilityDuration) throw new Error('Facility Duration is required.');
    if (!data.browsingRights) throw new Error('Browsing Rights is required.');

    // Guard: refuse if an active IBR already exists for this employee.
    const existing = await InternetBrowsingRequest.findOne({
        where: { employeeId: data.employeeId, status: ACTIVE_STATUSES }
    });
    if (existing) throw new Error('An active Internet Browsing Request already exists for this employee.');

    const token = crypto.randomBytes(20).toString('hex');

    // Route IT-Ops validation by the AD-derived LOCATION GROUP — never the HRMS
    // location. The controller resolves data.locationGroup from the AD office and
    // blocks initiation when it can't be mapped, so a group key is expected here.
    if (!data.locationGroup) {
        throw new Error('Your location could not be mapped to a location group, so the request cannot be routed to IT Operations. Please contact IT.');
    }
    const recipient = await RecipientService.getWithFallback('IT_OPS', {
        location:   data.locationGroup,
        employeeId: data.employeeId,
        requestId:  null
    });

    const request = await InternetBrowsingRequest.create({
        employeeId:       data.employeeId,
        fullName:         data.fullName || null,
        joiningDate:      data.joiningDate || null,
        department:       data.department || null,
        designation:      data.designation || null,
        location:         data.locationGroup,       // group key, for routing/history
        adOffice:         data.adOffice || null,    // raw AD office, for audit
        extension:        data.extension || null,
        contactNumber:    data.contactNumber || null,
        hod:              data.hod || null,
        hodEmail:         data.hodEmail || null,
        email:            data.email || null,
        userType:         data.userType,
        ntLogin:          data.ntLogin,
        facilityDuration: data.facilityDuration,
        browsingRights:   data.browsingRights,
        initiatedBy:      initiator && (initiator.email || initiator.username),
        initiatedAt:      new Date(),
        status:           'PendingITOpsValidation',
        currentStageToken:            token,
        currentStageAssigneeEmail:    recipient.email    || null,
        currentStageAssigneeUsername: recipient.username || null
    });

    const initiatorLabel = initiator
        ? `Initiated by ${initiator.displayName || initiator.username}${initiator.email ? ' <' + initiator.email + '>' : ''}`
        : 'Self-initiated';
    await logTimelineEvent(request.id, 'IBR Initiated', 'Employee', initiatorLabel);

    await sendStageEmail(recipient.email, request, token, 'IT_OPS_VALIDATION');
    return request;
};

// Stage 2: Location Ops / IT Ops validation.
export const handleITOpsValidation = async (token, action, remarks) => {
    logger.info('[IBR] IT Ops validation');
    const request = await InternetBrowsingRequest.findOne({ where: { currentStageToken: token } });
    if (!request || request.status !== 'PendingITOpsValidation') throw new Error('Invalid Token');

    if (action === 'Reject') {
        await request.update({
            status: 'Rejected',
            itOpsRemarks: remarks,
            itOpsValidatedAt: new Date(),
            currentStageToken: null,
            currentStageAssigneeEmail: null,
            currentStageAssigneeUsername: null,
            delegationEvent: null
        });
        await logTimelineEvent(request.id, 'IBR Rejected by IT Ops', 'ITOps', remarks);
        return request;
    }

    const newToken = crypto.randomBytes(20).toString('hex');
    // Stage 3 → HOD. We snapshotted hodEmail at initiation; prefer that.
    let hodEmail = request.hodEmail;
    let hodName  = request.hod || '';
    if (!hodEmail) {
        const mgr = await HRMSService.getManager(request.employeeId);
        if (mgr && mgr.email) { hodEmail = mgr.email; hodName = mgr.name || hodName; }
    }

    await request.update({
        status: 'PendingHOD',
        itOpsRemarks: remarks,
        itOpsValidatedAt: new Date(),
        currentStageToken: newToken,
        currentStageAssigneeEmail: hodEmail || null,
        currentStageAssigneeUsername: null,
        delegationEvent: null
    });
    await logTimelineEvent(request.id, 'IBR IT Ops Approved', 'ITOps', remarks);
    await sendStageEmail(hodEmail, request, newToken, 'HOD_APPROVAL');
    return request;
};

// Stage 3: Employee HOD approval.
export const handleHODApproval = async (token, action, remarks) => {
    logger.info('[IBR] HOD approval');
    const request = await InternetBrowsingRequest.findOne({ where: { currentStageToken: token } });
    if (!request || request.status !== 'PendingHOD') throw new Error('Invalid Token');

    if (action === 'Reject') {
        await request.update({
            status: 'Rejected',
            hodRemarks: remarks,
            hodApprovedAt: new Date(),
            currentStageToken: null,
            currentStageAssigneeEmail: null,
            currentStageAssigneeUsername: null,
            delegationEvent: null
        });
        await logTimelineEvent(request.id, 'IBR Rejected by HOD', 'HOD', remarks);
        return request;
    }

    const newToken = crypto.randomBytes(20).toString('hex');
    const recipient = await RecipientService.getWithFallback('NETWORK_VALIDATOR', {
        employeeId: request.employeeId,
        requestId:  request.id
    });

    await request.update({
        status: 'PendingFMS',
        hodRemarks: remarks,
        hodApprovedAt: new Date(),
        currentStageToken: newToken,
        currentStageAssigneeEmail: recipient.email    || null,
        currentStageAssigneeUsername: recipient.username || null,
        delegationEvent: null
    });
    await logTimelineEvent(request.id, 'IBR HOD Approved', 'HOD', remarks);
    await sendStageEmail(recipient.email, request, newToken, 'FMS_VALIDATION');
    return request;
};

// Stage 4: FMS / Network Validator.
export const handleFMSValidation = async (token, action, remarks) => {
    logger.info('[IBR] FMS validation');
    const request = await InternetBrowsingRequest.findOne({ where: { currentStageToken: token } });
    if (!request || request.status !== 'PendingFMS') throw new Error('Invalid Token');

    if (action === 'Reject') {
        await request.update({
            status: 'Rejected',
            fmsRemarks: remarks,
            fmsValidatedAt: new Date(),
            currentStageToken: null,
            currentStageAssigneeEmail: null,
            currentStageAssigneeUsername: null,
            delegationEvent: null
        });
        await logTimelineEvent(request.id, 'IBR Rejected by FMS', 'FMS', remarks);
        return request;
    }

    const newToken = crypto.randomBytes(20).toString('hex');
    // RN Approval routes to the existing IT_OPS team (location-aware), not a
    // separate IT Ops Manager role.
    const recipient = await RecipientService.getWithFallback('IT_OPS', {
        location:   request.location,
        employeeId: request.employeeId,
        requestId:  request.id
    });

    await request.update({
        status: 'PendingITOpsMgr',
        fmsRemarks: remarks,
        fmsValidatedAt: new Date(),
        currentStageToken: newToken,
        currentStageAssigneeEmail: recipient.email    || null,
        currentStageAssigneeUsername: recipient.username || null,
        delegationEvent: null
    });
    await logTimelineEvent(request.id, 'IBR FMS Approved', 'FMS', remarks);
    await sendStageEmail(recipient.email, request, newToken, 'IT_OPS_MGR');
    return request;
};

// Stage 5: RN (IT Operations Manager).
export const handleITOpsMgrApproval = async (token, action, remarks) => {
    logger.info('[IBR] IT Ops Mgr approval');
    const request = await InternetBrowsingRequest.findOne({ where: { currentStageToken: token } });
    if (!request || request.status !== 'PendingITOpsMgr') throw new Error('Invalid Token');

    if (action === 'Reject') {
        await request.update({
            status: 'Rejected',
            itOpsMgrRemarks: remarks,
            itOpsMgrApprovedAt: new Date(),
            currentStageToken: null,
            currentStageAssigneeEmail: null,
            currentStageAssigneeUsername: null,
            delegationEvent: null
        });
        await logTimelineEvent(request.id, 'IBR Rejected by IT Ops Mgr', 'ITOpsMgr', remarks);
        return request;
    }

    const newToken = crypto.randomBytes(20).toString('hex');
    const recipient = await RecipientService.getWithFallback('IT_HOD', {
        employeeId: request.employeeId,
        requestId:  request.id
    });

    await request.update({
        status: 'PendingITHOD',
        itOpsMgrRemarks: remarks,
        itOpsMgrApprovedAt: new Date(),
        currentStageToken: newToken,
        currentStageAssigneeEmail: recipient.email    || null,
        currentStageAssigneeUsername: recipient.username || null,
        delegationEvent: null
    });
    await logTimelineEvent(request.id, 'IBR IT Ops Mgr Approved', 'ITOpsMgr', remarks);
    await sendStageEmail(recipient.email, request, newToken, 'IT_HOD_APPROVAL');
    return request;
};

// Stage 6: UZ (IT HOD).
export const handleITHODApproval = async (token, action, remarks) => {
    logger.info('[IBR] IT HOD approval');
    const request = await InternetBrowsingRequest.findOne({ where: { currentStageToken: token } });
    if (!request || request.status !== 'PendingITHOD') throw new Error('Invalid Token');

    if (action === 'Reject') {
        await request.update({
            status: 'Rejected',
            itHodRemarks: remarks,
            itHodApprovedAt: new Date(),
            currentStageToken: null,
            currentStageAssigneeEmail: null,
            currentStageAssigneeUsername: null,
            delegationEvent: null
        });
        await logTimelineEvent(request.id, 'IBR Rejected by IT HOD', 'ITHOD', remarks);
        return request;
    }

    const newToken = crypto.randomBytes(20).toString('hex');
    const recipient = await RecipientService.getWithFallback('NETWORK_IMPLEMENTER', {
        employeeId: request.employeeId,
        requestId:  request.id
    });

    await request.update({
        status: 'PendingImplementation',
        itHodRemarks: remarks,
        itHodApprovedAt: new Date(),
        currentStageToken: newToken,
        currentStageAssigneeEmail: recipient.email    || null,
        currentStageAssigneeUsername: recipient.username || null,
        delegationEvent: null
    });
    await logTimelineEvent(request.id, 'IBR IT HOD Approved', 'ITHOD', remarks);
    await sendStageEmail(recipient.email, request, newToken, 'IMPLEMENTATION');
    return request;
};

// Stage 7: Network Implementer applies the change.
export const handleImplementerCompletion = async (token, data, implementerName, proofPaths) => {
    logger.info('[IBR] Network Implementer completion');
    const request = await InternetBrowsingRequest.findOne({ where: { currentStageToken: token } });
    if (!request || request.status !== 'PendingImplementation') throw new Error('Invalid Token');

    const confirmed = !!data.confirmed;
    if (!confirmed) {
        throw new Error('You must confirm that the change has been applied before submitting.');
    }

    await request.update({
        implementerNotes:              data.implementerNotes || null,
        networkImplementerName:        implementerName,
        networkImplementerCompletedAt: new Date(),
        proofAttachments:              Array.isArray(proofPaths) && proofPaths.length ? proofPaths : null,
        status:                        'Completed',
        completedAt:                   new Date(),
        currentStageToken:            null,
        currentStageAssigneeEmail:    null,
        currentStageAssigneeUsername: null,
        delegationEvent:              null
    });
    await logTimelineEvent(
        request.id,
        'IBR Implementation Applied',
        'NetworkImplementer',
        `By ${implementerName}.${data.implementerNotes ? ' Notes: ' + data.implementerNotes : ''}`
    );
    await logTimelineEvent(request.id, 'IBR Completed', 'System', 'Internet browsing rights applied.');

    await sendCompletionNotification(request).catch(err => {
        logger.error(`[IBR] Completion notification failed (non-fatal): ${err.message}`);
    });

    return request;
};

// Final notification — courtesy email to the requesting employee + their
// HOD + IT HOD. No action link.
const sendCompletionNotification = async (request) => {
    const recipients = [];
    if (request.email)    recipients.push(request.email);
    if (request.hodEmail) recipients.push(request.hodEmail);

    const itHodEmail = await RecipientService.get('IT_HOD', { location: request.location });
    if (itHodEmail) recipients.push(itHodEmail);

    const toList = [...new Set(recipients.filter(Boolean))];
    if (!toList.length) {
        logger.warn(`[IBR] No completion recipients resolved for request #${request.id}; skipping.`);
        return;
    }

    try {
        await emailService.sendIBRCompletionNotification(toList.join(','), request);
        logger.info(`[IBR] Completion notification sent to ${toList.join(', ')}`);
    } catch (err) {
        logger.error(`[IBR] Completion notification error: ${err.message}`);
    }
};

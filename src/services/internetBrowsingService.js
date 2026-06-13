import crypto from 'crypto';
import InternetBrowsingRequest from '../models/InternetBrowsingRequest.js';
import Employee from '../models/Employee.js';
import TimelineEvent from '../models/TimelineEvent.js';
import * as emailService from './emailService.js';
import RecipientService from './recipientService.js';
import HRMSService from './hrmsService.js';
import SystemConfig from '../models/SystemConfig.js';
import { searchUsersByName, findUserByEmployeeIdViaSidecar, findUserByLoginViaSidecar } from './adService.js';
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
    let adEmail = null;
    let adTelephoneNumber = null;
    let adMobile = null;
    // Preferred: exact employeeID lookup via the adsearch sidecar.
    try {
        if (employee && employee.employeeId) {
            const rec = await findUserByEmployeeIdViaSidecar(String(employee.employeeId));
            if (rec) {
                if (rec.office) adOffice = rec.office;
                adEmail = rec.mail || rec.email || null;
                adTelephoneNumber = rec.telephoneNumber || null;
                adMobile = rec.mobile || null;
            }
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
                if (m) {
                    if (m.office) adOffice = m.office;
                    if (!adEmail) adEmail = m.mail || m.email || null;
                    if (!adTelephoneNumber) adTelephoneNumber = m.telephoneNumber || null;
                    if (!adMobile) adMobile = m.mobile || null;
                }
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
    return { adOffice: adOffice || null, group, adEmail, adTelephoneNumber, adMobile };
};

// Preview the IT-Ops validator a group routes to (for display on the initiate
// form so the employee sees exactly which IT-Ops location handles their request).
// Uses the SAME resolver as createRequest, so the preview matches the real routing.
export const getItOpsValidatorForGroup = async (groupKey, employeeId) => {
    if (!groupKey) return null;
    try {
        const r = await RecipientService.getWithFallback('IT_OPS', { location: groupKey, employeeId, requestId: null });
        return { name: (r && r.name) || '', email: (r && r.email) || '' };
    } catch (e) {
        logger.warn(`[IBR] preview IT_OPS validator for ${groupKey} failed: ${e.message}`);
        return null;
    }
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
    IT_OPS_MGR:        'it-ops-mgr',
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
    const uname = (ssoUser.username || '').trim();   // sAMAccountName from the reverse-proxy SSO
    const email = (ssoUser.email || '').trim();      // logged for diagnostics only — NEVER matched

    // Resolve the logged-in user's AD account ONCE from their NT login name.
    // The reverse proxy hands us the sAMAccountName; the AD account carries the
    // employeeID attribute, which is the SAME key as the Employee table's primary
    // key. We deliberately DO NOT match on email — the AD email and the HRMS/DB
    // email are different addresses, so an email match is unreliable.
    //
    // Use the sidecar `?login=` mode (primary-domain LDAP first) — the Global
    // Catalog does NOT replicate employeeID, so a plain ?q= name search returns
    // the account with an EMPTY employeeID. The login mode guarantees employeeID,
    // exactly like the 360° profile's employeeId pivot. Fall back to ?q= search
    // only to recover a displayName for the name-based fallback below.
    let adAcct = null;
    if (uname) {
        try {
            adAcct = await findUserByLoginViaSidecar(uname);
        } catch (e) {
            logger.warn(`[IBR] AD login lookup for "${uname}" failed: ${e.message}`);
        }
        if (!adAcct) {
            try {
                const results = await searchUsersByName(uname);
                adAcct = results.find(r => r.sAMAccountName && r.sAMAccountName.toLowerCase() === uname.toLowerCase())
                       || (results.length === 1 ? results[0] : null);
            } catch (e) {
                logger.warn(`[IBR] AD name lookup for "${uname}" failed: ${e.message}`);
            }
        }
        logger.info(`[IBR] AD account for "${uname}": ` +
            (adAcct ? `${adAcct.sAMAccountName}|empID=${adAcct.employeeID || '∅'}` : '(none found)'));
    }

    // PRIMARY — the employeeID on the logged-in AD account IS the Employee PK.
    if (adAcct && adAcct.employeeID) {
        const empId = String(adAcct.employeeID).trim();
        const row = await Employee.findByPk(empId);
        if (row) { logger.info(`[IBR] initiator resolved via AD employeeID: ${uname} → #${empId}`); return row; }
        logger.warn(`[IBR] AD employeeID="${empId}" has no matching Employee row (format mismatch?)`);
    }

    // Load the table once for the username/name fallbacks below.
    const all = await Employee.findAll();

    // FALLBACK 1 — erpUser column == AD login (DB-only, no AD round-trip). Covers
    // accounts whose AD employeeID attribute hasn't been set.
    if (uname) {
        const un = uname.toLowerCase();
        const byErp = all.find(e => (e.erpUser || '').toLowerCase() === un);
        if (byErp) { logger.info(`[IBR] initiator matched by erpUser="${uname}" → #${byErp.employeeId}`); return byErp; }
    }

    // FALLBACK 2 — AD displayName == Employee.name (unambiguous only), for
    // accounts that carry neither an employeeID attribute nor an erpUser row.
    const adName = (adAcct && (adAcct.displayName || adAcct.name) || '').trim().toLowerCase();
    if (adName.length >= 3) {
        const byName = all.filter(e => (e.name || '').toLowerCase() === adName);
        if (byName.length === 1) {
            logger.info(`[IBR] initiator resolved via AD displayName: ${uname} → #${byName[0].employeeId}`);
            return byName[0];
        }
        if (byName.length > 1) {
            logger.warn(`[IBR] AD displayName "${adAcct.displayName}" matched ${byName.length} employees — ambiguous, skipping`);
        }
    }

    logger.warn(`[IBR] could not resolve initiator for username="${uname}" email="${email}"`);
    return null;
};

// Stage 1: employee self-initiates. The caller (controller) has already
// resolved the employee record + snapshotted the auto-collected fields onto
// `data`. We just persist the row, log it, and dispatch the IT Ops email.
export const createRequest = async (data, initiator) => {
    logger.info('[IBR] Creating new request');
    if (!data.employeeId) throw new Error('Employee record could not be resolved for your SSO identity.');
    if (!data.ntLogin) throw new Error('NT Login could not be determined from your AD account.');
    // User Type / Facility Duration / Browsing Rights are NO LONGER entered by the
    // requester — the IT-Ops validator sets them at stage 2. We persist empty
    // placeholders here (the columns are NOT NULL) and they get filled on approval.

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
        extension:          data.extension || null,
        contactNumber:      data.contactNumber || null,
        hod:                data.hod || null,
        hodEmail:           data.hodEmail || null,
        email:              data.email || null,
        requirementDetails: (data.requirementDetails || '').trim() || null,
        ntLogin:            data.ntLogin,
        userType:           data.userType || '',          // set by IT-Ops at stage 2
        facilityDuration:   data.facilityDuration || '',  // set by IT-Ops at stage 2
        browsingRights:     data.browsingRights || '',     // set by IT-Ops at stage 2
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

// Stage 2: Location Ops / IT Ops validation. The IT-Ops validator now ALSO sets
// the rights selection (User Type / NT Login / Facility Duration / Browsing
// Rights) — the requester no longer enters these at initiation.
export const handleITOpsValidation = async (token, action, remarks, fields = {}) => {
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

    // Approve — the IT-Ops validator must have set the rights selection.
    const ntLogin              = (fields.ntLogin || '').trim();
    const userType             = (fields.userType || '').trim();
    const facilityDuration     = (fields.facilityDuration || '').trim();
    const browsingRights       = (fields.browsingRights || '').trim();
    const specificSites        = (fields.specificSites || '').trim();
    const facilityDurationDays = fields.facilityDurationDays ? parseInt(fields.facilityDurationDays, 10) : null;

    if (!ntLogin || !userType || !facilityDuration || !browsingRights) {
        throw new Error('Set NT Login, User Type, Facility Duration and Browsing Rights before approving.');
    }
    if (facilityDuration === 'OneTime' && (!facilityDurationDays || facilityDurationDays < 1)) {
        throw new Error('Enter the number of days for the One Time access duration before approving.');
    }
    if (browsingRights === 'SpecificSites' && !specificSites) {
        throw new Error('Enter the specific site URLs before approving.');
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
        ntLogin,
        userType,
        facilityDuration,
        facilityDurationDays: facilityDuration === 'OneTime' ? facilityDurationDays : null,
        browsingRights,
        specificSites: browsingRights === 'SpecificSites' ? specificSites : null,
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
    const recipient = await RecipientService.getWithFallback('IT_OPS_MGR', {
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

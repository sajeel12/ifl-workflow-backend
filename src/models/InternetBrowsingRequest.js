import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';

// Internet Browsing Request (IBR)
//
// Self-service request the employee themselves opens to ask for internet
// access on their AD account. Runs through a six-stage chain before an
// implementer applies the proxy/firewall change:
//
//   1. Employee initiates                  → PendingITOpsValidation
//   2. Location Ops / IT Ops validation    → PendingHOD
//   3. Employee HOD approval               → PendingFMS
//   4. FMS validation (Network Validator)  → PendingITOpsMgr
//   5. RN approval (IT Operations Manager) → PendingITHOD
//   6. UZ approval (IT HOD)                → PendingImplementation
//   7. Network Implementer applies         → Completed
//
// Schema mirrors OffboardingRequest for the workflow plumbing
// (currentStageToken / currentStageAssigneeEmail / delegationEvent etc.)
// so the existing portal queue, delegation, and timeline machinery work
// against this table without special-casing.
const InternetBrowsingRequest = sequelize.define('InternetBrowsingRequest', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },

    // ─── Workflow / system fields ─────────────────────────────────────────
    status: {
        // 'Draft' | 'PendingITOpsValidation' | 'PendingHOD' | 'PendingFMS' |
        // 'PendingITOpsMgr' | 'PendingITHOD' | 'PendingImplementation' |
        // 'Completed' | 'Rejected'
        type: DataTypes.STRING,
        defaultValue: 'Draft'
    },
    currentStageToken:            { type: DataTypes.STRING, allowNull: true },
    currentStageAssigneeEmail:    { type: DataTypes.STRING, allowNull: true },
    currentStageAssigneeUsername: { type: DataTypes.STRING, allowNull: true },
    // { delegatedAt, delegatedFromEmail, delegatedToEmail, originalAssigneeEmail }
    // Cleared on any stage transition or auto-revert.
    delegationEvent: { type: DataTypes.JSON, allowNull: true },

    // SSO email/username of the employee who initiated the request.
    initiatedBy: { type: DataTypes.STRING },
    initiatedAt: { type: DataTypes.DATE },
    completedAt: { type: DataTypes.DATE },

    // ─── Auto-collected employee fields ───────────────────────────────────
    // Filled at initiation time from HRMSService.getEmployee(req.user.username)
    // + req.user. Snapshotted onto the row so a later HRMS sync drift can't
    // change what the approvers see / what the implementer is acting on.
    employeeId:    { type: DataTypes.STRING, allowNull: false },
    fullName:      { type: DataTypes.STRING },
    joiningDate:   { type: DataTypes.DATEONLY },
    department:    { type: DataTypes.STRING },
    designation:   { type: DataTypes.STRING },
    // Location group key (e.g. 'LHR', 'HO_FSD') — also drives IT_OPS routing.
    location:      { type: DataTypes.STRING, allowNull: true },
    // Raw AD office (physicalDeliveryOfficeName) the location group was derived
    // from — kept for audit / to help extend the ad_location_group_map.
    adOffice:      { type: DataTypes.STRING, allowNull: true },
    extension:     { type: DataTypes.STRING },
    contactNumber: { type: DataTypes.STRING },
    hod:           { type: DataTypes.STRING }, // display name only
    // Snapshot of the HOD email captured at initiation so the stage-3 email
    // still goes to the right person even if HRMS sync changes later.
    hodEmail:      { type: DataTypes.STRING },
    email:         { type: DataTypes.STRING },

    // ─── Initiator-entered fields ─────────────────────────────────────────
    userType: {
        // 'New' | 'Existing'
        type: DataTypes.STRING,
        allowNull: false
    },
    ntLogin: { type: DataTypes.STRING, allowNull: false },
    facilityDuration: {
        // 'Permanent' | 'OneTime'
        type: DataTypes.STRING,
        allowNull: false
    },
    browsingRights: {
        // 'GeneralBrowsing' | 'GeneralBrowsingWithStreaming'
        type: DataTypes.STRING,
        allowNull: false
    },

    // ─── Per-stage decision fields ────────────────────────────────────────
    itOpsRemarks:        { type: DataTypes.TEXT },
    itOpsValidatedAt:    { type: DataTypes.DATE },
    hodRemarks:          { type: DataTypes.TEXT },
    hodApprovedAt:       { type: DataTypes.DATE },
    fmsRemarks:          { type: DataTypes.TEXT },
    fmsValidatedAt:      { type: DataTypes.DATE },
    itOpsMgrRemarks:     { type: DataTypes.TEXT },
    itOpsMgrApprovedAt:  { type: DataTypes.DATE },
    itHodRemarks:        { type: DataTypes.TEXT },
    itHodApprovedAt:     { type: DataTypes.DATE },
    networkImplementerName:        { type: DataTypes.STRING },
    networkImplementerCompletedAt: { type: DataTypes.DATE },
    implementerNotes:    { type: DataTypes.TEXT },
    // Stored as JSON array of relative paths under /uploads/
    proofAttachments:    { type: DataTypes.JSON, allowNull: true }
});

export default InternetBrowsingRequest;

import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';

const OnboardingRequest = sequelize.define('OnboardingRequest', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    // Meta Fields
    status: {
        type: DataTypes.STRING, // 'Draft', 'PendingIT', 'PendingDCI', 'Completed', 'Rejected'
        defaultValue: 'Draft'
    },
    currentStageToken: {
        type: DataTypes.STRING,
        allowNull: true
    },
    // Email address the current action link was sent to. Used to validate
    // that the SSO-logged-in user clicking the link is the intended approver
    // (forwarded-email protection). Updated every time currentStageToken
    // rotates. Null on closed/rejected stages.
    currentStageAssigneeEmail: {
        type: DataTypes.STRING,
        allowNull: true
    },
    // AD sAMAccountName of the current stage assignee — unambiguous identity
    // that doesn't break when emails change domains. Set alongside email on
    // every stage transition. Used for gating before email as the primary check.
    currentStageAssigneeUsername: {
        type: DataTypes.STRING,
        allowNull: true
    },

    // Section 1: Requestor Information (HR)
    requesterName: { type: DataTypes.STRING }, // Auto-filled from logged-in initiator
    requesterEmail: { type: DataTypes.STRING },
    employeeId: { type: DataTypes.STRING },
    fullName: { type: DataTypes.STRING },
    department: { type: DataTypes.STRING },
    subDepartment: { type: DataTypes.STRING }, // Sub-department / organizational unit
    designation: { type: DataTypes.STRING },
    joiningDate: { type: DataTypes.DATE },
    officeExtension: { type: DataTypes.STRING },
    homePhone: { type: DataTypes.STRING },
    mobilePhone: { type: DataTypes.STRING },
    requestMode: { type: DataTypes.STRING },
    hod: { type: DataTypes.STRING }, // Head of Department
    location: { type: DataTypes.STRING },

    // Section 2: Services Required (HR)
    intranetAccess: { type: DataTypes.BOOLEAN, defaultValue: false },
    internetAccess: { type: DataTypes.BOOLEAN, defaultValue: false },
    specificWebsites: { type: DataTypes.BOOLEAN, defaultValue: false },
    internetPurpose: { type: DataTypes.TEXT },
    emailIncoming: { type: DataTypes.BOOLEAN, defaultValue: false },
    emailOutgoing: { type: DataTypes.BOOLEAN, defaultValue: false },
    emailPurpose: { type: DataTypes.TEXT },
    laserPrinter: { type: DataTypes.BOOLEAN, defaultValue: false },
    laserPrinterLocation: { type: DataTypes.STRING },
    dotMatrixPrinter: { type: DataTypes.BOOLEAN, defaultValue: false },
    dotMatrixPrinterLocation: { type: DataTypes.STRING },

    // --- Section 3: File Share Services (IT Operations) ---
    deptSharePath: {
        type: DataTypes.STRING,
        allowNull: true
    },
    homeFolderPath: {
        type: DataTypes.STRING,
        allowNull: true
    },
    iflPortalLink: {
        type: DataTypes.STRING,
        allowNull: true
    },
    sharepointRole: {
        type: DataTypes.STRING, // 'Viewer', 'Editor', 'Contributor'
        allowNull: true
    },

    // --- Section 4: DCI Approval & Configuration (DCI) ---
    ntUserName: {
        type: DataTypes.STRING,
        allowNull: true
    },
    exchangeDisplayName: {
        type: DataTypes.STRING,
        allowNull: true
    },
    smtpAddress: {
        type: DataTypes.STRING,
        allowNull: true
    },
    memberOf: {
        type: DataTypes.STRING,
        allowNull: true
    },
    dgMembers: {
        type: DataTypes.STRING,
        allowNull: true
    },
    mailSizeLimit: {
        type: DataTypes.STRING,
        allowNull: true
    },
    recipientLimit: {
        type: DataTypes.STRING,
        allowNull: true
    },
    mailboxStorageLimit: {
        type: DataTypes.STRING,
        allowNull: true
    },
    extraFacility: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    groupPolicyLevel: {
        type: DataTypes.STRING, // 'Highly Managed' | 'Lightly Managed' | 'IT User'
        allowNull: true
    },

    // --- Approvals & Timestamps ---
    hodRemarks: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    dciRemarks: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    itHodRemarks: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    dciChangeRequestRemarks: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    approvalStatus: {
        type: DataTypes.STRING, // 'Approved', 'Rejected', 'Cancelled'
        allowNull: true
    },
    hrSubmittedAt: {
        type: DataTypes.DATE,
        allowNull: true
    },
    itSubmittedAt: {
        type: DataTypes.DATE,
        allowNull: true
    },
    hodApprovedAt: {
        type: DataTypes.DATE,
        allowNull: true
    },
    dciSubmittedAt: {
        type: DataTypes.DATE, // When DCI Team submits to Manager
        allowNull: true
    },
    dciManagerDecidedAt: {
        type: DataTypes.DATE,
        allowNull: true
    },
    itHodDecidedAt: {
        type: DataTypes.DATE,
        allowNull: true
    },

    // --- Phase 4: Implementation & OPS ---
    dciImplementer: {
        type: DataTypes.STRING,
        allowNull: true
    },
    dciProofAttachments: {
        type: DataTypes.TEXT, // Changed from JSON for MSSQL compatibility
        allowNull: true,
        get() {
            const rawValue = this.getDataValue('dciProofAttachments');
            return rawValue ? JSON.parse(rawValue) : [];
        },
        set(value) {
            this.setDataValue('dciProofAttachments', JSON.stringify(value));
        }
    },
    dciImplementedAt: {
        type: DataTypes.DATE,
        allowNull: true
    },
    opsCompletedBy: {
        type: DataTypes.STRING,
        allowNull: true
    },
    opsChecklist: {
        type: DataTypes.TEXT, // Changed from JSON for MSSQL compatibility
        allowNull: true,
        get() {
            const rawValue = this.getDataValue('opsChecklist');
            return rawValue ? JSON.parse(rawValue) : [];
        },
        set(value) {
            this.setDataValue('opsChecklist', JSON.stringify(value));
        }
    },
    opsCompletedAt: {
        type: DataTypes.DATE,
        allowNull: true
    }
});

export default OnboardingRequest;

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
        type: DataTypes.STRING, // 'Draft', 'PendingIT', 'PendingDSI', 'Completed', 'Rejected'
        defaultValue: 'Draft'
    },
    currentStageToken: {
        type: DataTypes.STRING,
        allowNull: true
    },
    hrSubmittedAt: { type: DataTypes.DATE },
    itSubmittedAt: { type: DataTypes.DATE },
    dsiDecidedAt: { type: DataTypes.DATE },

    // Section 1: Requestor Information (HR)
    employeeId: { type: DataTypes.STRING },
    fullName: { type: DataTypes.STRING },
    department: { type: DataTypes.STRING },
    designation: { type: DataTypes.STRING },
    joiningDate: { type: DataTypes.DATE },
    officeExtension: { type: DataTypes.STRING },
    homePhone: { type: DataTypes.STRING },
    mobilePhone: { type: DataTypes.STRING },
    requestMode: { type: DataTypes.STRING },
    hod: { type: DataTypes.STRING }, // Head of Department
    projectUnit: { type: DataTypes.STRING },

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

    // --- Section 4: DSI Approval & Configuration (DSI) ---
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
        type: DataTypes.STRING, // 'Highly Managed', 'Lightly Managed', 'IT User'
        allowNull: true
    },

    // --- Approvals & Timestamps ---
    dsiRemarks: {
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
    dsiSubmittedAt: {
        type: DataTypes.DATE, // When DSI Team submits to Manager
        allowNull: true
    },
    dsiManagerDecidedAt: {
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

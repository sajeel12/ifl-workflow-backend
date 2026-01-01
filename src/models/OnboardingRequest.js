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

    // Section 3: IT Configuration (IT Ops)
    ntUserName: { type: DataTypes.STRING },
    exchangeDisplayName: { type: DataTypes.STRING },
    smtpAddress: { type: DataTypes.STRING },
    memberOf: { type: DataTypes.STRING },
    dgMembers: { type: DataTypes.STRING },
    recipientLimit: { type: DataTypes.STRING },
    mailboxStorageLimit: { type: DataTypes.STRING },
    mailSizeLimit: { type: DataTypes.STRING },
    extraFacility: { type: DataTypes.TEXT },
    groupPolicyLevel: {
        type: DataTypes.STRING
        // Expected values: 'Highly Managed', 'Lightly Managed', 'IT User'
    },

    // Section 4: DSI Approval (DSI)
    dsiRemarks: { type: DataTypes.TEXT },
    approvalStatus: {
        type: DataTypes.STRING // 'Approved', 'Rejected', 'Cancelled'
    }
});

export default OnboardingRequest;

import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';

const WorkflowApproverConfig = sequelize.define('WorkflowApproverConfig', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    roleKey: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true,
        comment: 'IT_OPS | DCI_TEAM | OPS_TEAM | DCI_MANAGER | IT_HOD | DCI_IMPLEMENTER'
    },
    label: {
        type: DataTypes.STRING,
        allowNull: false
    },
    description: {
        type: DataTypes.STRING,
        allowNull: true
    },
    workflowStage: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: 'Human-readable workflow step this approver belongs to'
    },
    // Primary
    approverUsername: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: 'AD sAMAccountName (e.g. "israr.haq") — used for portal access control'
    },
    approverEmail: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: 'Used for sending workflow notification emails'
    },
    approverName: {
        type: DataTypes.STRING,
        allowNull: true
    },
    // Secondary (fallback after 2 days)
    secondaryUsername: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: 'AD sAMAccountName for secondary approver'
    },
    secondaryEmail: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: 'Used for sending workflow notification emails to secondary'
    },
    secondaryName: {
        type: DataTypes.STRING,
        allowNull: true
    },
    // Temporary delegation — DCI_MANAGER and IT_HOD only.
    // When admin temporarily delegates the role, the original person's details
    // are snapshotted here so they can (a) still view the portal in read-only
    // mode and (b) be restored with a single admin revert action.
    isDelegatedTemporarily: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        comment: 'True while a temporary cover is active for DCI_MANAGER / IT_HOD'
    },
    previousApproverEmail: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: 'Original person email before temporary delegation'
    },
    previousApproverName: {
        type: DataTypes.STRING,
        allowNull: true
    },
    previousApproverUsername: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: 'Original person AD sAMAccountName before temporary delegation'
    },
    // Tracking for 2-day fallback logic
    lastAssignedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: 'Last time a request was routed to this role (primary)'
    },
    primaryExpiredAt: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: 'When primary became expired after 2 days without response'
    },
    isActive: {
        type: DataTypes.BOOLEAN,
        defaultValue: true
    }
});

export default WorkflowApproverConfig;

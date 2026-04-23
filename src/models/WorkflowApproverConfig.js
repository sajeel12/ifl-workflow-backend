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
    approverEmail: {
        type: DataTypes.STRING,
        allowNull: true,
        validate: { isEmail: { msg: 'Invalid primary email' } }
    },
    approverName: {
        type: DataTypes.STRING,
        allowNull: true
    },
    // Secondary (fallback after 2 days)
    secondaryEmail: {
        type: DataTypes.STRING,
        allowNull: true,
        validate: { isEmail: { msg: 'Invalid secondary email' } }
    },
    secondaryName: {
        type: DataTypes.STRING,
        allowNull: true
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

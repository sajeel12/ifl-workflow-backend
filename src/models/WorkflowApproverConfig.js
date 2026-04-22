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
    approverEmail: {
        type: DataTypes.STRING,
        allowNull: true,
        validate: { isEmail: true }
    },
    approverName: {
        type: DataTypes.STRING,
        allowNull: true
    },
    isActive: {
        type: DataTypes.BOOLEAN,
        defaultValue: true
    }
});

export default WorkflowApproverConfig;

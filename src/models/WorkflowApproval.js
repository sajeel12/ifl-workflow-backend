import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';

const WorkflowApproval = sequelize.define('WorkflowApproval', {
    approvalId: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    requestId: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    approverEmail: {
        type: DataTypes.STRING,
        allowNull: false,
        validate: {
            isEmail: true
        }
    },
    status: {
        type: DataTypes.STRING,
        defaultValue: 'Pending' // Pending, Approved, Rejected
    },
    decisionDate: {
        type: DataTypes.DATE
    },
    comment: {
        type: DataTypes.TEXT
    },
    actionToken: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true
    },
    approvalLevel: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1 // 1 = Manager, 2 = Department Head
    },
    approverRole: {
        type: DataTypes.STRING,
        allowNull: false,
        defaultValue: 'Manager' // 'Manager' or 'DepartmentHead'
    }
});

export default WorkflowApproval;

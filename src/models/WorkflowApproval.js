import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';
import AccessRequest from './AccessRequest.js';

const WorkflowApproval = sequelize.define('WorkflowApproval', {
    approvalId: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
    },
    requestId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: {
            model: AccessRequest,
            key: 'requestId'
        }
    },
    approverEmail: {
        type: DataTypes.STRING,
        allowNull: false
    },
    status: {
        type: DataTypes.ENUM('Pending', 'Approved', 'Rejected'),
        defaultValue: 'Pending'
    },
    decisionDate: {
        type: DataTypes.DATE,
        allowNull: true
    },
    comment: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    actionToken: {
        type: DataTypes.STRING,
        unique: true,
        allowNull: false // Critical for our Hash Validation strategy
    }
}, {
    timestamps: true
});

// Association
WorkflowApproval.belongsTo(AccessRequest, { foreignKey: 'requestId' });
AccessRequest.hasMany(WorkflowApproval, { foreignKey: 'requestId' });

export default WorkflowApproval;

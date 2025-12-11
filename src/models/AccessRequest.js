import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';

const AccessRequest = sequelize.define('AccessRequest', {
    requestId: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    employeeId: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    requestType: {
        type: DataTypes.STRING,
        allowNull: false
    },
    justification: {
        type: DataTypes.TEXT
    },
    status: {
        type: DataTypes.STRING,
        defaultValue: 'Pending' // Pending, Approved, Rejected, Completed
    },
    workflowStage: {
        type: DataTypes.STRING,
        defaultValue: 'ManagerApproval'
    },
    createdAt: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW
    }
});

export default AccessRequest;

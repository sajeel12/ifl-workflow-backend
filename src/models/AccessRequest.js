import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';
import Employee from './Employee.js';

const AccessRequest = sequelize.define('AccessRequest', {
    requestId: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
    },
    employeeId: {
        type: DataTypes.STRING,
        allowNull: false,
        references: {
            model: Employee,
            key: 'employeeId'
        }
    },
    requestType: {
        type: DataTypes.STRING, // e.g., "SAP Access", "VPN"
        allowNull: false
    },
    justification: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    status: {
        type: DataTypes.ENUM('Pending', 'Approved', 'Rejected'),
        defaultValue: 'Pending'
    },
    workflowStage: {
        type: DataTypes.STRING, // e.g., "Manager Approval", "IT Provisioning"
        defaultValue: 'Manager Approval'
    }
}, {
    timestamps: true
});

// Association
AccessRequest.belongsTo(Employee, { foreignKey: 'employeeId' });
Employee.hasMany(AccessRequest, { foreignKey: 'employeeId' });

export default AccessRequest;

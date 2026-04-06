import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';

const OffboardingRequest = sequelize.define('OffboardingRequest', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    status: {
        type: DataTypes.STRING, // 'Draft', 'PendingManagerApproval', 'PendingSystemTeam', 'Completed', 'Rejected'
        defaultValue: 'Draft'
    },
    currentStageToken: {
        type: DataTypes.STRING,
        allowNull: true
    },
    
    // Employee Details
    employeeId: { type: DataTypes.STRING, allowNull: false },
    fullName: { type: DataTypes.STRING },
    department: { type: DataTypes.STRING },
    designation: { type: DataTypes.STRING },
    
    // Workflow tracking
    initiatedBy: { type: DataTypes.STRING }, // User ID of HR/IT
    initiatedAt: { type: DataTypes.DATE },

    // Manager Section
    managerRemarks: { type: DataTypes.TEXT },
    assignedSystemAgentId: { type: DataTypes.STRING }, // System Team user assigned to the task
    managerApprovedAt: { type: DataTypes.DATE },

    // System Team Checklist
    adRevoked: { type: DataTypes.BOOLEAN, defaultValue: false },
    physicalAccessRevoked: { type: DataTypes.BOOLEAN, defaultValue: false },
    checklistNotes: { type: DataTypes.TEXT },
    completedAt: { type: DataTypes.DATE }
});

export default OffboardingRequest;

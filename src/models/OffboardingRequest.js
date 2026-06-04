import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';

const OffboardingRequest = sequelize.define('OffboardingRequest', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    status: {
        // 'Draft' | 'PendingDCIManager' | 'PendingDCIImplementation' | 'Completed' | 'Rejected'
        // Legacy values 'PendingManagerApproval' / 'PendingSystemTeam' are
        // auto-migrated by the UPDATE statements in server.js on startup.
        type: DataTypes.STRING,
        defaultValue: 'Draft'
    },
    currentStageToken: {
        type: DataTypes.STRING,
        allowNull: true
    },
    // Email + AD-username of the person this stage's link was last sent to.
    // Used by the portal queue filter and by the delegation re-emission logic
    // in src/services/escalationService.js. Mirrors the same-named fields on
    // OnboardingRequest.
    currentStageAssigneeEmail: {
        type: DataTypes.STRING,
        allowNull: true
    },
    currentStageAssigneeUsername: {
        type: DataTypes.STRING,
        allowNull: true
    },
    // Delegation snapshot — populated when an admin temporarily delegates the
    // DCI Manager or IT HOD role and the in-flight email is re-emitted to the
    // new delegate. Shape:
    //   { delegatedAt, delegatedFromEmail, delegatedToEmail, originalAssigneeEmail }
    // Cleared on any stage transition or on the auto-revert timeout.
    delegationEvent: {
        type: DataTypes.JSON,
        allowNull: true
    },

    // Employee Details
    employeeId: { type: DataTypes.STRING, allowNull: false },
    fullName: { type: DataTypes.STRING },
    department: { type: DataTypes.STRING },
    designation: { type: DataTypes.STRING },
    // Location group key (e.g. 'LHR', 'HO_FSD') — used for IT_OPS routing
    // when the initiator is IT Ops, and as PDF/UI label source.
    location: { type: DataTypes.STRING, allowNull: true },

    // Workflow tracking
    initiatedBy: { type: DataTypes.STRING }, // SSO email of the HR / IT Ops initiator
    initiatedAt: { type: DataTypes.DATE },

    // Manager Section (now DCI Manager — see plan §1)
    managerRemarks: { type: DataTypes.TEXT },
    assignedSystemAgentId: { type: DataTypes.STRING }, // legacy; unused on new flows
    managerApprovedAt: { type: DataTypes.DATE },

    // DCI Implementer Checklist — single submit per plan §3
    adRevoked: { type: DataTypes.BOOLEAN, defaultValue: false },
    smartXRevoked: { type: DataTypes.BOOLEAN, defaultValue: false },
    doorAccessRevoked: { type: DataTypes.BOOLEAN, defaultValue: false },
    // Legacy field — superseded by doorAccessRevoked; kept so old rows still
    // deserialize. New code reads doorAccessRevoked exclusively.
    physicalAccessRevoked: { type: DataTypes.BOOLEAN, defaultValue: false },

    checklistNotes: { type: DataTypes.TEXT },
    dciImplementerName: { type: DataTypes.STRING, allowNull: true },
    dciImplementerCompletedAt: { type: DataTypes.DATE, allowNull: true },
    dciProofAttachments: { type: DataTypes.JSON, allowNull: true },

    completedAt: { type: DataTypes.DATE }
});

export default OffboardingRequest;

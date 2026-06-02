import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';

/**
 * RequestStageEvent Model
 *
 * Granular event tracking for workflow stage transitions.
 * Each event represents a single stage in the workflow lifecycle.
 *
 * This replaces the timestamp-based tracking (hrSubmittedAt, itSubmittedAt, etc.)
 * with a more flexible event-based system that supports:
 * - Multiple request types (onboarding, internet access, browsing rights, etc.)
 * - Detailed outcome tracking (approved, rejected, escalated, delegated)
 * - Owner attribution (who processed this stage)
 * - Duration calculation (time spent in each stage)
 * - Email tracking (was notification sent?)
 *
 * Example Events for Onboarding Request 128793:
 * 1. { stage: 'Draft', outcome: 'submitted', owner: 'hr_user', durationHours: 2 }
 * 2. { stage: 'PendingIT', outcome: 'approved', owner: 'it_ops_user', durationHours: 4 }
 * 3. { stage: 'PendingHOD', outcome: 'approved', owner: 'hod_user', durationHours: 24 }
 * ... and so on
 */
const RequestStageEvent = sequelize.define('RequestStageEvent', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    requestId: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: 'Request ID (OnboardingRequest.id, InternetAccessRequest.id, etc.)'
    },
    requestType: {
        type: DataTypes.STRING(20),
        allowNull: false,
        validate: {
            isIn: [['onboarding', 'internet_access', 'browsing_rights', 'change_request', 'offboarding']]
        },
        comment: 'Type of request: onboarding, internet_access, browsing_rights, etc.'
    },
    stage: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: 'Internal stage identifier (e.g., PendingIT, PendingDCI, etc.)'
    },
    stageLabel: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: 'User-facing stage label (e.g., "Pending IT Operations")'
    },
    outcome: {
        type: DataTypes.STRING(20),
        allowNull: false,
        validate: {
            isIn: [['submitted', 'approved', 'rejected', 'delegated', 'escalated', 'completed', 'cancelled']]
        },
        comment: 'Stage outcome: submitted, approved, rejected, delegated, escalated, completed, cancelled'
    },
    owner: {
        type: DataTypes.STRING(100),
        allowNull: true,
        comment: 'User who processed this stage (ntUserName or email)'
    },
    ownerLabel: {
        type: DataTypes.STRING(100),
        allowNull: true,
        comment: 'Display name of the owner (for UI)'
    },
    remarks: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: 'Optional remarks or notes entered by the owner'
    },
    emailSent: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        comment: 'Was email notification sent for this event?'
    },
    durationHours: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: 'Time spent in this stage (in hours) - calculated from previous event'
    },
    metadata: {
        type: DataTypes.TEXT,
        allowNull: true,
        get() {
            const rawValue = this.getDataValue('metadata');
            return rawValue ? JSON.parse(rawValue) : null;
        },
        set(value) {
            this.setDataValue('metadata', value ? JSON.stringify(value) : null);
        },
        comment: 'Additional metadata (JSON): IP address, browser, delegation info, etc.'
    },
    timestamp: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        comment: 'When this event occurred'
    }
}, {
    tableName: 'RequestStageEvents',
    timestamps: false, // We use custom 'timestamp' field instead
    indexes: [
        {
            name: 'idx_stage_event_request_id',
            fields: ['requestId']
        },
        {
            name: 'idx_stage_event_request_type',
            fields: ['requestType']
        },
        {
            name: 'idx_stage_event_stage',
            fields: ['stage']
        },
        {
            name: 'idx_stage_event_timestamp',
            fields: ['timestamp']
        },
        {
            name: 'idx_stage_event_timeline',
            fields: ['requestId', 'timestamp']
        }
    ]
});

export default RequestStageEvent;

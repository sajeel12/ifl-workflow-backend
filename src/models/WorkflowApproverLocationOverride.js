import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';

/**
 * Per-location override of WorkflowApproverConfig.
 *
 * The original WorkflowApproverConfig table holds the GLOBAL defaults — one
 * row per role (IT_OPS, DCI_TEAM, …). When a request needs more granular
 * routing (e.g. Lahore vs. Karachi vs. Faisalabad have different DCI teams),
 * an admin creates rows in this table — one row per (roleKey, location).
 *
 * Lookup at runtime (RecipientService):
 *   1. Try this table for (roleKey, employee.location) — if present, use it.
 *   2. Otherwise fall back to WorkflowApproverConfig (global default).
 *
 * The same Primary/Secondary fallback + 2-day expiry rules apply per row.
 */
const WorkflowApproverLocationOverride = sequelize.define(
    'WorkflowApproverLocationOverride',
    {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true
        },
        roleKey: {
            type: DataTypes.STRING,
            allowNull: false,
            comment: 'IT_OPS | DCI_TEAM | OPS_TEAM | DCI_MANAGER | IT_HOD | DCI_IMPLEMENTER'
        },
        location: {
            type: DataTypes.STRING,
            allowNull: false,
            comment: 'Employee.location value this override applies to (e.g. "Lahore", "Karachi")'
        },
        // Primary
        approverUsername: {
            type: DataTypes.STRING,
            allowNull: true,
            comment: 'AD sAMAccountName — used for portal access control'
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
        // Secondary (fallback after 2 days of no response)
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
        // Tracking — same semantics as WorkflowApproverConfig
        lastAssignedAt: {
            type: DataTypes.DATE,
            allowNull: true
        },
        primaryExpiredAt: {
            type: DataTypes.DATE,
            allowNull: true
        },
        isActive: {
            type: DataTypes.BOOLEAN,
            defaultValue: true
        }
    },
    {
        indexes: [
            // One override per (role, location) pair.
            { unique: true, fields: ['roleKey', 'location'] },
            // Fast lookups by location alone.
            { fields: ['location'] }
        ]
    }
);

export default WorkflowApproverLocationOverride;

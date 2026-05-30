import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';

/**
 * RequestRelationship Model
 *
 * Tracks relationships between different requests in the workflow system.
 * Used for visualizing request dependencies and parent-child relationships
 * in the employee journey graph.
 *
 * Relationship Types:
 * - 'parent': Source request is parent of target (e.g., onboarding → change request)
 * - 'child': Source request is child of target (inverse of parent)
 * - 'dependency': Source request depends on target completing first
 * - 'related': Source and target are related but no strict dependency
 *
 * Example:
 * - Onboarding (ID: 128793) is parent of Internet Access Request (ID: 129401)
 * - Internet Access (ID: 129401) is dependency of Browsing Rights (ID: 129450)
 */
const RequestRelationship = sequelize.define('RequestRelationship', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    requestId: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: 'Source request ID (OnboardingRequest.id, InternetAccessRequest.id, etc.)'
    },
    relatedRequestId: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: 'Target request ID that this request is related to'
    },
    relationshipType: {
        type: DataTypes.STRING(20),
        allowNull: false,
        validate: {
            isIn: [['parent', 'child', 'dependency', 'related']]
        },
        comment: 'Type of relationship: parent, child, dependency, related'
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
        comment: 'Additional metadata about the relationship (JSON)'
    }
}, {
    tableName: 'RequestRelationships',
    timestamps: true,
    indexes: [
        {
            name: 'idx_relationship_request_id',
            fields: ['requestId']
        },
        {
            name: 'idx_relationship_related_request_id',
            fields: ['relatedRequestId']
        },
        {
            name: 'idx_relationship_lookup',
            fields: ['requestId', 'relationshipType']
        }
    ]
});

export default RequestRelationship;

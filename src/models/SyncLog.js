import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';

const SyncLog = sequelize.define('SyncLog', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    syncStatus: {
        type: DataTypes.ENUM('IN_PROGRESS', 'COMPLETED', 'FAILED'),
        allowNull: false,
        defaultValue: 'IN_PROGRESS'
    },
    recordsProcessed: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0
    },
    errorMessages: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    startedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW
    },
    completedAt: {
        type: DataTypes.DATE,
        allowNull: true
    },
    syncType: {
        type: DataTypes.STRING,
        allowNull: false,
        defaultValue: 'MANUAL' // MANUAL or SCHEDULED
    }
}, {
    timestamps: true,
    tableName: 'sync_logs'
});

export default SyncLog;

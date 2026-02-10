import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';

const TimelineEvent = sequelize.define('TimelineEvent', {
    eventId: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    requestId: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    action: {
        type: DataTypes.STRING, // 'Submitted', 'Approved', 'Rejected', 'Configured'
        allowNull: false
    },
    actorRole: {
        type: DataTypes.STRING, // 'HR', 'IT', 'HOD', ...
        allowNull: false
    },
    details: {
        type: DataTypes.TEXT // Remarks, changed fields, etc.
    },
    timestamp: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW
    }
});

export default TimelineEvent;

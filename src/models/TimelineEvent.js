import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';

const TimelineEvent = sequelize.define('TimelineEvent', {
    eventId: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    employeeId: {
        type: DataTypes.INTEGER
    },
    eventType: {
        type: DataTypes.STRING,
        allowNull: false
    },
    description: {
        type: DataTypes.TEXT
    },
    timestamp: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW
    }
});

export default TimelineEvent;

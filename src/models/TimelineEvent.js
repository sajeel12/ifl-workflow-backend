import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';
import Employee from './Employee.js';

const TimelineEvent = sequelize.define('TimelineEvent', {
    eventId: {
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
    eventType: {
        type: DataTypes.STRING,
        allowNull: false // e.g., "ONBOARDING_INITIATED", "ACCESS_REQUESTED"
    },
    description: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    timestamp: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW
    }
}, {
    timestamps: false
});

TimelineEvent.belongsTo(Employee, { foreignKey: 'employeeId' });

export default TimelineEvent;

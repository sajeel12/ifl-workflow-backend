import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';

const Employee = sequelize.define('Employee', {
    employeeId: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    name: {
        type: DataTypes.STRING,
        allowNull: false
    },
    email: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true,
        validate: {
            isEmail: true
        }
    },
    department: {
        type: DataTypes.STRING
    },
    managerEmail: {
        type: DataTypes.STRING,
        validate: {
            isEmail: true
        }
    },
    status: {
        type: DataTypes.STRING,
        defaultValue: 'Active' // Active, Terminated, Onboarding
    },
    createdAt: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW
    }
});

export default Employee;

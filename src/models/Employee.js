import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';

const Employee = sequelize.define('Employee', {
    employeeId: {
        type: DataTypes.STRING,
        primaryKey: true,
        unique: true
    },
    name: {
        type: DataTypes.STRING,
        allowNull: false
    },
    email: {
        type: DataTypes.STRING,
        allowNull: false,
        validate: {
            isEmail: true
        }
    },
    department: {
        type: DataTypes.STRING,
        allowNull: true
    },
    managerEmail: {
        type: DataTypes.STRING,
        allowNull: true
    },
    status: {
        type: DataTypes.ENUM('Active', 'Inactive', 'Onboarding'),
        defaultValue: 'Onboarding'
    }
}, {
    timestamps: true
});

export default Employee;

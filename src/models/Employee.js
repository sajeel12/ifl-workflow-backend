import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';

const Employee = sequelize.define('Employee', {
    employeeId: {
        type: DataTypes.STRING,
        primaryKey: true,
        allowNull: false
    },
    personId: {
        type: DataTypes.STRING
    },
    name: {
        type: DataTypes.STRING,
        allowNull: false
    },
    fatherName: {
        type: DataTypes.STRING
    },
    dateOfBirth: {
        type: DataTypes.STRING // DATEONLY might fail if parsing isn't perfect, using STRING for now or DATEONLY, I'll use STRING for safety since it's from XML
    },
    gender: {
        type: DataTypes.STRING
    },
    cnic: {
        type: DataTypes.STRING
    },
    bloodGroup: {
        type: DataTypes.STRING
    },
    email: {
        type: DataTypes.STRING
    },
    mobile: {
        type: DataTypes.STRING
    },
    extension: {
        type: DataTypes.STRING
    },
    designation: {
        type: DataTypes.STRING
    },
    mainDept: {
        type: DataTypes.STRING
    },
    orgElementName: {
        type: DataTypes.STRING
    },
    location: {
        type: DataTypes.STRING
    },
    unit: {
        type: DataTypes.STRING
    },
    joiningDate: {
        type: DataTypes.STRING
    },
    assignmentCategory: {
        type: DataTypes.STRING
    },
    employeeCategory: {
        type: DataTypes.STRING
    },
    employmentCategory: {
        type: DataTypes.STRING
    },
    employeeType: {
        type: DataTypes.STRING
    },
    assignmentNumber: {
        type: DataTypes.STRING
    },
    payroll: {
        type: DataTypes.STRING
    },
    rfid: {
        type: DataTypes.STRING
    },
    erpUser: {
        type: DataTypes.STRING
    },
    pposDateStart: {
        type: DataTypes.DATE
    },
    lastResignedDate: {
        type: DataTypes.DATE
    },
    actualTerminationDate: {
        type: DataTypes.DATE
    },
    managerId: {
        type: DataTypes.STRING
    },
    managerName: {
        type: DataTypes.STRING
    },
    managerDesignation: {
        type: DataTypes.STRING
    },
    managerEmail: {
        type: DataTypes.STRING
    },
    hodId: {
        type: DataTypes.STRING,
        allowNull: true,
        references: {
            model: 'Employees', // Self-referencing the table name
            key: 'employeeId'
        }
    },
    image: {
        type: DataTypes.BLOB('long') // Binary data
    },
    status: {
        type: DataTypes.STRING,
        defaultValue: 'Active'
    }
}, {
    timestamps: true
});

export default Employee;

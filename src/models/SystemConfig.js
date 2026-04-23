import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';

const SystemConfig = sequelize.define('SystemConfig', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    key: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true,
        comment: 'Config key: printer_locations | file_share_paths | sharepoint_paths'
    },
    value: {
        type: DataTypes.TEXT,
        allowNull: true,
        get() {
            const rawValue = this.getDataValue('value');
            return rawValue ? JSON.parse(rawValue) : null;
        },
        set(value) {
            this.setDataValue('value', JSON.stringify(value));
        },
        comment: 'JSON-serialized config data'
    },
    description: {
        type: DataTypes.STRING,
        allowNull: true
    },
    updatedBy: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: 'Admin email who last updated this'
    }
});

export default SystemConfig;

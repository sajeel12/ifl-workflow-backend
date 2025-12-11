import { Sequelize } from 'sequelize';
import dotenv from 'dotenv';
import logger from '../utils/logger.js';

dotenv.config();

const sequelize = new Sequelize(
    process.env.DB_NAME,
    process.env.DB_USER,
    process.env.DB_PASS,
    {
        host: process.env.DB_HOST,
        dialect: 'mssql', // ensure 'mssql' matches .env if not hardcoded
        port: parseInt(process.env.DB_PORT, 10) || 1433,
        logging: (msg) => logger.debug(msg),
        dialectOptions: {
            options: {
                encrypt: false, // Set to true if using Azure; false for local/on-prem usually
                trustServerCertificate: true,
            }
        }
    }
);

export default sequelize;

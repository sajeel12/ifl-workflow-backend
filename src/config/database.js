import { Sequelize } from 'sequelize';
import logger from '../utils/logger.js';
import dotenv from 'dotenv';
dotenv.config();

const sequelize = new Sequelize(
    process.env.DB_NAME,
    process.env.DB_USER,
    process.env.DB_PASS,
    {
        host: process.env.DB_HOST,
        port: parseInt(process.env.DB_PORT) || 1433,
        dialect: 'mssql',
        logging: (msg) => logger.debug(msg),
        dialectOptions: {
            options: {
                encrypt: false, // Set to true if using Azure SQL or forced encryption
                trustServerCertificate: true, // For self-signed certs (common in dev/on-prem)
            },
        },
        pool: {
            max: 5,
            min: 0,
            acquire: 30000,
            idle: 10000
        }
    }
);

export default sequelize;

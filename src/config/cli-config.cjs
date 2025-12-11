require('dotenv').config();

module.exports = {
    development: {
        username: process.env.DB_USER,
        password: process.env.DB_PASS,
        database: process.env.DB_NAME,
        host: process.env.DB_HOST,
        port: parseInt(process.env.DB_PORT) || 1433,
        dialect: 'mssql',
        dialectOptions: {
            options: {
                encrypt: false,
                trustServerCertificate: true
            }
        }
    },
    production: {
        username: process.env.DB_USER,
        password: process.env.DB_PASS,
        database: process.env.DB_NAME,
        host: process.env.DB_HOST,
        port: parseInt(process.env.DB_PORT) || 1433,
        dialect: 'mssql',
        dialectOptions: {
            options: {
                encrypt: true, // Usually true in prod
                trustServerCertificate: false
            }
        }
    }
};

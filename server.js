import app from './app.js';
import sequelize from './src/config/database.js';
import logger from './src/utils/logger.js';
import Employee from './src/models/Employee.js';
import OnboardingRequest from './src/models/OnboardingRequest.js';
import OffboardingRequest from './src/models/OffboardingRequest.js';
import TimelineEvent from './src/models/TimelineEvent.js';
import SyncLog from './src/models/SyncLog.js';

const PORT = process.env.PORT || 3000;


async function dropAllForeignKeys() {
    try {
        const query = `
            DECLARE @sql NVARCHAR(MAX) = N'';
            SELECT @sql += 'ALTER TABLE ' + QUOTENAME(OBJECT_SCHEMA_NAME(parent_object_id)) + '.' + 
                          QUOTENAME(OBJECT_NAME(parent_object_id)) + 
                          ' DROP CONSTRAINT ' + QUOTENAME(name) + ';'
            FROM sys.foreign_keys;
            EXEC sp_executesql @sql;
        `;
        await sequelize.query(query);
        logger.info('All foreign key constraints dropped.');
    } catch (err) {
        logger.warn(`Could not drop foreign keys: ${err.message}`);
    }
}

async function startServer() {
    try {

        await sequelize.authenticate();
        logger.info('Database connected.');


        const isDev = process.env.NODE_ENV !== 'production';
        const isSqlite = process.env.DB_DIALECT === 'sqlite';

        if (isDev && !isSqlite) {
            await dropAllForeignKeys();
        }

        const syncAlter = process.env.DB_SYNC_ALTER === 'true' || false;
        const syncOptions = { alter: syncAlter };

        if (isSqlite && syncAlter) {
            logger.info('Database sync starting (alter mode)... This may take a moment.');
            const startTime = Date.now();
            await sequelize.query('PRAGMA foreign_keys = OFF');
            await sequelize.sync(syncOptions);
            await sequelize.query('PRAGMA foreign_keys = ON');
            const duration = ((Date.now() - startTime) / 1000).toFixed(2);
            logger.info(`Database synced in ${duration}s (SQLite alter mode with FK bypass).`);
        } else {
            const startTime = Date.now();
            await sequelize.sync({ alter: syncAlter });
            const duration = ((Date.now() - startTime) / 1000).toFixed(2);
            logger.info(`Database synced in ${duration}s (sync results).`);
        }

        app.listen(PORT, '0.0.0.0', () => {
            logger.info(`Server running on port ${PORT}`);
        });
    } catch (err) {
        logger.error(`Failed to start server: ${err.message}`, { error: err, stack: err.stack });
        process.exit(1);
    }
}

startServer();

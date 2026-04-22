import app from './app.js';
import sequelize from './src/config/database.js';
import logger from './src/utils/logger.js';
import Employee from './src/models/Employee.js';
import OnboardingRequest from './src/models/OnboardingRequest.js';
import OffboardingRequest from './src/models/OffboardingRequest.js';
import TimelineEvent from './src/models/TimelineEvent.js';
import SyncLog from './src/models/SyncLog.js';
import WorkflowApproverConfig from './src/models/WorkflowApproverConfig.js';

const DEFAULT_APPROVER_CONFIGS = [
    { roleKey: 'IT_OPS',          label: 'IT Operations Team',    description: 'Handles IT configuration in Step 2', workflowStage: 'Step 2 – IT Configuration',       approverEmail: process.env.EMAIL_IT_OPS      || '', approverName: 'IT Operations' },
    { roleKey: 'DCI_TEAM',        label: 'DCI Team',              description: 'DCI configuration and setup in Step 4', workflowStage: 'Step 4 – DCI Configuration',   approverEmail: process.env.EMAIL_DCI_TEAM    || '', approverName: 'DCI Team' },
    { roleKey: 'OPS_TEAM',        label: 'OPS Support Team',      description: 'Final OPS verification in Step 7', workflowStage: 'Step 7 – OPS Verification',        approverEmail: process.env.EMAIL_OPS_TEAM    || '', approverName: 'OPS Team' },
    { roleKey: 'DCI_MANAGER',     label: 'DCI Manager',           description: 'DCI Manager decision in Step 5', workflowStage: 'Step 5 – DCI Manager Decision',      approverEmail: process.env.EMAIL_DCI_MANAGER || '', approverName: 'DCI Manager' },
    { roleKey: 'IT_HOD',          label: 'IT Head of Department', description: 'IT HOD review in Step 5b (email required)', workflowStage: 'Step 5b – IT HOD Review', approverEmail: process.env.EMAIL_IT_HOD      || '', approverName: 'IT HOD' },
    { roleKey: 'DCI_IMPLEMENTER', label: 'DCI Implementer',       description: 'Implements DCI changes in Step 6', workflowStage: 'Step 6 – DCI Implementation',     approverEmail: process.env.EMAIL_DCI_IMPLEMENTER || '', approverName: 'DCI Implementer' },
];

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

        // Seed default approver configs if table is empty
        const count = await WorkflowApproverConfig.count();
        if (count === 0) {
            await WorkflowApproverConfig.bulkCreate(DEFAULT_APPROVER_CONFIGS);
            logger.info('Seeded default WorkflowApproverConfig rows.');
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

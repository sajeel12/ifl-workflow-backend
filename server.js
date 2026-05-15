import app from './app.js';
import sequelize from './src/config/database.js';
import logger from './src/utils/logger.js';
import Employee from './src/models/Employee.js';
import OnboardingRequest from './src/models/OnboardingRequest.js';
import OffboardingRequest from './src/models/OffboardingRequest.js';
import TimelineEvent from './src/models/TimelineEvent.js';
import SyncLog from './src/models/SyncLog.js';
import WorkflowApproverConfig from './src/models/WorkflowApproverConfig.js';
import WorkflowApproverLocationOverride from './src/models/WorkflowApproverLocationOverride.js';
import SystemConfig from './src/models/SystemConfig.js';

const DEFAULT_APPROVER_CONFIGS = [
    { roleKey: 'HR_INITIATOR', label: 'HR Initiator', description: 'Authorized HR users who can initiate onboarding requests. Configured per location group.', workflowStage: 'Step 1 – Initiate Request', approverEmail: '', approverName: 'HR' },
    { roleKey: 'IT_OPS', label: 'IT Operations Team', description: 'Handles IT configuration in Step 2', workflowStage: 'Step 2 – IT Configuration', approverEmail: process.env.EMAIL_IT_OPS || '', approverName: 'IT Operations' },
    { roleKey: 'DCI_TEAM', label: 'DCI Team', description: 'DCI configuration and setup in Step 4', workflowStage: 'Step 4 – DCI Configuration', approverEmail: process.env.EMAIL_DCI_TEAM || '', approverName: 'DCI Team' },
    { roleKey: 'OPS_TEAM', label: 'OPS Support Team', description: 'Final OPS verification in Step 7', workflowStage: 'Step 7 – OPS Verification', approverEmail: process.env.EMAIL_OPS_TEAM || '', approverName: 'OPS Team' },
    { roleKey: 'DCI_MANAGER', label: 'DCI Manager', description: 'DCI Manager decision in Step 5', workflowStage: 'Step 5 – DCI Manager Decision', approverEmail: process.env.EMAIL_DCI_MANAGER || '', approverName: 'DCI Manager' },
    { roleKey: 'IT_HOD', label: 'IT Head of Department', description: 'IT HOD review in Step 5b (email required)', workflowStage: 'Step 5b – IT HOD Review', approverEmail: process.env.EMAIL_IT_HOD || '', approverName: 'IT HOD' },
    { roleKey: 'DCI_IMPLEMENTER', label: 'DCI Implementer', description: 'Implements DCI changes in Step 6', workflowStage: 'Step 6 – DCI Implementation', approverEmail: process.env.EMAIL_DCI_IMPLEMENTER || '', approverName: 'DCI Implementer' },
];

const PORT = process.env.PORT || 3000;


/**
 * Idempotent ADD COLUMN helper. Checks the actual DB schema and only adds
 * the column if it's missing. Works on SQLite and SQL Server (the two
 * dialects this project supports). Safe to call on every startup.
 */
async function ensureColumn(sequelize, isSqlite, tableName, columnName, sqlType) {
    try {
        let exists = false;
        if (isSqlite) {
            const [rows] = await sequelize.query(`PRAGMA table_info("${tableName}")`);
            exists = Array.isArray(rows) && rows.some(r => r.name === columnName);
        } else {
            const [rows] = await sequelize.query(
                `SELECT 1 AS ok FROM INFORMATION_SCHEMA.COLUMNS
                 WHERE TABLE_NAME = '${tableName}' AND COLUMN_NAME = '${columnName}'`
            );
            exists = Array.isArray(rows) && rows.length > 0;
        }
        if (!exists) {
            const ddlType = sqlType === 'STRING' ? (isSqlite ? 'TEXT' : 'NVARCHAR(255)') : sqlType;
            await sequelize.query(`ALTER TABLE "${tableName}" ADD ${isSqlite ? '' : 'COLUMN '}${columnName} ${ddlType} NULL`);
            logger.info(`[Schema] Added missing column ${tableName}.${columnName} (${ddlType}).`);
        }
    } catch (err) {
        logger.warn(`[Schema] ensureColumn(${tableName}.${columnName}) failed: ${err.message}`);
    }
}

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

        // ── Idempotent micro-migrations ──────────────────────────────────
        // Add columns we introduced after the initial schema, only if they
        // don't already exist. Safer than DB_SYNC_ALTER (which can rebuild
        // entire tables and lose data) and runs every startup so production
        // never has to remember a one-off migration step.
        await ensureColumn(sequelize, isSqlite, 'OnboardingRequests', 'currentStageAssigneeEmail', 'STRING');
        // Add future columns here as the model evolves.

        // Idempotent seed: ensure every default role exists. Use findOrCreate
        // (not bulkCreate-only-when-empty) so that roles added in later
        // releases (e.g. HR_INITIATOR) auto-appear on existing databases
        // without needing a manual migration.
        for (const cfg of DEFAULT_APPROVER_CONFIGS) {
            const [, created] = await WorkflowApproverConfig.findOrCreate({
                where: { roleKey: cfg.roleKey },
                defaults: cfg
            });
            if (created) logger.info(`[Schema] Seeded WorkflowApproverConfig row for ${cfg.roleKey}.`);
        }

        // Seed default system configs if table is empty.
        // NOTE: the SystemConfig model's `value` setter stringifies for us — DO NOT pre-stringify.
        const configCount = await SystemConfig.count();
        if (configCount === 0) {
            const defaults = [
                {
                    key: 'printer_locations',
                    value: [
                        { name: 'Laser Printer - Ground Floor', location: 'Building A, Room 101' },
                        { name: 'Laser Printer - First Floor', location: 'Building B, Room 205' },
                        { name: 'Dot Matrix - Accounts', location: 'Building A, Room 102' }
                    ],
                    description: 'Available printer locations'
                },
                {
                    key: 'file_share_paths',
                    value: [
                        { name: 'Department Share', path: '\\\\fileserver\\departments' },
                        { name: 'Home Folder', path: '\\\\fileserver\\home' },
                        { name: 'Archive', path: '\\\\fileserver\\archive' }
                    ],
                    description: 'File server share paths'
                },
                {
                    key: 'sharepoint_paths',
                    value: [
                        { name: 'HR Documents', url: 'https://ifl.sharepoint.com/sites/hr' },
                        { name: 'Finance Portal', url: 'https://ifl.sharepoint.com/sites/finance' },
                        { name: 'IT Knowledge Base', url: 'https://ifl.sharepoint.com/sites/it-kb' }
                    ],
                    description: 'SharePoint site URLs'
                }
            ];
            // Use individual create() so the setter runs (bulkCreate bypasses setters by default)
            for (const cfg of defaults) {
                await SystemConfig.create(cfg);
            }
            logger.info('Seeded default SystemConfig rows.');
        }

        // Seed sample onboarding requests + timeline events for UI demonstration
        const onboardingCount = await OnboardingRequest.count();
        if (onboardingCount === 0) {
            const now = new Date();
            const daysAgo = (n) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000);
            const hoursAgo = (n) => new Date(now.getTime() - n * 60 * 60 * 1000);

            const samples = [
                {
                    status: 'Completed',
                    employeeId: '1042',
                    fullName: 'Ahmed Raza',
                    department: 'IT',
                    designation: 'Software Engineer',
                    location: 'Head Office',
                    joiningDate: daysAgo(30),
                    hrSubmittedAt: daysAgo(10),
                    itSubmittedAt: daysAgo(9),
                    hodApprovedAt: daysAgo(8),
                    dciSubmittedAt: daysAgo(7),
                    dciManagerDecidedAt: daysAgo(6),
                    dciImplementedAt: daysAgo(4),
                    opsCompletedAt: daysAgo(2),
                    approvalStatus: 'Approved',
                    createdAt: daysAgo(10),
                    timeline: [
                        { action: 'Submitted', actorRole: 'HR', details: 'Initial onboarding request created', timestamp: daysAgo(10) },
                        { action: 'Configured', actorRole: 'IT', details: 'IT services configured: email, network, printers', timestamp: daysAgo(9) },
                        { action: 'Approved', actorRole: 'HOD', details: 'Access approved by HOD', timestamp: daysAgo(8) },
                        { action: 'Submitted', actorRole: 'DCI', details: 'DCI configuration submitted for manager review', timestamp: daysAgo(7) },
                        { action: 'Approved', actorRole: 'DCIManager', details: 'DCI Manager approved the configuration', timestamp: daysAgo(6) },
                        { action: 'Configured', actorRole: 'DCI', details: 'AD account provisioned and group policy applied', timestamp: daysAgo(4) },
                        { action: 'Approved', actorRole: 'OPS', details: 'OPS verified all services — onboarding complete', timestamp: daysAgo(2) }
                    ]
                },
                {
                    status: 'Pending',
                    employeeId: '1055',
                    fullName: 'Fatima Khan',
                    department: 'Finance',
                    designation: 'Financial Analyst',
                    location: 'Head Office',
                    joiningDate: daysAgo(5),
                    hrSubmittedAt: daysAgo(3),
                    itSubmittedAt: daysAgo(2),
                    hodApprovedAt: hoursAgo(20),
                    approvalStatus: 'Pending',
                    createdAt: daysAgo(3),
                    timeline: [
                        { action: 'Submitted', actorRole: 'HR', details: 'Onboarding initiated for Finance hire', timestamp: daysAgo(3) },
                        { action: 'Configured', actorRole: 'IT', details: 'Basic IT services provisioned', timestamp: daysAgo(2) },
                        { action: 'Approved', actorRole: 'HOD', details: 'HOD approved, forwarded to DCI team', timestamp: hoursAgo(20) }
                    ]
                },
                {
                    status: 'Rejected',
                    employeeId: '1061',
                    fullName: 'Bilal Ahmed',
                    department: 'HR',
                    designation: 'HR Officer',
                    joiningDate: daysAgo(14),
                    hrSubmittedAt: daysAgo(14),
                    itSubmittedAt: daysAgo(13),
                    approvalStatus: 'Rejected',
                    createdAt: daysAgo(14),
                    timeline: [
                        { action: 'Submitted', actorRole: 'HR', details: 'Onboarding request submitted', timestamp: daysAgo(14) },
                        { action: 'Configured', actorRole: 'IT', details: 'Services configured', timestamp: daysAgo(13) },
                        { action: 'Rejected', actorRole: 'HOD', details: 'Rejected: duplicate account exists for this person', timestamp: daysAgo(12) }
                    ]
                },
                {
                    status: 'Draft',
                    employeeId: '1078',
                    fullName: 'Sara Malik',
                    department: 'Marketing',
                    designation: 'Marketing Executive',
                    joiningDate: daysAgo(1),
                    hrSubmittedAt: hoursAgo(6),
                    approvalStatus: 'Pending',
                    createdAt: hoursAgo(6),
                    timeline: [
                        { action: 'Submitted', actorRole: 'HR', details: 'Draft created — awaiting IT configuration', timestamp: hoursAgo(6) }
                    ]
                }
            ];

            for (const sample of samples) {
                const { timeline, ...requestData } = sample;
                const req = await OnboardingRequest.create(requestData);
                for (const ev of timeline) {
                    await TimelineEvent.create({ ...ev, requestId: req.id });
                }
            }
            logger.info(`Seeded ${samples.length} sample onboarding requests with timeline events.`);
        }

        app.listen(PORT, '127.0.0.1', () => {
            logger.info(`Server running on port ${PORT}`);
        });
    } catch (err) {
        logger.error(`Failed to start server: ${err.message}`, { error: err, stack: err.stack });
        process.exit(1);
    }
}

startServer();

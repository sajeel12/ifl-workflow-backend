import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import app from './app.js';
import sequelize from './src/config/database.js';
import logger from './src/utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
import cronService from './src/services/cronService.js';
import Employee from './src/models/Employee.js';
import OnboardingRequest from './src/models/OnboardingRequest.js';
import OffboardingRequest from './src/models/OffboardingRequest.js';
import InternetBrowsingRequest from './src/models/InternetBrowsingRequest.js';
import TimelineEvent from './src/models/TimelineEvent.js';
import SyncLog from './src/models/SyncLog.js';
import WorkflowApproverConfig from './src/models/WorkflowApproverConfig.js';
import WorkflowApproverLocationOverride from './src/models/WorkflowApproverLocationOverride.js';
import SystemConfig from './src/models/SystemConfig.js';
import RequestRelationship from './src/models/RequestRelationship.js';
import RequestStageEvent from './src/models/RequestStageEvent.js';

const DEFAULT_APPROVER_CONFIGS = [
    { roleKey: 'HR_INITIATOR', label: 'HR Initiator', description: 'Authorized HR users who can initiate onboarding requests. Configured per location group.', workflowStage: 'Step 1 – Initiate Request', approverEmail: null, approverName: 'HR' },
    { roleKey: 'IT_OPS', label: 'IT Operations Team', description: 'Handles IT configuration in Step 2', workflowStage: 'Step 2 – IT Configuration', approverEmail: process.env.EMAIL_IT_OPS || null, approverName: 'IT Operations' },
    { roleKey: 'DCI_TEAM', label: 'DCI Team', description: 'DCI configuration and setup in Step 4', workflowStage: 'Step 4 – DCI Configuration', approverEmail: process.env.EMAIL_DCI_TEAM || null, approverName: 'DCI Team' },
    // OPS_TEAM removed — PendingOPSAction is handled by IT_OPS (same team, per client policy).
    // Any existing DB row is cleaned up in the startup sequence below.
    { roleKey: 'DCI_MANAGER', label: 'DCI Manager', description: 'DCI Manager decision in Step 5', workflowStage: 'Step 5 – DCI Manager Decision', approverEmail: process.env.EMAIL_DCI_MANAGER || null, approverName: 'DCI Manager' },
    { roleKey: 'IT_HOD', label: 'IT Head of Department', description: 'IT HOD review in Step 5b (email required)', workflowStage: 'Step 5b – IT HOD Review', approverEmail: process.env.EMAIL_IT_HOD || null, approverName: 'IT HOD' },
    { roleKey: 'DCI_IMPLEMENTER', label: 'DCI Implementer', description: 'Implements DCI changes in Step 6', workflowStage: 'Step 6 – DCI Implementation', approverEmail: process.env.EMAIL_DCI_IMPLEMENTER || null, approverName: 'DCI Implementer' },
    { roleKey: 'NETWORK_VALIDATOR',   label: 'Network Validator (FMS)', description: 'Validates Internet Browsing requests against network/firewall policy.', workflowStage: 'IBR – FMS Validation', approverEmail: process.env.EMAIL_NETWORK_VALIDATOR || null, approverName: 'Network Validator' },
    { roleKey: 'IT_OPS_MGR',          label: 'IT Operations Manager (RN)', description: 'RN approval stage for Internet Browsing requests — after FMS validation, before IT HOD sign-off.', workflowStage: 'IBR – RN Approval', approverEmail: process.env.EMAIL_IT_OPS_MGR || null, approverName: 'IT Ops Manager' },
    { roleKey: 'NETWORK_IMPLEMENTER', label: 'Network Implementer',     description: 'Applies approved Internet Browsing requests (proxy / firewall changes).', workflowStage: 'IBR – Network Implementation', approverEmail: process.env.EMAIL_NETWORK_IMPLEMENTER || null, approverName: 'Network Implementer' },
];

const PORT = process.env.PORT || 3000;

/**
 * Cross-checks web.config SsoSharedSecret with SSO_SHARED_SECRET in .env.
 * If they differ, sidecar tokens will be rejected — log a loud warning so
 * the mismatch is impossible to miss during startup.
 */
function checkSsoSecretSync() {
    try {
        const xml = readFileSync(join(__dirname, 'web.config'), 'utf8');
        const m = xml.match(/key="SsoSharedSecret"\s+value="([^"]+)"/);
        if (!m) {
            logger.warn('[SSO] web.config has no SsoSharedSecret key — sync check skipped.');
            return;
        }
        const webConfigSecret = m[1];
        const envSecret = process.env.SSO_SHARED_SECRET || '';
        if (webConfigSecret !== envSecret) {
            logger.error(
                `[SSO] SECRET MISMATCH — web.config SsoSharedSecret does not match ` +
                `.env SSO_SHARED_SECRET. Sidecar tokens will be REJECTED by adminApiGuard. ` +
                `Update one side to match the other before serving real traffic.`
            );
        } else {
            logger.info('[SSO] SsoSharedSecret: web.config and .env are in sync.');
        }
    } catch (err) {
        logger.warn(`[SSO] Could not read web.config for sync check: ${err.message}`);
    }
}


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

/**
 * Idempotent ADD INDEX helper. Checks if the index exists and creates it if missing.
 * Safe to call on every startup for both SQLite and SQL Server.
 */
async function ensureIndex(sequelize, isSqlite, tableName, indexName, columnName) {
    try {
        let exists = false;
        if (isSqlite) {
            const [indexes] = await sequelize.query(`PRAGMA index_list("${tableName}")`);
            exists = Array.isArray(indexes) && indexes.some(idx => idx.name === indexName);
        } else {
            const [rows] = await sequelize.query(
                `SELECT 1 AS ok FROM sys.indexes
                 WHERE name = '${indexName}' AND object_id = OBJECT_ID('${tableName}')`
            );
            exists = Array.isArray(rows) && rows.length > 0;
        }
        if (!exists) {
            await sequelize.query(`CREATE INDEX ${indexName} ON "${tableName}" (${columnName})`);
            logger.info(`[Schema] Created index ${indexName} on ${tableName}(${columnName}).`);
        }
    } catch (err) {
        logger.warn(`[Schema] ensureIndex(${tableName}.${indexName}) failed: ${err.message}`);
    }
}

/**
 * One-time repair for the WorkflowApproverLocationOverrides table.
 *
 * Older model revisions defined `roleKey` as a column-level UNIQUE. The table
 * created from that revision can only ever hold one row per role, so saving a
 * second per-location override fails with:
 *   SQLITE_CONSTRAINT: UNIQUE constraint failed: ...roleKey
 *
 * The correct constraint is the composite UNIQUE(roleKey, location). Sequelize
 * `alter` can't reliably drop a stale constraint, so when the bad index is
 * detected we rebuild the table from scratch — preserving any existing rows.
 * After the first run this is a no-op (the rebuilt table has no bad index).
 */
async function fixOverrideTableSchema(sequelize, isSqlite) {
    if (!isSqlite) return; // SQLite-specific repair
    try {
        const [indexes] = await sequelize.query(
            "PRAGMA index_list(`WorkflowApproverLocationOverrides`)"
        );
        let badUnique = false;
        for (const idx of (indexes || [])) {
            if (!idx.unique) continue;
            const [cols] = await sequelize.query(`PRAGMA index_info(\`${idx.name}\`)`);
            // A UNIQUE index over roleKey ALONE is the stale one.
            if (Array.isArray(cols) && cols.length === 1 && cols[0].name === 'roleKey') {
                badUnique = true;
                break;
            }
        }
        if (!badUnique) return;

        // Preserve existing override rows, then rebuild with the correct schema.
        const rows = await WorkflowApproverLocationOverride.findAll({ raw: true });
        await sequelize.query('DROP TABLE IF EXISTS `WorkflowApproverLocationOverrides`');
        await WorkflowApproverLocationOverride.sync(); // recreate with composite UNIQUE
        if (rows.length) {
            await WorkflowApproverLocationOverride.bulkCreate(
                rows.map(({ id, ...rest }) => rest)
            );
        }
        logger.warn(
            `[Schema] Rebuilt WorkflowApproverLocationOverrides — removed stale UNIQUE(roleKey), ` +
            `preserved ${rows.length} row(s).`
        );
    } catch (err) {
        logger.warn(`[Schema] fixOverrideTableSchema failed: ${err.message}`);
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

// Graceful shutdown — give SQLite time to flush WAL before the process dies.
async function shutdown(signal) {
    logger.info(`[Server] ${signal} received — shutting down gracefully.`);
    try { await sequelize.close(); } catch (_) { /* ignore */ }
    process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Retry sequelize.authenticate() up to maxAttempts times with a linear backoff.
async function connectWithRetry(maxAttempts = 3, delayMs = 2000) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            await sequelize.authenticate();
            logger.info('Database connected.');
            return;
        } catch (err) {
            logger.warn(`[DB] Connect attempt ${attempt}/${maxAttempts} failed: ${err.message}`);
            if (attempt === maxAttempts) throw err;
            await new Promise(r => setTimeout(r, delayMs));
        }
    }
}

async function startServer() {
    try {

        checkSsoSecretSync();

        await connectWithRetry();



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
        await ensureColumn(sequelize, isSqlite, 'OnboardingRequests', 'currentStageAssigneeUsername', 'STRING');
        await ensureColumn(sequelize, isSqlite, 'OnboardingRequests', 'workOrderPdfPath', 'STRING');
        // DCI stage AD-provisioning fields (auto-fill + AD checks).
        await ensureColumn(sequelize, isSqlite, 'OnboardingRequests', 'aliasName', 'STRING');
        await ensureColumn(sequelize, isSqlite, 'OnboardingRequests', 'mgLevel', 'STRING');
        await ensureColumn(sequelize, isSqlite, 'OnboardingRequests', 'adTitle', 'STRING');
        await ensureColumn(sequelize, isSqlite, 'OnboardingRequests', 'adDepartment', 'STRING');
        // Machine / asset capture across IT (device type) → DCI (approved
        // hostname + location) → OPS (serial, screenshot, AD existence check).
        await ensureColumn(sequelize, isSqlite, 'OnboardingRequests', 'productType', 'STRING');
        await ensureColumn(sequelize, isSqlite, 'OnboardingRequests', 'deviceLocationCode', 'STRING');
        await ensureColumn(sequelize, isSqlite, 'OnboardingRequests', 'machineHostname', 'STRING');
        await ensureColumn(sequelize, isSqlite, 'OnboardingRequests', 'productSerialNumber', 'STRING');
        await ensureColumn(sequelize, isSqlite, 'OnboardingRequests', 'hostnameVerified', 'BOOLEAN');
        await ensureColumn(sequelize, isSqlite, 'OnboardingRequests', 'opsProofAttachments', 'TEXT');

        // WorkflowApproverConfig — six columns added with the delegation /
        // AD-username feature. The sequelize-cli migration covers four of
        // them, but migrations aren't auto-run on startup and the AD-username
        // pair was never written into a migration at all. Missing any one of
        // these causes the workflow-approvers admin page to 500 on findAll().
        await ensureColumn(sequelize, isSqlite, 'WorkflowApproverConfigs', 'approverUsername', 'STRING');
        await ensureColumn(sequelize, isSqlite, 'WorkflowApproverConfigs', 'secondaryUsername', 'STRING');
        await ensureColumn(sequelize, isSqlite, 'WorkflowApproverConfigs', 'isDelegatedTemporarily', 'BOOLEAN');
        await ensureColumn(sequelize, isSqlite, 'WorkflowApproverConfigs', 'previousApproverEmail', 'STRING');
        await ensureColumn(sequelize, isSqlite, 'WorkflowApproverConfigs', 'previousApproverName', 'STRING');
        await ensureColumn(sequelize, isSqlite, 'WorkflowApproverConfigs', 'previousApproverUsername', 'STRING');

        // WorkflowApproverLocationOverride — same AD-username pair as above.
        await ensureColumn(sequelize, isSqlite, 'WorkflowApproverLocationOverrides', 'approverUsername', 'STRING');
        await ensureColumn(sequelize, isSqlite, 'WorkflowApproverLocationOverrides', 'secondaryUsername', 'STRING');

        // Delegation in-flight snapshot — populated when an admin temporarily
        // delegates a role and the stage email is re-emitted to the delegate.
        // Stored as TEXT (JSON-serialized by Sequelize). Used by the auto-
        // revert pass in src/services/escalationService.js.
        await ensureColumn(sequelize, isSqlite, 'OnboardingRequests', 'delegationEvent', 'TEXT');
        await ensureColumn(sequelize, isSqlite, 'OffboardingRequests', 'delegationEvent', 'TEXT');

        // Offboarding rebuild (plan §1) — new fields on OffboardingRequests.
        await ensureColumn(sequelize, isSqlite, 'OffboardingRequests', 'currentStageAssigneeEmail', 'STRING');
        await ensureColumn(sequelize, isSqlite, 'OffboardingRequests', 'currentStageAssigneeUsername', 'STRING');
        await ensureColumn(sequelize, isSqlite, 'OffboardingRequests', 'location', 'STRING');
        await ensureColumn(sequelize, isSqlite, 'OffboardingRequests', 'smartXRevoked', 'BOOLEAN');
        await ensureColumn(sequelize, isSqlite, 'OffboardingRequests', 'doorAccessRevoked', 'BOOLEAN');
        await ensureColumn(sequelize, isSqlite, 'OffboardingRequests', 'dciImplementerName', 'STRING');
        await ensureColumn(sequelize, isSqlite, 'OffboardingRequests', 'dciImplementerCompletedAt', 'DATETIME');
        await ensureColumn(sequelize, isSqlite, 'OffboardingRequests', 'dciProofAttachments', 'TEXT');
        // Revocation Work Order PDF generated at DCI Manager approval.
        await ensureColumn(sequelize, isSqlite, 'OffboardingRequests', 'revocationPdfPath', 'STRING');

        // Internet Browsing Request — raw AD office the location group was
        // derived from (location stores the group key; routing is AD-driven).
        await ensureColumn(sequelize, isSqlite, 'InternetBrowsingRequests', 'adOffice', 'STRING');
        await ensureColumn(sequelize, isSqlite, 'InternetBrowsingRequests', 'specificSites', 'TEXT');

        // One-time status migration. Legacy offboarding rows used the
        // SystemManager/SystemTeam role names; rename to the new DCI Manager /
        // DCI Implementer chain in place. Idempotent — the UPDATE only touches
        // rows still on the old strings.
        try {
            const [, meta1] = await sequelize.query(
                "UPDATE OffboardingRequests SET status = 'PendingDCIManager' WHERE status = 'PendingManagerApproval'"
            );
            const [, meta2] = await sequelize.query(
                "UPDATE OffboardingRequests SET status = 'PendingDCIImplementation' WHERE status = 'PendingSystemTeam'"
            );
            const c1 = (meta1 && meta1.changes) || 0;
            const c2 = (meta2 && meta2.changes) || 0;
            if (c1 || c2) {
                logger.info(`[Schema] Offboarding status migrated: PendingManagerApproval→PendingDCIManager (${c1}), PendingSystemTeam→PendingDCIImplementation (${c2}).`);
            }
        } catch (err) {
            logger.warn(`[Schema] Offboarding status migration failed (non-fatal): ${err.message}`);
        }

        // Add future columns here as the model evolves.

        // ── Employee Journey Tracking Enhancements (Phase 3) ──────────────
        // Add performance index for employee-centric queries.
        // Employee journey visualization requires fast lookup by employeeId.
        await ensureIndex(sequelize, isSqlite, 'OnboardingRequests', 'idx_onboarding_employee', 'employeeId');

        // One-time schema repair for WorkflowApproverLocationOverrides.
        // Older builds created this table with a column-level UNIQUE on
        // roleKey alone, which allows only ONE override row per role and
        // makes every second per-location save fail with a UNIQUE constraint
        // error. The correct constraint is the composite (roleKey, location).
        // If the bad index is detected we rebuild the table, preserving rows.
        await fixOverrideTableSchema(sequelize, isSqlite);

        // Idempotent seed: ensure every default role exists. Non-fatal — a seed
        // failure must never prevent the server from coming online.
        try {
            for (const cfg of DEFAULT_APPROVER_CONFIGS) {
                const [, created] = await WorkflowApproverConfig.findOrCreate({
                    where: { roleKey: cfg.roleKey },
                    defaults: cfg
                });
                if (created) logger.info(`[Schema] Seeded WorkflowApproverConfig row for ${cfg.roleKey}.`);
            }
        } catch (err) {
            logger.warn(`[Seed] WorkflowApproverConfig seed skipped: ${err.message}`);
        }

        // Remove the phantom OPS_TEAM role that was seeded in older builds.
        // PendingOPSAction is handled by IT_OPS — OPS_TEAM was never used by
        // any workflow stage and only caused confusion in the admin UI.
        try {
            const deleted = await WorkflowApproverConfig.destroy({ where: { roleKey: 'OPS_TEAM' } });
            if (deleted > 0) logger.info(`[Schema] Removed ${deleted} stale OPS_TEAM row(s) from WorkflowApproverConfig.`);
        } catch (err) {
            logger.warn(`[Schema] OPS_TEAM cleanup skipped: ${err.message}`);
        }

        // Seed default system configs if table is empty. Non-fatal.
        try {
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
                for (const cfg of defaults) {
                    await SystemConfig.create(cfg);
                }
                logger.info('Seeded default SystemConfig rows.');
            }
        } catch (err) {
            logger.warn(`[Seed] SystemConfig seed skipped: ${err.message}`);
        }

        // Seed the AD office → location-group map (IBR IT-Ops routing). Runs
        // independently of the bulk seed above so EXISTING installs get it too.
        // Keys are normalized (lowercase) AD office names; values are location
        // group keys (LHR | HO_FSD | TP3_TP4_PG | PP | TP1_TP2). Admins extend it
        // from the System Config admin page; the IBR flow logs any unmapped AD
        // office so the exact string to add is visible.
        try {
            const [, created] = await SystemConfig.findOrCreate({
                where: { key: 'ad_location_group_map' },
                defaults: {
                    key: 'ad_location_group_map',
                    value: {
                        'head office': 'HO_FSD',
                        'faisalabad':  'HO_FSD',
                        'islamabad':   'HO_FSD',
                        'multan':      'HO_FSD',
                        'karachi':     'HO_FSD',
                        'sidhupura':   'HO_FSD',
                        'lahore':      'LHR',
                        'tech park 1': 'TP1_TP2',
                        'tech park 2': 'TP1_TP2',
                        'tech park 3': 'TP3_TP4_PG',
                        'tech park 4': 'TP3_TP4_PG'
                    },
                    description: 'AD office (physicalDeliveryOfficeName) → location group key, for IBR IT-Ops routing'
                }
            });
            if (created) logger.info('Seeded SystemConfig ad_location_group_map.');
        } catch (err) {
            logger.warn(`[Seed] ad_location_group_map seed skipped: ${err.message}`);
        }

        // Seed sample onboarding requests + timeline events for UI demonstration. Non-fatal.
        try {
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
        } catch (err) {
            logger.warn(`[Seed] Sample onboarding seed skipped: ${err.message}`);
        }

        // Start the 48h escalation cron. Runs every 2 hours and automatically
        // re-routes stalled requests to secondary when primary hasn't acted.
        cronService.scheduleEscalationCheck();

        app.listen(PORT, '127.0.0.1', () => {
            logger.info(`Server running on port ${PORT}`);
            // Tell PM2 the app is ready (requires wait_ready: true in ecosystem.config.cjs).
            if (process.send) process.send('ready');
        });
    } catch (err) {
        logger.error(`Failed to start server: ${err.message}`, { error: err, stack: err.stack });
        process.exit(1);
    }
}

startServer();

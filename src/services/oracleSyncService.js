import oracledb from 'oracledb';
import Employee from '../models/Employee.js';
import SyncLog from '../models/SyncLog.js';
import logger from '../utils/logger.js';
import 'dotenv/config';

// Initialize Thick Mode if ORACLE_CLIENT_DIR is provided
try {
    if (process.env.ORACLE_CLIENT_DIR) {
        oracledb.initOracleClient({ libDir: process.env.ORACLE_CLIENT_DIR });
        logger.info(`[OracleSync] Oracle Thick Mode initialized using client at: ${process.env.ORACLE_CLIENT_DIR}`);
    }
} catch (err) {
    logger.error(`[OracleSync] Failed to initialize Oracle Thick Mode:`, err);
}

class OracleSyncService {
    async runSync(syncType = 'MANUAL') {
        const logEntry = await SyncLog.create({ syncType });

        let connection;
        try {
            logger.info(`[OracleSync] Starting ${syncType} HRMS Sync. Log ID: ${logEntry.id}`);

            let rows = [];

            if (process.env.ORACLE_MOCK_MODE === 'true') {
                logger.info(`[OracleSync] MOCK MODE ENABLED. Generating dummy data.`);
                rows = [
                    { EMPLOYEEID: '9001', NAME: 'Mock Ahmed Khan', DESIGNATION: 'Lead Developer', DEPARTMENT: 'IT Dept', EMAIL: 'ahmed.mock@ifl.com', LOCATIONID: 'LHR', MANAGERID: '1002', MANAGER: 'Usman Tariq' },
                    { EMPLOYEEID: '9002', NAME: 'Mock Fatima Ali', DESIGNATION: 'Assistant Manager', DEPARTMENT: 'HR Dept', EMAIL: 'fatima.mock@ifl.com', LOCATIONID: 'FSD', MANAGERID: '1003', MANAGER: 'Aisha Khan' },
                    { EMPLOYEEID: '9003', NAME: 'Mock Usman Tariq', DESIGNATION: 'System Admin', DEPARTMENT: 'IT Dept', EMAIL: 'usman.mock@ifl.com', LOCATIONID: 'FSD', MANAGERID: '1002', MANAGER: 'Usman Tariq' }
                ];
            } else {
                // Connect to Oracle
                connection = await oracledb.getConnection({
                    user: process.env.ORACLE_DB_USER || "ifl",
                    password: process.env.ORACLE_DB_PASSWORD,
                    connectString: process.env.ORACLE_DB_CONNECT_STRING || "192.168.1.37:1526/SID-PROD"
                });

                // Fetch ALL employees for now as requested (no delta yet)
                const sql = `SELECT * FROM IFL.IFL_EMP_INFO_WF_SERVICE`;
                const result = await connection.execute(sql, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
                rows = result.rows || [];
                logger.info(`[OracleSync] Fetched ${rows.length} records from Oracle.`);
            }

            const employeesToUpsert = rows.map(row => ({
                employeeId: row.EMPLOYEEID?.toString() || row.EMPLOYEE_ID?.toString(),
                name: row.NAME || row.EMPLOYEE_NAME,
                designation: row.DESIGNATION,
                mainDept: row.DEPARTMENT || row.MAIN_DEPT,
                email: row.EMAIL || row.EMAIL_ADDRESS,
                locationId: row.LOCATIONID || row.LOCATION,
                managerId: row.MANAGERID || row.MANAGER_ID,
                managerName: row.MANAGER || row.MANAGER_NAME
            })).filter(e => e.employeeId);

            // Perform Bulk Create / Upsert
            await Employee.bulkCreate(employeesToUpsert, {
                updateOnDuplicate: [
                    'name',
                    'designation',
                    'mainDept',
                    'email',
                    'locationId',
                    'managerId',
                    'managerName'
                ]
            });

            // Update Sync Log
            await logEntry.update({
                syncStatus: 'COMPLETED',
                recordsProcessed: employeesToUpsert.length,
                completedAt: new Date()
            });

            logger.info(`[OracleSync] Completed successfully.`);
            return { success: true, processed: employeesToUpsert.length };

        } catch (error) {
            logger.error(`[OracleSync] Failed:`, error);
            await logEntry.update({
                syncStatus: 'FAILED',
                errorMessages: error.message,
                completedAt: new Date()
            });
            return { success: false, error: error.message };
        } finally {
            if (connection) {
                try {
                    await connection.close();
                } catch (err) {
                    logger.error(`[OracleSync] Error closing connection:`, err);
                }
            }
        }
    }
}

export default new OracleSyncService();

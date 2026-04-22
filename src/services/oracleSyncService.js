import oracledb from 'oracledb';
import Employee from '../models/Employee.js';
import SyncLog from '../models/SyncLog.js';
import logger from '../utils/logger.js';
import 'dotenv/config';

// Initialize Thick Mode if ORACLE_CLIENT_DIR is provided
try {
    if (process.env.ORACLE_CLIENT_DIR) {
        // Prevent re-initialization on watch-mode restarts
        if (!oracledb.oracleClientVersionString) {
            oracledb.initOracleClient({ libDir: process.env.ORACLE_CLIENT_DIR });
            logger.info(`[OracleSync] Oracle Thick Mode initialized using client at: ${process.env.ORACLE_CLIENT_DIR}`);
        } else {
            logger.info(`[OracleSync] Oracle Thick Mode already initialized.`);
        }
    }
} catch (err) {
    if (err.message && !err.message.includes('NJS-043')) {
        // NJS-043 means already initialized
        logger.error(`[OracleSync] Failed to initialize Oracle Thick Mode:`, err);
    }
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
                // DEBUG: Print all column names and first record to identify field names
                if (rows.length > 0) {
                    console.log('[OracleSync DEBUG] Available columns:', Object.keys(rows[0]));
                    console.log('[OracleSync DEBUG] First record sample:', JSON.stringify(rows[0], null, 2));
                }
                
                // SPECIFIC DEBUG FOR 128793
                const targetEmployee = rows.find(r => (r.EMPLOYEEID && r.EMPLOYEEID.toString() === '128793') || (r.EMPLOYEE_ID && r.EMPLOYEE_ID.toString() === '128793'));
                if (targetEmployee) {
                    console.log('\n=============================================');
                    console.log('[OracleSync] RAW ORACLE RECORD FOR 128793:');
                    console.log(JSON.stringify(targetEmployee, null, 2));
                    console.log('=============================================\n');
                } else {
                    console.log('[OracleSync DEBUG] Employee 128793 NOT FOUND in Oracle sync results.');
                }
            }

            const employeesToUpsert = rows.map(row => ({
                // --- Identity ---
                employeeId:          row.EMPLOYEEID?.toString(),
                personId:            row.PERSON_ID?.toString(),
                assignmentNumber:    row.ASSIGNMENT_NUMBER,
                rfid:                row.RFID,
                erpUser:             row.ERP_USER,

                // --- Personal ---
                name:                row.NAME,
                fatherName:          row.FATHERNAME,
                dateOfBirth:         row.DATEOFBIRTH,
                gender:              row.GENDER,
                bloodGroup:          row.BLOODGROUP,
                cnic:                row.CNIC,

                // --- Job ---
                designation:         row.DESIGNATIONID,   // Oracle uses DESIGNATIONID
                mainDept:            row.MAIN_DEPT,
                orgElementName:      row.ORGELEMENTNAME,
                unit:                row.UNIT,
                location:            row.LOCATIONID,
                joiningDate:         row.JOININGDATE,
                payroll:             row.PAYROLL,
                assignmentCategory:  row.ASSIGNMENT_CATEGORY,
                employeeCategory:    row.EMPLOYEE_CATEGORY,
                employmentCategory:  row.EMPLOYMENT_CATEGORY,
                employeeType:        row.EMPLOYEE_TYPE,

                // --- Contact ---
                email:               row.EMAIL_ADDRESS,
                mobile:              row.MOBILE,
                extension:           row.EXTENSION,

                // --- Manager ---
                managerId:           row.MANAGER_EMP_ID?.toString() || row.MANAGER_ID?.toString(),
                managerName:         row.MANAGER,
                managerDesignation:  row.MANAGER_DESIGNATION,
                managerEmail:        row.MANAGER_EMAIL_ADDRESS,

                // --- Dates ---
                pposDateStart:           row.PPOS_DATE_START,
                lastResignedDate:        row.LAST_RESIGNED_DATE,
                actualTerminationDate:   row.ACTUAL_TERMINATION_DATE,
            })).filter(e => e.employeeId);

            // Perform Bulk Create / Upsert
            await Employee.bulkCreate(employeesToUpsert, {
                updateOnDuplicate: [
                    'personId',
                    'name',
                    'fatherName',
                    'dateOfBirth',
                    'gender',
                    'cnic',
                    'bloodGroup',
                    'email',
                    'mobile',
                    'extension',
                    'designation',
                    'mainDept',
                    'orgElementName',
                    'location',
                    'unit',
                    'joiningDate',
                    'assignmentCategory',
                    'employeeCategory',
                    'employmentCategory',
                    'employeeType',
                    'assignmentNumber',
                    'payroll',
                    'rfid',
                    'erpUser',
                    'pposDateStart',
                    'lastResignedDate',
                    'actualTerminationDate',
                    'managerId',
                    'managerName',
                    'managerDesignation',
                    'managerEmail'
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

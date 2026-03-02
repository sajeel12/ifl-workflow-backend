import logger from '../utils/logger.js';
import Employee from '../models/Employee.js';

const HRMSService = {
    /**
     * Fetch employee by ID from the local synchronized DB
     */
    getEmployee: async (employeeId) => {
        try {
            logger.info(`[HRMSService] Fetching details for Employee ID: ${employeeId} from local DB`);

            const emp = await Employee.findOne({ where: { employeeId: employeeId } });

            if (!emp) {
                logger.warn(`[HRMSService] Employee not found in local DB: ${employeeId}`);
                return null;
            }

            // Map DB model to what the app expects
            return {
                id: emp.employeeId,
                fullName: emp.name,
                designation: emp.designation,
                department: emp.mainDept || emp.orgElementName,
                projectUnit: emp.unit,
                joiningDate: emp.joiningDate,
                mobile: emp.mobile,
                officeExtension: emp.extension
            };

        } catch (err) {
            logger.error(`[HRMSService] Error fetching employee ${employeeId}: ${err.message}`);
            throw err;
        }
    },

    /**
     * Fetch Reporting Manager (HOD) for an employee from local DB
     */
    getManager: async (employeeId) => {
        try {
            logger.info(`[HRMSService] Fetching Manager for Employee ID: ${employeeId} from local DB`);

            const emp = await Employee.findOne({ where: { employeeId: employeeId } });

            if (!emp || !emp.managerEmail) {
                logger.warn(`[HRMSService] Manager not found for Employee ID: ${employeeId}`);
                return null;
            }

            return {
                email: emp.managerEmail,
                name: emp.managerName,
                id: emp.managerId
            };

        } catch (err) {
            logger.error(`[HRMSService] Error fetching manager: ${err.message}`);
            return null;
        }
    }
};

export default HRMSService;

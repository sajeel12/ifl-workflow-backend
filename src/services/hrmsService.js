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

            let assignedHodName = '';
            
            // Fetch the assigned HOD's name from our local DB relation
            if (emp.hodId) {
                const assignedHod = await Employee.findOne({ where: { employeeId: emp.hodId } });
                if (assignedHod) {
                    assignedHodName = assignedHod.name;
                }
            }

            // Map DB model to what the app expects
            return {
                id:              emp.employeeId,
                fullName:        emp.name,
                designation:     emp.designation,
                department:      emp.mainDept || emp.orgElementName,
                subDepartment:   emp.orgElementName || emp.unit,
                projectUnit:     emp.unit,
                joiningDate:     emp.joiningDate,
                mobile:          emp.mobile,
                officeExtension: emp.extension,
                email:           emp.email,
                hod:             assignedHodName || emp.managerName,   // Prefer our locally assigned HOD over Oracle's
                hodId:           emp.hodId,
                managerEmail:    emp.managerEmail,
                fatherName:      emp.fatherName,
                gender:          emp.gender,
                cnic:            emp.cnic,
                bloodGroup:      emp.bloodGroup,
                payroll:         emp.payroll,
                employeeType:    emp.employeeType,
                location:        emp.location,
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
            logger.info(`[HRMSService] Fetching Manager/hod for Employee ID: ${employeeId} from local DB`);

            const emp = await Employee.findOne({ where: { employeeId: employeeId } });

            if (!emp || !emp.hodId) {
                logger.warn(`[HRMSService] HOD ID not assigned for Employee ID: ${employeeId}`);
                return null;
            }

            // Fetch the HOD's own employee record using the hodId
            const hod = await Employee.findOne({ where: { employeeId: emp.hodId } });

            if (!hod || !hod.email) {
                logger.warn(`[HRMSService] HOD Employee record or email not found for HOD ID: ${emp.hodId}`);
                return null;
            }

            return {
                email: hod.email,
                name: hod.name,
                id: hod.employeeId
            };

        } catch (err) {
            logger.error(`[HRMSService] Error fetching manager: ${err.message}`);
            return null;
        }
    }
};

export default HRMSService;

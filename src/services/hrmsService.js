import logger from '../utils/logger.js';

const HRMS_API_BASE_URL = process.env.HRMS_API_BASE_URL; // e.g. http://api.hrms.local
const HRMS_API_KEY = process.env.HRMS_API_KEY;

const HRMSService = {
    /**
     * Fetch employee by ID
     */
    getEmployee: async (employeeId) => {
        try {
            logger.info(`[HRMSService] Fetching details for Employee ID: ${employeeId}`);

            // 1. Mock Mode Check (if URL not set)
            if (!HRMS_API_BASE_URL) {
                return mockGetEmployee(employeeId);
            }

            // 2. Real API Call
            const response = await fetch(`${HRMS_API_BASE_URL}/employees/${employeeId}`, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': HRMS_API_KEY || ''
                }
            });

            if (!response.ok) {
                throw new Error(`HRMS API Error: ${response.status} ${response.statusText}`);
            }

            const data = await response.json();
            return mapHRMSResponseToApp(data);

        } catch (err) {
            logger.error(`[HRMSService] Error fetching employee ${employeeId}: ${err.message}`);
            // Fallback to mock in dev?
            if (process.env.NODE_ENV !== 'production') return mockGetEmployee(employeeId);
            throw err;
        }
    },

    /**
     * Fetch Reporting Manager (HOD) for an employee
     */
    getManager: async (employeeId) => {
        try {
            logger.info(`[HRMSService] Fetching Manager for Employee ID: ${employeeId}`);

            if (!HRMS_API_BASE_URL) {
                return { email: 'hod.dummy@ifl.com', name: 'Mock HOD', id: '9999' };
            }

            const response = await fetch(`${HRMS_API_BASE_URL}/employees/${employeeId}/manager`, {
                headers: { 'x-api-key': HRMS_API_KEY || '' }
            });

            if (!response.ok) return null; // Or throw

            return await response.json(); // Expected: { email: '...', name: '...' }
        } catch (err) {
            logger.error(`[HRMSService] Error fetching manager: ${err.message}`);
            if (process.env.NODE_ENV !== 'production') return { email: 'hod.dummy@ifl.com', name: 'Mock HOD', id: '9999' };
            return null;
        }
    }
};

// Helper: Map external API format to internal app format
const mapHRMSResponseToApp = (data) => {
    return {
        id: data.employeeCode || data.id,
        fullName: data.name || data.fullName,
        designation: data.designation,
        department: data.department,
        projectUnit: data.unit || data.projectUnit,
        joiningDate: data.dateOfJoining || data.joiningDate,
        mobile: data.contactNumber || data.mobile,
        officeExtension: data.extension || ''
    };
};

// Mock Data Helper
const mockGetEmployee = (id) => {
    return new Promise(resolve => setTimeout(() => {
        const mock = {
            id: id,
            fullName: 'Test Employee Name',
            designation: 'Senior Software Engineer',
            department: 'Information Technology',
            projectUnit: 'Head Office',
            joiningDate: '2023-01-15',
            mobile: '0300-1234567',
            officeExtension: '1234'
        };
        if (id === '1001') {
            mock.fullName = 'Ahmed Ali';
            mock.designation = 'Assistant Manager';
            mock.department = 'Finance';
        }
        resolve(mock);
    }, 200));
};

export default HRMSService;

import workflowService from '../services/workflowService.js';
import Employee from '../models/Employee.js';
import logger from '../utils/logger.js';
import adService from '../services/adService.js';

export const startOnboarding = async (req, res) => {
    const { name, email, department, managerEmail } = req.body;
    const requester = req.user.username; // From SSO Middleware

    try {
        // Validate Manager
        if (managerEmail) {
            const isManagerValid = await adService.validateManager(managerEmail);
            if (!isManagerValid) {
                return res.status(400).json({ error: `Manager email '${managerEmail}' not found in Active Directory` });
            }
        }

        // 1. Create/Update Employee Record
        // Check if exists
        let employee = await Employee.findOne({ where: { email } });
        if (!employee) {
            // Generate partial ID or use email as ID for now
            employee = await Employee.create({
                employeeId: email, // Simplification
                name,
                email,
                department,
                managerEmail,
                status: 'Onboarding'
            });
        }

        // 2. Start Workflow
        const request = await workflowService.initiateOnboarding(employee.employeeId, managerEmail, requester);

        res.json({ success: true, requestId: request.requestId });

    } catch (error) {
        logger.error('Start Onboarding Error', error);
        res.status(500).json({ error: error.message });
    }
};

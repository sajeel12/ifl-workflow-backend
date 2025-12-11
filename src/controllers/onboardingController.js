import AccessRequest from '../models/AccessRequest.js';
import Employee from '../models/Employee.js';
import * as workflowService from '../services/workflowService.js';
import logger from '../utils/logger.js';

export const createAccessRequest = async (req, res) => {
    try {
        const { requestType, justification } = req.body;
        // req.user comes from ssoMiddleware
        // For now we assume we have user data. If Employee table is empty, we might need to upsert Employee first.

        // Upsert Employee (Ensure they exist in DB)
        const [emp, created] = await Employee.findOrCreate({
            where: { email: req.user.email },
            defaults: {
                name: req.user.displayName,
                department: req.user.department || 'Unknown',
                managerEmail: req.user.manager || 'manager@example.com', // Validation needed
                status: 'Active'
            }
        });

        const newReq = await AccessRequest.create({
            employeeId: emp.employeeId,
            requestType,
            justification
        });

        // Start Workflow
        // Using mock manager if AD manager is null/string-dn
        const managerEmail = emp.managerEmail.includes('@') ? emp.managerEmail : 'manager@test.com';

        await workflowService.startAccessRequestWorkflow(
            newReq.requestId,
            emp.employeeId,
            managerEmail,
            justification
        );

        res.status(201).json({ message: 'Request submitted successfully', requestId: newReq.requestId });
    } catch (err) {
        logger.error(err);
        res.status(500).json({ error: err.message });
    }
};

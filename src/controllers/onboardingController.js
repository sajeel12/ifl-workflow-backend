import AccessRequest from '../models/AccessRequest.js';
import Employee from '../models/Employee.js';
import * as workflowService from '../services/workflowService.js';
import { getDepartmentHead } from '../services/adService.js';
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

        // Get Department Head from AD based on employee's department
        let deptHeadEmail;
        try {
            deptHeadEmail = await getDepartmentHead(emp.department);
            logger.info(`[Onboarding] Department Head for ${emp.department}: ${deptHeadEmail}`);
        } catch (err) {
            logger.error(`[Onboarding] Failed to get department head: ${err.message}`);
            // Fallback to configured default
            deptHeadEmail = process.env.DEFAULT_DEPT_HEAD_EMAIL || 'dept-head@test.com';
            logger.warn(`[Onboarding] Using fallback department head: ${deptHeadEmail}`);
        }

        // Get manager email (fallback if not valid)
        const managerEmail = emp.managerEmail?.includes('@') ? emp.managerEmail : 'manager@test.com';

        // Start Workflow with both manager and department head
        await workflowService.startAccessRequestWorkflow(
            newReq.requestId,
            emp.employeeId,
            managerEmail,
            deptHeadEmail,
            justification,
            emp.email,  // Requester email for notifications
            requestType // Request type for notifications
        );

        res.status(201).json({ message: 'Request submitted successfully', requestId: newReq.requestId });
    } catch (err) {
        logger.error(err);
        res.status(500).json({ error: err.message });
    }
};

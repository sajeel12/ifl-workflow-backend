import AccessRequest from '../models/AccessRequest.js';
import Employee from '../models/Employee.js';
import * as workflowService from '../services/workflowService.js';
import { getDepartmentHead } from '../services/adService.js';
import logger from '../utils/logger.js';

export const createAccessRequest = async (req, res) => {
    try {
        const { requestType, justification } = req.body;

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

        let deptHeadEmail;
        try {
            deptHeadEmail = await getDepartmentHead(emp.department);
            logger.info(`[Onboarding] Department Head for ${emp.department}: ${deptHeadEmail}`);
        } catch (err) {
            logger.error(`[Onboarding] Failed to get department head: ${err.message}`);
            deptHeadEmail = process.env.DEFAULT_DEPT_HEAD_EMAIL || 'dept-head@test.com';
            logger.warn(`[Onboarding] Using fallback department head: ${deptHeadEmail}`);
        }

        const managerEmail = emp.managerEmail?.includes('@') ? emp.managerEmail : 'manager@test.com';

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

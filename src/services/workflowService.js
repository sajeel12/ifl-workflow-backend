// Need to export models from index.js first, assuming standard sequelize pattern.
// Let's quickly create src/models/index.js if it doesn't exist, or just import individually.
// Importing individually for now to avoid circular deps if index.js isn't set up yet.
import AccessRequestModel from '../models/AccessRequest.js';
import WorkflowApprovalModel from '../models/WorkflowApproval.js';
import TimelineEventModel from '../models/TimelineEvent.js';
import EmployeeModel from '../models/Employee.js';

import emailService from './emailService.js';
import logger from '../utils/logger.js';
import sequelize from '../config/database.js';

class WorkflowService {

    async initiateOnboarding(employeeId, managerEmail, requesterId) {
        const t = await sequelize.transaction();
        try {
            // 1. Create Request
            const request = await AccessRequestModel.create({
                employeeId: employeeId,
                requestType: 'Onboarding',
                status: 'Pending',
                workflowStage: 'Manager Approval'
            }, { transaction: t });

            // 2. Generate Token
            const token = emailService.generateActionToken(request.requestId);

            // 3. Create Approval Record
            await WorkflowApprovalModel.create({
                requestId: request.requestId,
                approverEmail: managerEmail,
                status: 'Pending',
                actionToken: token
            }, { transaction: t });

            // 4. Log Event
            await TimelineEventModel.create({
                employeeId: employeeId,
                eventType: 'ONBOARDING_INITIATED',
                description: `Onboarding initiated by ${requesterId}`
            }, { transaction: t });

            await t.commit();

            // 5. Send Email (Outside transaction to avoid locking if SMTP is slow)
            // Fetch details for email
            const employee = await EmployeeModel.findByPk(employeeId);
            await emailService.sendApprovalEmail(managerEmail, {
                requestId: request.requestId,
                employeeName: employee ? employee.name : employeeId,
                requestType: 'Onboarding'
            }, token);

            return request;

        } catch (error) {
            await t.rollback();
            logger.error('Error initiating onboarding', error);
            throw error;
        }
    }

    async handleApprovalAction(token, action, comment) {
        const t = await sequelize.transaction();
        try {
            // 1. Find Approval
            const approval = await WorkflowApprovalModel.findOne({
                where: { actionToken: token },
                include: [AccessRequestModel] // Eager load request
            });

            if (!approval) {
                throw new Error('Invalid or Expired Token');
            }

            if (approval.status !== 'Pending') {
                return { success: false, message: 'Request already processed' };
            }

            // 2. Update Approval
            approval.status = action; // 'Approved' or 'Rejected'
            approval.decisionDate = new Date();
            approval.comment = comment;
            await approval.save({ transaction: t });

            // 3. Update Request Logic (Simple State Machine)
            const request = await AccessRequestModel.findByPk(approval.requestId, { transaction: t });

            if (action === 'Rejected') {
                request.status = 'Rejected';
                request.workflowStage = 'Closed';
            } else {
                // If Approved, move to next stage?
                // For this demo, functionality is: Manager Approves -> Done (or IT Provisioning)
                request.status = 'Approved';
                request.workflowStage = 'IT Provisioning';
                // In a real app, you might trigger next approval here
            }
            await request.save({ transaction: t });

            // 4. Log Event
            await TimelineEventModel.create({
                employeeId: request.employeeId,
                eventType: `REQUEST_${action.toUpperCase()}`,
                description: `Manager ${action} the request. Comment: ${comment || 'None'}`
            }, { transaction: t });

            await t.commit();
            return { success: true, message: `Request ${action}` };

        } catch (error) {
            await t.rollback();
            logger.error('Error handling approval', error);
            throw error;
        }
    }
}

export default new WorkflowService();

import AccessRequest from '../models/AccessRequest.js';
import WorkflowApproval from '../models/WorkflowApproval.js';
import TimelineEvent from '../models/TimelineEvent.js';
import { sendApprovalEmail } from './emailService.js';
import crypto from 'crypto';
import logger from '../utils/logger.js';
// import { findUser } from './adService.js'; // if needed for manager lookup

export const startAccessRequestWorkflow = async (requestId, employeeId, managerEmail, justification) => {
    logger.info(`[Workflow] Starting for Request #${requestId}`);

    try {
        // 1. Log Event
        await TimelineEvent.create({
            employeeId,
            eventType: 'RequestSubmitted',
            description: 'Access request submitted by user.'
        });

        // 2. Create Approval Record for Manager
        const token = crypto.randomBytes(20).toString('hex');
        const approval = await WorkflowApproval.create({
            requestId,
            approverEmail: managerEmail,
            status: 'Pending',
            actionToken: token
        });

        // 3. Send Email
        // Construct Action Link (Pointing to GET/POST handler)
        const baseUrl = process.env.APP_URL || 'http://localhost:3000';
        const actionLink = `${baseUrl}/api/approvals/handle?token=${token}`;

        await sendApprovalEmail(
            managerEmail,
            `Action Required: Access Request #${requestId}`,
            `User requested access. Justification: "${justification}"`,
            actionLink
        );

        // 4. Update Request Status
        await AccessRequest.update(
            { status: 'Pending', workflowStage: 'ManagerApproval' },
            { where: { requestId } }
        );

    } catch (err) {
        logger.error(`[Workflow] Error starting: ${err.message}`);
        throw err;
    }
};

export const handleApprovalAction = async (token, action, comment) => {
    logger.info(`[Workflow] Handling action '${action}' for token ${token}`);

    const approval = await WorkflowApproval.findOne({ where: { actionToken: token } });
    if (!approval) {
        throw new Error('Invalid Token');
    }

    if (approval.status !== 'Pending') {
        return { status: 'AlreadyProcessed', message: 'This request has already been processed.' };
    }

    // Update Approval
    approval.status = action; // Approve / Reject
    approval.decisionDate = new Date();
    approval.comment = comment;
    await approval.save();

    // Determine Next Step
    const req = await AccessRequest.findByPk(approval.requestId);

    if (action === 'Approve') {
        req.status = 'Approved';
        req.workflowStage = 'Completed'; // Or trigger IT provisioning step
        await req.save();

        await TimelineEvent.create({
            employeeId: req.employeeId,
            eventType: 'ManagerApproved',
            description: `Manager approved the request. Comment: ${comment || 'None'}`
        });

        // Optional: Trigger Provisioning Service here
    } else {
        req.status = 'Rejected';
        req.workflowStage = 'Closed';
        await req.save();

        await TimelineEvent.create({
            employeeId: req.employeeId,
            eventType: 'ManagerRejected',
            description: `Manager rejected the request. Comment: ${comment || 'None'}`
        });
    }

    return { status: 'Success', message: `Request has been ${action}d.` };
}

import AccessRequest from '../models/AccessRequest.js';
import WorkflowApproval from '../models/WorkflowApproval.js';
import TimelineEvent from '../models/TimelineEvent.js';
import { sendApprovalEmail, sendRequesterNotification } from './emailService.js';
import crypto from 'crypto';
import logger from '../utils/logger.js';
import Employee from '../models/Employee.js';
// import { findUser } from './adService.js'; // if needed for manager lookup

/**
 * Helper function to get requester email from employee ID
 */
async function getRequesterEmail(employeeId) {
    try {
        const employee = await Employee.findByPk(employeeId);
        return employee?.email || null;
    } catch (err) {
        logger.error(`[Workflow] Error fetching requester email: ${err.message}`);
        return null;
    }
}

export const startAccessRequestWorkflow = async (requestId, employeeId, managerEmail, deptHeadEmail, justification, requesterEmail, requestType) => {
    logger.info(`[Workflow] Starting for Request #${requestId}`);

    try {
        // 1. Log Event
        await TimelineEvent.create({
            employeeId,
            eventType: 'RequestSubmitted',
            description: 'Access request submitted by user.'
        });

        // 2. Create Approval Records for Both Levels (Level 1 = Manager, Level 2 = Dept Head)
        const level1Token = crypto.randomBytes(20).toString('hex');
        const level2Token = crypto.randomBytes(20).toString('hex');

        // Level 1: Manager Approval (Active)
        await WorkflowApproval.create({
            requestId,
            approverEmail: managerEmail,
            status: 'Pending',
            actionToken: level1Token,
            approvalLevel: 1,
            approverRole: 'Manager'
        });

        // Level 2: Department Head Approval (Waiting for Level 1)
        await WorkflowApproval.create({
            requestId,
            approverEmail: deptHeadEmail,
            status: 'Waiting', // Not Pending yet - waiting for Level 1
            actionToken: level2Token,
            approvalLevel: 2,
            approverRole: 'DepartmentHead'
        });

        // 3. Send Email to Level 1 (Manager) Only
        const baseUrl = process.env.APP_URL || 'http://localhost:3000';
        const actionLink = `${baseUrl}/api/approvals/handle?token=${level1Token}`;

        await sendApprovalEmail(
            managerEmail,
            `Action Required: Access Request #${requestId}`,
            `User requested access. Justification: "${justification}"`,
            actionLink
        );

        // 4. Update Request Status
        await AccessRequest.update(
            { status: 'Pending', workflowStage: 'Level1-ManagerApproval' },
            { where: { requestId } }
        );

        // 5. Notify Requester - Submission Confirmation
        if (requesterEmail) {
            await sendRequesterNotification(
                requesterEmail,
                'Access Request Submitted',
                `Your access request #${requestId} has been submitted successfully and is now pending manager approval.`,
                {
                    requestId,
                    requestType: requestType || 'Access Request',
                    status: 'Submitted',
                    currentStage: 'Pending Manager Approval'
                }
            );
        }

        logger.info(`[Workflow] Created two-level approval workflow for Request #${requestId}`);

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
        // Check which level approved
        if (approval.approvalLevel === 1) {
            // Level 1 (Manager) Approved - Move to Level 2
            logger.info(`[Workflow] Level 1 approved for Request #${req.requestId}, moving to Level 2`);

            await TimelineEvent.create({
                employeeId: req.employeeId,
                eventType: 'Level1Approved',
                description: `Manager approved the request. Comment: ${comment || 'None'}`
            });

            // Find Level 2 Approval Record
            const level2Approval = await WorkflowApproval.findOne({
                where: {
                    requestId: req.requestId,
                    approvalLevel: 2
                }
            });

            if (level2Approval) {
                // Activate Level 2
                level2Approval.status = 'Pending';
                await level2Approval.save();

                // Send Email to Department Head
                const baseUrl = process.env.APP_URL || 'http://localhost:3000';
                const actionLink = `${baseUrl}/api/approvals/handle?token=${level2Approval.actionToken}`;

                // Build message with manager's approval comment
                let emailMessage = `Manager has approved this request.\n\n`;
                emailMessage += `Original Justification: "${req.justification}"\n\n`;
                if (comment) {
                    emailMessage += `Manager's Comment: "${comment}"`;
                } else {
                    emailMessage += `Manager's Comment: (No comment provided)`;
                }

                await sendApprovalEmail(
                    level2Approval.approverEmail,
                    `Action Required: Access Request #${req.requestId}`,
                    emailMessage,
                    actionLink
                );

                // Update Request Status
                req.status = 'Pending';
                req.workflowStage = 'Level2-DeptHeadApproval';
                await req.save();

                // Notify Requester - Level 1 Approved
                const requester = await getRequesterEmail(req.employeeId);
                if (requester) {
                    await sendRequesterNotification(
                        requester,
                        'Access Request - Manager Approved',
                        `Good news! Your manager has approved your access request #${req.requestId}. It is now with the Department Head for final approval.`,
                        {
                            requestId: req.requestId,
                            requestType: req.requestType,
                            status: 'Level1Approved',
                            currentStage: 'Pending Department Head Approval',
                            comment: comment
                        }
                    );
                }

                return { status: 'Success', message: 'Level 1 approved. Request moved to Level 2 (Department Head).' };
            } else {
                logger.error(`[Workflow] Level 2 approval record not found for Request #${req.requestId}`);
                throw new Error('Level 2 approval record not found');
            }

        } else if (approval.approvalLevel === 2) {
            // Level 2 (Department Head) Approved - Complete Workflow
            logger.info(`[Workflow] Level 2 approved for Request #${req.requestId}, completing workflow`);

            req.status = 'Approved';
            req.workflowStage = 'Completed';
            await req.save();

            await TimelineEvent.create({
                employeeId: req.employeeId,
                eventType: 'Level2Approved',
                description: `Department Head approved the request. Comment: ${comment || 'None'}`
            });

            // Notify Requester - Workflow Complete
            const requester = await getRequesterEmail(req.employeeId);
            if (requester) {
                await sendRequesterNotification(
                    requester,
                    'Access Request Approved',
                    `Congratulations! Your access request #${req.requestId} has been fully approved by both your manager and department head.`,
                    {
                        requestId: req.requestId,
                        requestType: req.requestType,
                        status: 'Approved',
                        currentStage: 'Completed - Approved',
                        comment: comment
                    }
                );
            }

            return { status: 'Success', message: 'Level 2 approved. Request completed successfully.' };
        }

    } else {
        // Rejected at any level - Close workflow
        logger.info(`[Workflow] Request #${req.requestId} rejected at Level ${approval.approvalLevel}`);

        req.status = 'Rejected';
        req.workflowStage = 'Closed';
        await req.save();

        const eventType = approval.approvalLevel === 1 ? 'Level1Rejected' : 'Level2Rejected';
        const rejecterRole = approval.approverRole;

        await TimelineEvent.create({
            employeeId: req.employeeId,
            eventType: eventType,
            description: `${rejecterRole} rejected the request. Comment: ${comment || 'None'}`
        });

        // Notify Requester - Rejection
        const requester = await getRequesterEmail(req.employeeId);
        if (requester) {
            await sendRequesterNotification(
                requester,
                'Access Request Rejected',
                `Your access request #${req.requestId} has been rejected by the ${rejecterRole}.`,
                {
                    requestId: req.requestId,
                    requestType: req.requestType,
                    status: 'Rejected',
                    currentStage: 'Closed - Rejected',
                    rejecterRole: rejecterRole,
                    comment: comment
                }
            );
        }

        return { status: 'Success', message: `Request rejected at Level ${approval.approvalLevel}.` };
    }

    return { status: 'Success', message: `Request has been ${action}d.` };
}

import AccessRequest from '../models/AccessRequest.js';
import WorkflowApproval from '../models/WorkflowApproval.js';
import TimelineEvent from '../models/TimelineEvent.js';
import { sendApprovalEmail, sendRequesterNotification } from './emailService.js';
import crypto from 'crypto';
import logger from '../utils/logger.js';
import Employee from '../models/Employee.js';

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
        await TimelineEvent.create({
            employeeId,
            eventType: 'RequestSubmitted',
            description: 'Access request submitted by user.'
        });

        const requester = await Employee.findByPk(employeeId);
        const requesterName = requester ? requester.name : 'Unknown User';

        const level1Token = crypto.randomBytes(20).toString('hex');
        const level2Token = crypto.randomBytes(20).toString('hex');

        await WorkflowApproval.create({
            requestId,
            approverEmail: managerEmail,
            status: 'Pending',
            actionToken: level1Token,
            approvalLevel: 1,
            approverRole: 'Manager'
        });

        await WorkflowApproval.create({
            requestId,
            approverEmail: deptHeadEmail,
            status: 'Waiting',
            actionToken: level2Token,
            approvalLevel: 2,
            approverRole: 'DepartmentHead'
        });

        const baseUrl = process.env.APP_URL;
        const actionLink = `${baseUrl}/api/approvals/handle?token=${level1Token}`;

        await sendApprovalEmail(
            managerEmail,
            `Action Required: Access Request #${requestId}`,
            `User requested access. Justification: "${justification}"`,
            actionLink,
            requesterName,
            requesterEmail || (requester ? requester.email : 'Unknown Email')
        );

        await AccessRequest.update(
            { status: 'Pending', workflowStage: 'Level1-ManagerApproval' },
            { where: { requestId } }
        );

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

    approval.status = action;
    approval.decisionDate = new Date();
    approval.comment = comment;
    await approval.save();

    const req = await AccessRequest.findByPk(approval.requestId);

    if (action === 'Approve') {
        if (approval.approvalLevel === 1) {
            logger.info(`[Workflow] Level 1 approved for Request #${req.requestId}, moving to Level 2`);

            await TimelineEvent.create({
                employeeId: req.employeeId,
                eventType: 'Level1Approved',
                description: `Manager approved the request. Comment: ${comment || 'None'}`
            });

            const level2Approval = await WorkflowApproval.findOne({
                where: {
                    requestId: req.requestId,
                    approvalLevel: 2
                }
            });

            if (level2Approval) {
                level2Approval.status = 'Pending';
                await level2Approval.save();

                const requester = await Employee.findByPk(req.employeeId);
                const requesterName = requester ? requester.name : 'Unknown User';

                const baseUrl = process.env.APP_URL;
                const actionLink = `${baseUrl}/api/approvals/handle?token=${level2Approval.actionToken}`;

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
                    actionLink,
                    requesterName,
                    requester ? requester.email : 'Unknown Email'
                );

                req.status = 'Pending';
                req.workflowStage = 'Level2-DeptHeadApproval';
                await req.save();

                const requesterEmail = await getRequesterEmail(req.employeeId);
                if (requesterEmail) {
                    await sendRequesterNotification(
                        requesterEmail,
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
            logger.info(`[Workflow] Level 2 approved for Request #${req.requestId}, completing workflow`);

            req.status = 'Approved';
            req.workflowStage = 'Completed';
            await req.save();

            await TimelineEvent.create({
                employeeId: req.employeeId,
                eventType: 'Level2Approved',
                description: `Department Head approved the request. Comment: ${comment || 'None'}`
            });

            const requesterEmail = await getRequesterEmail(req.employeeId);
            if (requesterEmail) {
                await sendRequesterNotification(
                    requesterEmail,
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

        const requesterEmail = await getRequesterEmail(req.employeeId);
        if (requesterEmail) {
            await sendRequesterNotification(
                requesterEmail,
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
};

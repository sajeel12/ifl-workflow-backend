import AccessRequest from '../models/AccessRequest.js';
import Employee from '../models/Employee.js';
import WorkflowApproval from '../models/WorkflowApproval.js';
import TimelineEvent from '../models/TimelineEvent.js';
import * as workflowService from '../services/workflowService.js';
import logger from '../utils/logger.js';

// Hardcoded test emails for two-level approval
const TEST_EMAILS = {
    EMPLOYEE: 'sajeel.dilshad@perception-it.com',
    MANAGER: 'sajeel.dilshad@perception-it.com',
    DEPT_HEAD: 'sajeel.dilshad@perception-it.com'
};

/**
 * Create a test Access Request with hardcoded emails
 * No authentication required - for testing purposes only
 */
export const createTestAccessRequest = async (req, res) => {
    try {
        const { requestType, justification } = req.body;

        logger.info('[Test] Creating test access request');

        // 1. Ensure test employee exists
        const [emp, created] = await Employee.findOrCreate({
            where: { email: TEST_EMAILS.EMPLOYEE },
            defaults: {
                name: 'Test Employee',
                department: 'Engineering',
                managerEmail: TEST_EMAILS.MANAGER,
                status: 'Active'
            }
        });

        if (created) {
            logger.info('[Test] Created test employee');
        }

        // 2. Create Access Request
        const newReq = await AccessRequest.create({
            employeeId: emp.employeeId,
            requestType: requestType || 'SharePoint Access',
            justification: justification || 'Test access request for workflow testing'
        });

        logger.info(`[Test] Created Access Request #${newReq.requestId}`);

        // 3. Start Two-Level Workflow
        await workflowService.startAccessRequestWorkflow(
            newReq.requestId,
            emp.employeeId,
            TEST_EMAILS.MANAGER,
            TEST_EMAILS.DEPT_HEAD,
            newReq.justification,
            TEST_EMAILS.EMPLOYEE,  // Requester email for notifications
            newReq.requestType     // Request type for notifications
        );

        // 4. Get approval tokens for testing
        const approvals = await WorkflowApproval.findAll({
            where: { requestId: newReq.requestId },
            order: [['approvalLevel', 'ASC']]
        });

        const level1Approval = approvals.find(a => a.approvalLevel === 1);
        const level2Approval = approvals.find(a => a.approvalLevel === 2);

        res.status(201).json({
            message: 'Test access request created successfully',
            requestId: newReq.requestId,
            employeeId: emp.employeeId,
            testEmails: TEST_EMAILS,
            approvalTokens: {
                level1: {
                    token: level1Approval?.actionToken,
                    approver: level1Approval?.approverEmail,
                    role: level1Approval?.approverRole,
                    status: level1Approval?.status
                },
                level2: {
                    token: level2Approval?.actionToken,
                    approver: level2Approval?.approverEmail,
                    role: level2Approval?.approverRole,
                    status: level2Approval?.status
                }
            },
            nextSteps: [
                `1. Email sent to ${TEST_EMAILS.MANAGER} for Level 1 approval`,
                `2. Use POST /api/test/approve/${level1Approval?.actionToken} to approve/reject Level 1`,
                `3. After Level 1 approval, email will be sent to ${TEST_EMAILS.DEPT_HEAD}`,
                `4. Use POST /api/test/approve/${level2Approval?.actionToken} to approve/reject Level 2`
            ]
        });

    } catch (err) {
        logger.error(`[Test] Error creating test request: ${err.message}`);
        res.status(500).json({ error: err.message, stack: err.stack });
    }
};

/**
 * Get the status of a specific request including all approvals
 */
export const getRequestStatus = async (req, res) => {
    try {
        const { requestId } = req.params;

        const request = await AccessRequest.findByPk(requestId);
        if (!request) {
            return res.status(404).json({ error: 'Request not found' });
        }

        const approvals = await WorkflowApproval.findAll({
            where: { requestId },
            order: [['approvalLevel', 'ASC']]
        });

        const timeline = await TimelineEvent.findAll({
            where: { employeeId: request.employeeId },
            order: [['createdAt', 'DESC']],
            limit: 10
        });

        res.json({
            request: {
                requestId: request.requestId,
                requestType: request.requestType,
                justification: request.justification,
                status: request.status,
                workflowStage: request.workflowStage,
                createdAt: request.createdAt
            },
            approvals: approvals.map(a => ({
                level: a.approvalLevel,
                role: a.approverRole,
                approverEmail: a.approverEmail,
                status: a.status,
                decisionDate: a.decisionDate,
                comment: a.comment,
                token: a.actionToken
            })),
            timeline: timeline.map(t => ({
                eventType: t.eventType,
                description: t.description,
                timestamp: t.createdAt
            }))
        });

    } catch (err) {
        logger.error(`[Test] Error getting request status: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
};

/**
 * Direct approval/rejection for testing (bypasses email)
 */
export const testApproveReject = async (req, res) => {
    try {
        const { token } = req.params;
        const { action, comment } = req.body;

        if (!action || !['Approve', 'Reject'].includes(action)) {
            return res.status(400).json({ error: 'Invalid action. Use "Approve" or "Reject"' });
        }

        logger.info(`[Test] Processing ${action} for token ${token}`);

        const result = await workflowService.handleApprovalAction(token, action, comment);

        res.json({
            ...result,
            timestamp: new Date()
        });

    } catch (err) {
        logger.error(`[Test] Error processing approval: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
};

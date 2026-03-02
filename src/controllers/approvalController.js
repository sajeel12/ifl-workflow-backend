import * as workflowService from '../services/workflowService.js';
import WorkflowApproval from '../models/WorkflowApproval.js';
import AccessRequest from '../models/AccessRequest.js';
import Employee from '../models/Employee.js';
import logger from '../utils/logger.js';


export const handleApprovalClick = async (req, res) => {
    const { token } = req.query;
    const { action, comment } = req.body;

    logger.info(`[Approval] Request received - Method: ${req.method}, Token: ${token}, Action: ${action}`);

    try {
        if (!token) {
            return res.status(400).render('pages/message', {
                title: 'Invalid Request',
                heading: 'Invalid Request',
                titleClass: 'error',
                message: 'No approval token provided.'
            });
        }

        const approval = await WorkflowApproval.findOne({ where: { actionToken: token } });

        if (!approval) {
            return res.status(404).render('pages/message', {
                title: 'Invalid Token',
                heading: 'Invalid Token',
                titleClass: 'error',
                message: 'This approval link is invalid or has expired.'
            });
        }

        if (approval.status !== 'Pending') {
            const dateStr = new Date(approval.decisionDate).toLocaleString();
            let metaHtml = `<div class="meta">Decision Date: ${dateStr}</div>`;
            if (approval.comment) {
                metaHtml += `<div class="meta">Comment: "${approval.comment}"</div>`;
            }
            return res.status(200).render('pages/message', {
                title: 'Already Processed',
                heading: 'Already Processed',
                titleClass: 'info',
                message: `This request has already been <strong>${approval.status.toLowerCase()}</strong>.`,
                metaHtml: metaHtml
            });
        }

        const request = await AccessRequest.findByPk(approval.requestId);
        const requester = await Employee.findByPk(request.employeeId);
        const requesterName = requester ? requester.name : 'Unknown User';
        const requesterEmail = requester ? requester.email : '';

        if (req.method === 'GET') {
            return res.render('pages/approval_form', {
                title: 'Access Request Approval',
                token,
                approval,
                request,
                requesterName,
                requesterEmail
            });
        }

        if (req.method === 'POST') {
            if (!action || !['Approve', 'Reject'].includes(action)) {
                return res.status(400).render('pages/message', {
                    title: 'Invalid Action',
                    heading: 'Invalid Action',
                    titleClass: 'error',
                    message: 'The submitted action is invalid.'
                });
            }

            logger.info(`[Approval] Processing ${action} for token ${token}`);
            await workflowService.handleApprovalAction(token, action, comment || '');

            const isApproved = action === 'Approve';
            const nextLevel = approval.approvalLevel === 1 ? 'Department Head' : '';

            let messageHtml = `<strong>Request #${request.requestId}</strong> has been ${action.toLowerCase()}d.<br><br>`;
            if (isApproved && nextLevel) messageHtml += `The request will now be sent to the ${nextLevel} for final approval.`;
            if (!isApproved) messageHtml += `The requester has been notified of the rejection.`;
            if (isApproved && !nextLevel) messageHtml += `The workflow is now complete.`;

            let metaHtml = '';
            if (comment) {
                metaHtml = `<div class="comment-box ${isApproved ? 'success' : 'error'}"><strong>Your Comment:</strong><br>${comment}</div>`;
            }

            return res.render('pages/message', {
                title: 'Action Processed',
                heading: 'Action Processed',
                icon: isApproved ? '✅' : '❌',
                iconClass: isApproved ? 'success-icon' : 'error-icon',
                message: messageHtml,
                metaHtml: metaHtml
            });
        }

    } catch (err) {
        logger.error(`[Approval] Error: ${err.message}`);
        return res.status(500).render('pages/message', {
            title: 'Error',
            heading: 'Error Processing Request',
            titleClass: 'error',
            message: err.message
        });
    }
};

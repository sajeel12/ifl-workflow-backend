import * as workflowService from '../services/workflowService.js';
import WorkflowApproval from '../models/WorkflowApproval.js';
import AccessRequest from '../models/AccessRequest.js';
import logger from '../utils/logger.js';

/**
 * Handles approval click from email or browser
 * GET: Shows form for comment
 * POST: Processes the approval
 */
export const handleApprovalClick = async (req, res) => {
    const { token } = req.query;
    const { action, comment } = req.body;

    logger.info(`[Approval] Request received - Method: ${req.method}, Token: ${token}, Action: ${action}`);

    try {
        // Validate token exists
        if (!token) {
            return res.status(400).send(`
                <html>
                <head><title>Error</title></head>
                <body style="font-family: Arial; padding: 40px; text-align: center;">
                    <h2 style="color: #D13438;">Invalid Request</h2>
                    <p>No approval token provided.</p>
                </body>
                </html>
            `);
        }

        // Fetch approval details
        const approval = await WorkflowApproval.findOne({ where: { actionToken: token } });

        if (!approval) {
            return res.status(404).send(`
                <html>
                <head><title>Error</title></head>
                <body style="font-family: Arial; padding: 40px; text-align: center;">
                    <h2 style="color: #D13438;">Invalid Token</h2>
                    <p>This approval link is invalid or has expired.</p>
                </body>
                </html>
            `);
        }

        // Check if already processed
        if (approval.status !== 'Pending') {
            return res.status(200).send(`
                <html>
                <head><title>Already Processed</title></head>
                <body style="font-family: Arial; padding: 40px; text-align: center;">
                    <h2 style="color: #0078D4;">Already Processed</h2>
                    <p>This request has already been ${approval.status.toLowerCase()}.</p>
                    <p style="color: #666; font-size: 14px;">Decision Date: ${new Date(approval.decisionDate).toLocaleString()}</p>
                    ${approval.comment ? `<p style="color: #666; font-size: 14px;">Comment: "${approval.comment}"</p>` : ''}
                </body>
                </html>
            `);
        }

        // Get request details for display
        const request = await AccessRequest.findByPk(approval.requestId);

        // GET request - Show approval form
        if (req.method === 'GET') {
            return res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Access Request Approval</title>
                    <meta name="viewport" content="width=device-width, initial-scale=1">
                    <style>
                        * {
                            margin: 0;
                            padding: 0;
                            box-sizing: border-box;
                        }
                        body {
                            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                            min-height: 100vh;
                            display: flex;
                            justify-content: center;
                            align-items: center;
                            padding: 20px;
                        }
                        .container {
                            background: white;
                            border-radius: 12px;
                            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
                            max-width: 600px;
                            width: 100%;
                            overflow: hidden;
                        }
                        .header {
                            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                            color: white;
                            padding: 30px;
                            text-align: center;
                        }
                        .header h1 {
                            font-size: 24px;
                            margin-bottom: 5px;
                        }
                        .header p {
                            opacity: 0.9;
                            font-size: 14px;
                        }
                        .content {
                            padding: 30px;
                        }
                        .request-info {
                            background: #f8f9fa;
                            border-left: 4px solid #667eea;
                            padding: 20px;
                            margin-bottom: 25px;
                            border-radius: 4px;
                        }
                        .info-row {
                            margin-bottom: 12px;
                        }
                        .info-row:last-child {
                            margin-bottom: 0;
                        }
                        .label {
                            font-weight: 600;
                            color: #495057;
                            font-size: 13px;
                            text-transform: uppercase;
                            letter-spacing: 0.5px;
                            margin-bottom: 4px;
                            display: block;
                        }
                        .value {
                            color: #212529;
                            font-size: 15px;
                        }
                        .form-group {
                            margin-bottom: 20px;
                        }
                        label {
                            display: block;
                            margin-bottom: 8px;
                            font-weight: 600;
                            color: #495057;
                        }
                        textarea {
                            width: 100%;
                            padding: 12px;
                            border: 2px solid #dee2e6;
                            border-radius: 6px;
                            font-family: inherit;
                            font-size: 14px;
                            resize: vertical;
                            min-height: 100px;
                            transition: border-color 0.2s;
                        }
                        textarea:focus {
                            outline: none;
                            border-color: #667eea;
                        }
                        .button-group {
                            display: flex;
                            gap: 12px;
                            margin-top: 25px;
                        }
                        button {
                            flex: 1;
                            padding: 14px 24px;
                            border: none;
                            border-radius: 6px;
                            font-size: 16px;
                            font-weight: 600;
                            cursor: pointer;
                            transition: all 0.3s;
                            text-transform: uppercase;
                            letter-spacing: 0.5px;
                        }
                        .btn-approve {
                            background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%);
                            color: white;
                        }
                        .btn-approve:hover {
                            transform: translateY(-2px);
                            box-shadow: 0 5px 15px rgba(17, 153, 142, 0.4);
                        }
                        .btn-reject {
                            background: linear-gradient(135deg, #eb3349 0%, #f45c43 100%);
                            color: white;
                        }
                        .btn-reject:hover {
                            transform: translateY(-2px);
                            box-shadow: 0 5px 15px rgba(235, 51, 73, 0.4);
                        }
                        .help-text {
                            font-size: 13px;
                            color: #6c757d;
                            margin-top: 6px;
                        }
                        @media (max-width: 600px) {
                            .button-group {
                                flex-direction: column;
                            }
                            button {
                                width: 100%;
                            }
                        }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <div class="header">
                            <h1>🔐 Access Request Approval</h1>
                            <p>Request #${request.requestId} - ${approval.approverRole}</p>
                        </div>
                        
                        <div class="content">
                            <div class="request-info">
                                <div class="info-row">
                                    <span class="label">Request Type</span>
                                    <span class="value">${request.requestType}</span>
                                </div>
                                <div class="info-row">
                                    <span class="label">Justification</span>
                                    <span class="value">${request.justification}</span>
                                </div>
                                <div class="info-row">
                                    <span class="label">Current Stage</span>
                                    <span class="value">${request.workflowStage}</span>
                                </div>
                            </div>

                            <form method="POST" action="/api/approvals/handle?token=${token}">
                                <div class="form-group">
                                    <label for="comment">Your Comment (Optional)</label>
                                    <textarea 
                                        id="comment" 
                                        name="comment" 
                                        placeholder="Add your comment here... (e.g., 'Approved - legitimate business need' or 'Rejected - insufficient justification')"
                                    ></textarea>
                                    <div class="help-text">
                                        💡 Add context for your decision. This will be visible to the requester and in the audit trail.
                                    </div>
                                </div>

                                <div class="button-group">
                                    <button type="submit" name="action" value="Approve" class="btn-approve">
                                        ✓ Approve
                                    </button>
                                    <button type="submit" name="action" value="Reject" class="btn-reject">
                                        ✗ Reject
                                    </button>
                                </div>
                            </form>
                        </div>
                    </div>
                </body>
                </html>
            `);
        }

        // POST request - Process the action
        if (req.method === 'POST') {
            if (!action || !['Approve', 'Reject'].includes(action)) {
                return res.status(400).send('Invalid action');
            }

            logger.info(`[Approval] Processing ${action} for token ${token}`);

            const result = await workflowService.handleApprovalAction(token, action, comment || '');

            // Show success page
            const isApproved = action === 'Approve';
            const nextLevel = approval.approvalLevel === 1 ? 'Department Head' : '';

            return res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Success</title>
                    <style>
                        body {
                            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                            background: linear-gradient(135deg, ${isApproved ? '#11998e 0%, #38ef7d' : '#eb3349 0%, #f45c43'} 100%);
                            min-height: 100vh;
                            display: flex;
                            justify-content: center;
                            align-items: center;
                            padding: 20px;
                        }
                        .success-container {
                            background: white;
                            border-radius: 12px;
                            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
                            max-width: 500px;
                            width: 100%;
                            padding: 40px;
                            text-align: center;
                        }
                        .icon {
                            font-size: 64px;
                            margin-bottom: 20px;
                        }
                        h1 {
                            color: ${isApproved ? '#11998e' : '#eb3349'};
                            margin-bottom: 15px;
                        }
                        p {
                            color: #666;
                            line-height: 1.6;
                            margin-bottom: 10px;
                        }
                        .comment-box {
                            background: #f8f9fa;
                            padding: 15px;
                            border-radius: 6px;
                            margin-top: 20px;
                            border-left: 4px solid ${isApproved ? '#11998e' : '#eb3349'};
                        }
                        .comment-label {
                            font-weight: 600;
                            color: #495057;
                            font-size: 13px;
                            margin-bottom: 8px;
                        }
                        .comment-text {
                            color: #212529;
                            font-style: italic;
                        }
                    </style>
                </head>
                <body>
                    <div class="success-container">
                        <div class="icon">${isApproved ? '✅' : '❌'}</div>
                        <h1>Request ${action}d Successfully!</h1>
                        <p><strong>Request #${request.requestId}</strong> has been ${action.toLowerCase()}d.</p>
                        ${isApproved && nextLevel ? `<p>The request will now be sent to the ${nextLevel} for final approval.</p>` : ''}
                        ${!isApproved ? `<p>The requester has been notified of the rejection.</p>` : ''}
                        ${isApproved && !nextLevel ? `<p>The workflow is now complete. The requester has been notified.</p>` : ''}
                        
                        ${comment ? `
                            <div class="comment-box">
                                <div class="comment-label">YOUR COMMENT:</div>
                                <div class="comment-text">"${comment}"</div>
                            </div>
                        ` : ''}
                    </div>
                </body>
                </html>
            `);
        }

    } catch (err) {
        logger.error(`[Approval] Error: ${err.message}`);
        return res.status(500).send(`
            <html>
            <head><title>Error</title></head>
            <body style="font-family: Arial; padding: 40px; text-align: center;">
                <h2 style="color: #D13438;">Error Processing Request</h2>
                <p>${err.message}</p>
            </body>
            </html>
        `);
    }
};

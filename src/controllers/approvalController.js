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
            return res.status(400).send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Invalid Request</title>
                    <style>
                        body { font-family: 'Segoe UI', sans-serif; background-color: #faf9f8; margin: 0; }
                        .header { background-color: #0078D4; padding: 15px 20px; display: flex; align-items: center; gap: 15px; }
                        .logo { height: 40px; padding: 5px; }
                        .brand { color: white; font-weight: 600; font-size: 18px; margin: 0; }
                        .container { max-width: 600px; margin: 40px auto; background: white; padding: 40px; box-shadow: 0 1.6px 3.6px 0 rgba(0,0,0,0.132); text-align: center; }
                        h2 { color: #D13438; margin-top: 0; font-weight: 600; }
                        p { color: #323130; }
                    </style>
                </head>
                <body>
                    <div class="header">
                        <img src="/logo.png" alt="IFL Logo" class="logo">
                         
                    </div>
                    <div class="container">
                        <h2>Invalid Request</h2>
                        <p>No approval token provided.</p>
                    </div>
                </body>
                </html>
            `);
        }


        const approval = await WorkflowApproval.findOne({ where: { actionToken: token } });

        if (!approval) {
            return res.status(404).send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Invalid Token</title>
                    <style>
                        body { font-family: 'Segoe UI', sans-serif; background-color: #faf9f8; margin: 0; }
                        .header { background-color: #0078D4; padding: 15px 20px; display: flex; align-items: center; gap: 15px; }
                        .logo { height: 40px;  padding: 5px; }
                        .brand { color: white; font-weight: 600; font-size: 18px; margin: 0; }
                        .container { max-width: 600px; margin: 40px auto; background: white; padding: 40px; box-shadow: 0 1.6px 3.6px 0 rgba(0,0,0,0.132); text-align: center; }
                        h2 { color: #D13438; margin-top: 0; font-weight: 600; }
                        p { color: #323130; }
                    </style>
                </head>
                <body>
                    <div class="header">
                        <img src="/logo.png" alt="IFL Logo" class="logo">
                         
                    </div>
                    <div class="container">
                        <h2>Invalid Token</h2>
                        <p>This approval link is invalid or has expired.</p>
                    </div>
                </body>
                </html>
            `);
        }


        if (approval.status !== 'Pending') {
            return res.status(200).send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Already Processed</title>
                    <style>
                        body { font-family: 'Segoe UI', sans-serif; background-color: #faf9f8; margin: 0; }
                        .header { background-color: #0078D4; padding: 15px 20px; display: flex; align-items: center; gap: 15px; }
                        .logo { height: 40px; padding: 5px; }
                        .brand { color: white; font-weight: 600; font-size: 18px; margin: 0; }
                        .container { max-width: 600px; margin: 40px auto; background: white; padding: 40px; box-shadow: 0 1.6px 3.6px 0 rgba(0,0,0,0.132); text-align: center; }
                        h2 { color: #0078D4; margin-top: 0; font-weight: 600; }
                        p { color: #323130; margin-bottom: 20px; }
                        .meta { color: #605e5c; font-size: 13px; margin-top: 10px; }
                    </style>
                </head>
                <body>
                    <div class="header">
                        <img src="/logo.png" alt="IFL Logo" class="logo">
                         
                    </div>
                    <div class="container">
                        <h2>Already Processed</h2>
                        <p>This request has already been <strong>${approval.status.toLowerCase()}</strong>.</p>
                        <div class="meta">Decision Date: ${new Date(approval.decisionDate).toLocaleString()}</div>
                        ${approval.comment ? `<div class="meta">Comment: "${approval.comment}"</div>` : ''}
                    </div>
                </body>
                </html>
            `);
        }


        const request = await AccessRequest.findByPk(approval.requestId);

        const requester = await Employee.findByPk(request.employeeId);
        const requesterName = requester ? requester.name : 'Unknown User';


        if (req.method === 'GET') {
            return res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Access Request Approval</title>
                    <meta name="viewport" content="width=device-width, initial-scale=1">
                    <style>
                        * { margin: 0; padding: 0; box-sizing: border-box; }
                        body {
                            font-family: 'Segoe UI', 'Segoe UI Web (West European)', 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, 'Helvetica Neue', sans-serif;
                            background-color: #faf9f8;
                            color: #323130;
                        }
                        .header {
                            background-color: #0078D4;
                            padding: 16px 24px;
                            display: flex;
                            align-items: center;
                            gap: 16px;
                            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                        }
                        .logo {
                            height: 48px;
                            padding: 6px;

                        }
                        .brand {
                            color: white;
                            font-weight: 600;
                            font-size: 20px;
                        }
                        .main-container {
                            max-width: 720px;
                            margin: 40px auto;
                            padding: 0 20px;
                        }
                        .card {
                            background: white;
                            box-shadow: 0 1.6px 3.6px 0 rgba(0,0,0,0.132), 0 0.3px 0.9px 0 rgba(0,0,0,0.108);
                            padding: 32px;

                            border-radius: 0; 
                        }
                        h1 {
                            font-size: 24px;
                            font-weight: 600;
                            margin-bottom: 8px;
                            color: #201f1e;
                        }
                        .subtitle {
                            color: #605e5c;
                            font-size: 14px;
                            margin-bottom: 32px;
                        }
                        .section-title {
                            font-size: 14px;
                            font-weight: 600;
                            color: #0078D4;
                            text-transform: uppercase;
                            letter-spacing: 0.5px;
                            margin-bottom: 16px;
                            border-bottom: 2px solid #0078D4;
                            display: inline-block;
                            padding-bottom: 4px;
                        }
                        .info-grid {
                            display: grid;
                            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                            gap: 24px;
                            margin-bottom: 32px;
                            background: #f3f2f1;
                            padding: 20px;
                        }
                        .field-label {
                            font-size: 12px;
                            font-weight: 600;
                            color: #605e5c;
                            margin-bottom: 4px;
                        }
                        .field-value {
                            font-size: 15px;
                            font-weight: 400;
                        }
                        .form-group {
                            margin-bottom: 24px;
                        }
                        label {
                            display: block;
                            margin-bottom: 8px;
                            font-weight: 600;
                            font-size: 14px;
                        }
                        textarea {
                            width: 100%;
                            padding: 12px;
                            border: 1px solid #8a8886;
                            font-family: inherit;
                            font-size: 14px;
                            resize: vertical;
                            min-height: 100px;
                            border-radius: 0; 
                        }
                        textarea:focus {
                            outline: 2px solid #0078D4;
                            border-color: transparent;
                        }
                        .help-text {
                            font-size: 12px;
                            color: #605e5c;
                            margin-top: 4px;
                        }
                        .button-group {
                            display: flex;
                            gap: 12px;
                            margin-top: 32px;
                        }
                        button {
                            flex: 1;
                            padding: 12px 24px;
                            border: none;
                            font-size: 15px;
                            font-weight: 600;
                            cursor: pointer;
                            transition: background-color 0.2s;
                            border-radius: 0; 
                        }
                        .btn-approve {
                            background-color: #107C10; 
                            color: white;
                        }
                        .btn-approve:hover {
                            background-color: #0c5d0c;
                        }
                        .btn-reject {
                            background-color: #D13438; 
                            color: white;
                        }
                        .btn-reject:hover {
                            background-color: #a4262c;
                        }
                        @media (max-width: 600px) {
                            .button-group { flex-direction: column; }
                        }
                    </style>
                </head>
                <body>
                    <div class="header">
                        <img src="/logo.png" alt="IFL Logo" class="logo">
                         
                    </div>
                    <div class="main-container">
                        <div class="card">
                            <h1>Access Request Approval</h1>
                            <p class="subtitle">Request #${request.requestId} • ${approval.approverRole}</p>
                            
                            <div class="section-title">Request Details</div>
                            <div class="info-grid">
                                <div>
                                    <div class="field-label">REQUESTER</div>
                                    <div class="field-value">${requesterName}</div>
                                </div>
                                <div>
                                    <div class="field-label">REQUEST TYPE</div>
                                    <div class="field-value">${request.requestType}</div>
                                </div>
                                <div>
                                    <div class="field-label">CURRENT STAGE</div>
                                    <div class="field-value">${request.workflowStage}</div>
                                </div>
                                <div style="grid-column: 1/-1">
                                    <div class="field-label">JUSTIFICATION</div>
                                    <div class="field-value">${request.justification}</div>
                                </div>
                            </div>

                            <form method="POST" action="/api/approvals/handle?token=${token}">
                                <div class="form-group">
                                    <label for="comment">Approver Comment (Optional)</label>
                                    <textarea 
                                        id="comment" 
                                        name="comment" 
                                        placeholder="Add context for your decision..."
                                    ></textarea>
                                    <div class="help-text">
                                        This comment will be recorded in the audit trail.
                                    </div>
                                </div>

                                <div class="button-group">
                                    <button type="submit" name="action" value="Approve" class="btn-approve">
                                        Approve Request
                                    </button>
                                    <button type="submit" name="action" value="Reject" class="btn-reject">
                                        Reject Request
                                    </button>
                                </div>
                            </form>
                        </div>
                    </div>
                </body>
                </html>
            `);
        }


        if (req.method === 'POST') {
            if (!action || !['Approve', 'Reject'].includes(action)) {
                return res.status(400).send('Invalid action');
            }

            logger.info(`[Approval] Processing ${action} for token ${token}`);

            const result = await workflowService.handleApprovalAction(token, action, comment || '');


            const isApproved = action === 'Approve';
            const nextLevel = approval.approvalLevel === 1 ? 'Department Head' : '';

            return res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Success</title>
                    <style>
                        body { font-family: 'Segoe UI', sans-serif; background-color: #faf9f8; margin: 0; }
                        .header { background-color: #0078D4; padding: 15px 20px; display: flex; align-items: center; gap: 15px; }
                        .logo { height: 40px;padding: 5px; }
                        .brand { color: white; font-weight: 600; font-size: 18px; margin: 0; }
                        .container { max-width: 600px; margin: 40px auto; background: white; padding: 40px; box-shadow: 0 1.6px 3.6px 0 rgba(0,0,0,0.132); text-align: center; }
                        .icon { font-size: 48px; margin-bottom: 20px; color: ${isApproved ? '#107C10' : '#D13438'}; }
                        h1 { color: #201f1e; margin-bottom: 10px; font-weight: 600; }
                        p { color: #323130; margin-bottom: 20px; text-align: left; }
                        .comment-box { background: #f3f2f1; padding: 15px; margin-top: 20px; border-left: 4px solid ${isApproved ? '#107C10' : '#D13438'}; text-align: left; }
                    </style>
                </head>
                <body>
                    <div class="header">
                        <img src="/logo.png" alt="IFL Logo" class="logo">
                         
                    </div>
                    <div class="container">
                        <div class="icon">${isApproved ? '✅' : '❌'}</div>
                        <h1>Action Processed</h1>
                        <p><strong>Request #${request.requestId}</strong> has been ${action.toLowerCase()}d.</p>
                        ${isApproved && nextLevel ? `<p>The request will now be sent to the ${nextLevel} for final approval.</p>` : ''}
                        ${!isApproved ? `<p>The requester has been notified of the rejection.</p>` : ''}
                        ${isApproved && !nextLevel ? `<p>The workflow is now complete.</p>` : ''}
                        
                        ${comment ? `
                            <div class="comment-box">
                                <strong>Your Comment:</strong>
                                <br>${comment}
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
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Error</title>
                    <style>
                        body { font-family: 'Segoe UI', sans-serif; background-color: #faf9f8; margin: 0; }
                        .header { background-color: #0078D4; padding: 15px 20px; display: flex; align-items: center; gap: 15px; }
                        .logo { height: 40px; padding: 5px; }
                        .brand { color: white; font-weight: 600; font-size: 18px; margin: 0; }
                        .container { max-width: 600px; margin: 40px auto; background: white; padding: 40px; box-shadow: 0 1.6px 3.6px 0 rgba(0,0,0,0.132); text-align: center; }
                        h2 { color: #D13438; margin-top: 0; font-weight: 600; }
                        p { color: #323130; }
                    </style>
                </head>
                <body>
                    <div class="header">
                        <img src="/logo.png" alt="IFL Logo" class="logo">
                         
                    </div>
                    <div class="container">
                        <h2>Error Processing Request</h2>
                        <p>${err.message}</p>
                    </div>
                </body>
                </html>
            `);
    }
};

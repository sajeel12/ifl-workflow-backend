import nodemailer from 'nodemailer';
import logger from '../utils/logger.js';

// Transporter Init
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '25', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    },
    tls: {
        ciphers: 'SSLv3', // Often helps with Outlook/Office365
        rejectUnauthorized: false
    }
});

/**
 * Send an approval email with Actionable Message Adaptive Card + Fallback Link
 */
export const sendApprovalEmail = async (toEmail, subject, requestDetails, approvalLink) => {
    logger.info(`[Email] Sending approval email to ${toEmail}`);

    // Adaptive Card JSON
    // Note: For "Universal Action model", sending a simple Action.Http is deprecated in some versions,
    // but On-Prem support varies. We will try a standard Adaptive Card with Action.Http (or OpenUrl as fallback).
    const adaptiveCardPayload = {
        "type": "AdaptiveCard",
        "version": "1.0",
        "originator": process.env.ACTIONABLE_MESSAGE_PROVIDER_ID || "ProviderID-Guid-Here-If-Registered",
        "body": [
            {
                "type": "TextBlock",
                "text": subject,
                "weight": "Bolder",
                "size": "Medium"
            },
            {
                "type": "TextBlock",
                "text": requestDetails,
                "wrap": true
            }
        ],
        "actions": [
            {
                "type": "Action.Http",
                "title": "Approve",
                "method": "POST",
                "url": approvalLink + "&action=Approve",
                "style": "positive",
                "body": "{}"
            },
            {
                "type": "Action.Http",
                "title": "Reject",
                "method": "POST",
                "url": approvalLink + "&action=Reject",
                "style": "destructive",
                "body": "{}"
            },
            {
                "type": "Action.OpenUrl",
                "title": "View Request (Browser)",
                "url": approvalLink // Just opens the link
            }
        ]
    };

    // HTML Body (Fallback)
    const htmlBody = `
    <html>
    <body>
      <h3>${subject}</h3>
      <p>${requestDetails}</p>
      <p>
        <!-- Fallback buttons for non-adaptive clients -->
        <a href="${approvalLink}&action=Approve" style="padding: 10px 20px; background-color: green; color: white; text-decoration: none;">Approve</a>
        &nbsp;&nbsp;
        <a href="${approvalLink}&action=Reject" style="padding: 10px 20px; background-color: red; color: white; text-decoration: none;">Reject</a>
      </p>
      <p style="font-size: small; color: gray;">
        If buttons do not work, reply to this email.
      </p>
      <script type="application/adaptivecard+json">
        ${JSON.stringify(adaptiveCardPayload)}
      </script>
    </body>
    </html>
  `;

    try {
        const info = await transporter.sendMail({
            from: process.env.SMTP_FROM,
            to: toEmail,
            subject: subject,
            html: htmlBody
        });
        logger.info(`[Email] Sent: ${info.messageId}`);
        return info;
    } catch (err) {
        logger.error(`[Email] Failed to send: ${err.message}`);
        throw err;
    }
};

/**
 * Send a notification email to the requester about workflow status
 */
export const sendRequesterNotification = async (toEmail, subject, message, requestDetails) => {
    logger.info(`[Email] Sending requester notification to ${toEmail}`);

    const { requestId, requestType, status, currentStage, rejecterRole, comment } = requestDetails;

    // Build status-specific content
    let statusMessage = '';
    let statusColor = '#0078D4'; // Default blue
    let nextSteps = '';

    if (status === 'Submitted') {
        statusColor = '#0078D4';
        nextSteps = 'Your manager will review your request and take action.';
    } else if (status === 'Level1Approved') {
        statusColor = '#107C10'; // Green
        nextSteps = 'Your request is now with the Department Head for final approval.';
    } else if (status === 'Approved') {
        statusColor = '#107C10'; // Green
        nextSteps = 'Your access will be provisioned shortly. You will receive another notification once complete.';
    } else if (status === 'Rejected') {
        statusColor = '#D13438'; // Red
        nextSteps = 'If you believe this is an error, please contact your manager or IT support.';
    }

    const htmlBody = `
    <html>
    <head>
        <style>
            body {
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                line-height: 1.6;
                color: #333;
                max-width: 600px;
                margin: 0 auto;
            }
            .header {
                background-color: ${statusColor};
                color: white;
                padding: 20px;
                text-align: center;
                border-radius: 5px 5px 0 0;
            }
            .content {
                background-color: #f9f9f9;
                padding: 30px;
                border: 1px solid #ddd;
                border-top: none;
                border-radius: 0 0 5px 5px;
            }
            .request-details {
                background-color: white;
                padding: 20px;
                margin: 20px 0;
                border-left: 4px solid ${statusColor};
                border-radius: 3px;
            }
            .detail-row {
                margin: 10px 0;
            }
            .label {
                font-weight: bold;
                color: #666;
            }
            .next-steps {
                background-color: #e8f4f8;
                padding: 15px;
                margin-top: 20px;
                border-radius: 3px;
                border-left: 4px solid #0078D4;
            }
            .footer {
                margin-top: 20px;
                padding-top: 20px;
                border-top: 1px solid #ddd;
                font-size: 12px;
                color: #666;
                text-align: center;
            }
        </style>
    </head>
    <body>
        <div class="header">
            <h2 style="margin: 0;">${subject}</h2>
        </div>
        <div class="content">
            <p>${message}</p>
            
            <div class="request-details">
                <h3 style="margin-top: 0; color: ${statusColor};">Request Details</h3>
                <div class="detail-row">
                    <span class="label">Request ID:</span> #${requestId}
                </div>
                <div class="detail-row">
                    <span class="label">Request Type:</span> ${requestType}
                </div>
                <div class="detail-row">
                    <span class="label">Current Status:</span> ${currentStage || status}
                </div>
                ${rejecterRole ? `
                <div class="detail-row">
                    <span class="label">Rejected By:</span> ${rejecterRole}
                </div>
                ` : ''}
                ${comment ? `
                <div class="detail-row">
                    <span class="label">Comment:</span> ${comment}
                </div>
                ` : ''}
            </div>

            ${nextSteps ? `
            <div class="next-steps">
                <strong>Next Steps:</strong><br/>
                ${nextSteps}
            </div>
            ` : ''}
        </div>
        <div class="footer">
            <p>This is an automated notification from the Workflow System.<br/>
            Please do not reply to this email.</p>
        </div>
    </body>
    </html>
    `;

    try {
        const info = await transporter.sendMail({
            from: process.env.SMTP_FROM,
            to: toEmail,
            subject: subject,
            html: htmlBody
        });
        logger.info(`[Email] Requester notification sent: ${info.messageId}`);
        return info;
    } catch (err) {
        logger.error(`[Email] Failed to send requester notification: ${err.message}`);
        // Don't throw - notification failure shouldn't break the workflow
        logger.warn(`[Email] Continuing workflow despite notification failure`);
    }
};

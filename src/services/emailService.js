import nodemailer from 'nodemailer';
import logger from '../utils/logger.js';

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


export const sendApprovalEmail = async (toEmail, subject, requestDetails, approvalLink, requesterName, requesterEmail) => {
    logger.info(`[Email] Sending approval email to ${toEmail}`);

    const adaptiveCardPayload = {
        "type": "AdaptiveCard",
        "version": "1.0",
        "originator": process.env.ACTIONABLE_MESSAGE_PROVIDER_ID || "ProviderID-Guid-Here-If-Registered",
        "body": [
            {
                "type": "TextBlock",
                "text": "Ibrahim Fibres Limited",
                "weight": "Bolder",
                "size": "Medium",
                "color": "Accent"
            },
            {
                "type": "TextBlock",
                "text": subject,
                "weight": "Bolder",
                "size": "Medium"
            },
            {
                "type": "FactSet",
                "facts": [
                    {
                        "title": "Requester:",
                        "value": `${requesterName || "Unknown"} <${requesterEmail || "No Email"}>`
                    }
                ]
            },
            {
                "type": "TextBlock",
                "text": requestDetails,
                "wrap": true
            }
        ],
        "actions": [
            {
                "type": "Action.OpenUrl",
                "title": "Review & Approve/Reject",
                "url": approvalLink
            }
        ]
    };

    const htmlBody = `
    <!DOCTYPE html>
    <html>
    <head>
        <style>
            body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f3f2f1; margin: 0; padding: 0; }
            .container { max-width: 600px; margin: 20px auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
            .header { background-color: #0078D4; padding: 20px; text-align: center; }
            .header h1 { color: #ffffff; margin: 0; font-size: 20px; font-weight: 600; }
            .content { padding: 30px; color: #323130; }
            .info-box { background-color: #f8f9fa; border-left: 4px solid #0078D4; padding: 15px; margin-bottom: 20px; }
            .label { font-weight: 600; color: #605e5c; font-size: 13px; text-transform: uppercase; }
            .value { font-size: 16px; font-weight: 500; color: #201f1e; margin-bottom: 10px; display: block; }
            .email-text { font-size: 14px; color: #605e5c; font-weight: 400; }
            .button { display: inline-block; padding: 12px 24px; background-color: #0078D4; color: white; text-decoration: none; border-radius: 4px; font-weight: 600; margin-top: 10px; }
            .button:hover { background-color: #005a9e; }
            .footer { background-color: #f3f2f1; padding: 15px; text-align: center; color: #605e5c; font-size: 12px; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>Ibrahim Fibres Limited</h1>
            </div>
            <div class="content">
                <h2 style="color: #0078D4; margin-top: 0;">${subject}</h2>
                
                <div class="info-box">
                    <span class="label">REQUESTER</span>
                    <span class="value">
                        ${requesterName || 'Unknown'} 
                        <br/>
                        <span class="email-text">(${requesterEmail || 'No Email'})</span>
                    </span>
                    
                    <span class="label">DETAILS</span>
                    <p style="margin-top: 5px; line-height: 1.5;">${requestDetails}</p>
                </div>

                <div style="text-align: center;">
                    <a href="${approvalLink}" class="button">Review & Approve/Reject</a>
                </div>
            </div>
            <div class="footer">
                <p>This is an automated notification from the IFL Workflow System.</p>
            </div>
        </div>
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


export const sendRequesterNotification = async (toEmail, subject, message, requestDetails) => {
    logger.info(`[Email] Sending requester notification to ${toEmail}`);

    const { requestId, requestType, status, currentStage, rejecterRole, comment } = requestDetails;

    let statusColor = '#0078D4'; // Default blue
    let statusIcon = 'ℹ️';
    let nextSteps = '';

    if (status === 'Submitted') {
        statusColor = '#0078D4';
        statusIcon = '📤';
        nextSteps = 'Your manager will review your request and take action.';
    } else if (status === 'Level1Approved') {
        statusColor = '#107C10'; // Green
        statusIcon = '✅';
        nextSteps = 'Your request is now with the Department Head for final approval.';
    } else if (status === 'Approved') {
        statusColor = '#107C10'; // Green
        statusIcon = '🎉';
        nextSteps = 'Your access will be provisioned shortly. You will receive another notification once complete.';
    } else if (status === 'Rejected') {
        statusColor = '#D13438'; // Red
        statusIcon = '❌';
        nextSteps = 'If you believe this is an error, please contact your manager or IT support.';
    }

    const htmlBody = `
    <!DOCTYPE html>
    <html>
    <head>
        <style>
            body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f3f2f1; margin: 0; padding: 0; }
            .container { max-width: 600px; margin: 20px auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
            .header { background-color: #0078D4; padding: 20px; text-align: center; }
            .header h1 { color: #ffffff; margin: 0; font-size: 20px; font-weight: 600; }
            .content { padding: 30px; color: #323130; }
            .status-banner { background-color: ${statusColor}; color: white; padding: 10px 15px; border-radius: 4px; margin-bottom: 20px; font-weight: 600; display: flex; align-items: center; gap: 10px; }
            .info-box { background-color: #f8f9fa; border: 1px solid #e1dfdd; padding: 20px; border-radius: 4px; }
            .row { display: flex; justify-content: space-between; margin-bottom: 10px; border-bottom: 1px solid #eee; padding-bottom: 10px; }
            .row:last-child { border-bottom: none; margin-bottom: 0; padding-bottom: 0; }
            .label { font-weight: 600; color: #605e5c; }
            .value { font-weight: 400; color: #201f1e; }
            .next-steps { background-color: #eff6fc; border-left: 4px solid #0078D4; padding: 15px; margin-top: 20px; }
            .footer { background-color: #f3f2f1; padding: 15px; text-align: center; color: #605e5c; font-size: 12px; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>Ibrahim Fibres Limited</h1>
            </div>
            <div class="content">
                <div class="status-banner">
                    <span style="font-size: 20px;">${statusIcon}</span>
                    <span>${subject}</span>
                </div>
                
                <p style="margin-bottom: 20px; line-height: 1.6;">${message}</p>
                
                <div class="info-box">
                    <div class="row">
                        <span class="label">Request ID</span>
                        <span class="value">#${requestId}</span>
                    </div>
                    <div class="row">
                        <span class="label">Type</span>
                        <span class="value">${requestType}</span>
                    </div>
                    <div class="row">
                        <span class="label">Status</span>
                        <span class="value" style="color: ${statusColor}; font-weight: 600;">${currentStage || status}</span>
                    </div>
                    ${rejecterRole ? `
                    <div class="row">
                        <span class="label">Rejected By</span>
                        <span class="value">${rejecterRole}</span>
                    </div>
                    ` : ''}
                    ${comment ? `
                    <div style="margin-top: 10px; border-top: 1px solid #eee; padding-top: 10px;">
                        <span class="label" style="display:block; margin-bottom:5px;">Comment:</span>
                        <span class="value" style="font-style: italic;">"${comment}"</span>
                    </div>
                    ` : ''}
                </div>

                ${nextSteps ? `
                <div class="next-steps">
                    <strong style="color: #0078D4; display: block; margin-bottom: 5px;">Next Steps</strong>
                    ${nextSteps}
                </div>
                ` : ''}
            </div>
            <div class="footer">
                <p>This is an automated notification from the IFL Workflow System.<br>Please do not reply to this email.</p>
            </div>
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
        logger.warn(`[Email] Continuing workflow despite notification failure`);
    }
};

export const sendOnboardingITNotification = async (toEmail, request, actionLink) => {
    const subject = `IT Action Required: Onboarding Request #${request.id} for ${request.fullName}`;
    const message = `A new onboarding request has been submitted for ${request.fullName} (${request.designation}, ${request.department}). Please configure the required services.`;

    // Detailed list of requested services
    const services = [];
    if (request.intranetAccess) services.push('Intranet');
    if (request.internetAccess) services.push('Internet');
    if (request.emailIncoming || request.emailOutgoing) services.push('Email');
    if (request.laserPrinter) services.push(`Laser Printer (${request.laserPrinterLocation})`);

    const requestDetails = `Services Required: ${services.join(', ') || 'None'}`;

    return sendApprovalEmail(toEmail, subject, message + '\n\n' + requestDetails, actionLink, request.fullName, '');
};

export const sendOnboardingDSINotification = async (toEmail, request, actionLink) => {
    const subject = `DSI Approval Required: Onboarding Request #${request.id} for ${request.fullName}`;
    const message = `IT has completed the configuration for ${request.fullName}. Please review and provide final approval.`;

    return sendApprovalEmail(toEmail, subject, message, actionLink, request.fullName, '');
};

import nodemailer from 'nodemailer';
import logger from '../utils/logger.js';

// Transporter Init
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '25', 10),
    secure: process.env.SMTP_SECURE === 'true',
    // auth: { user: ..., pass: ... } // Uncomment if relay requires auth
    tls: {
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

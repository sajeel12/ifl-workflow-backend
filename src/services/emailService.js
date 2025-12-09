import nodemailer from 'nodemailer';
import crypto from 'crypto';
import logger from '../utils/logger.js';
import dotenv from 'dotenv';
dotenv.config();

class EmailService {
    constructor() {
        this.transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: process.env.SMTP_PORT,
            secure: process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
            // auth: process.env.SMTP_USER ? {
            //   user: process.env.SMTP_USER,
            //   pass: process.env.SMTP_PASS
            // } : null,
            tls: {
                rejectUnauthorized: false
            }
        });
    }

    generateActionToken(requestId) {
        // Determine uniqueness: requestId + secret + timestamp
        return crypto.createHmac('sha256', process.env.JWT_SECRET)
            .update(`${requestId}-${Date.now()}`)
            .digest('hex');
    }

    getAdaptiveCard(requestId, employeeName, requestType, actionToken) {
        const handleUrl = `${process.env.APP_URL}/api/approvals/handle?token=${actionToken}`;

        // Note: Adaptive Cards in Outlook often require specific signed headers or "Actionable Email" registration.
        // We are providing a fallback Link Button approach for On-Prem robust compatibility.
        // This JSON is the "script" part of the HTML body.
        return {
            type: "AdaptiveCard",
            version: "1.0",
            body: [
                {
                    type: "TextBlock",
                    text: `Approval Request: ${requestType}`,
                    weight: "Bolder",
                    size: "Large"
                },
                {
                    type: "TextBlock",
                    text: `Employee: ${employeeName}`,
                    wrap: true
                }
            ],
            actions: [
                {
                    type: "Action.Http",
                    title: "Approve",
                    method: "POST",
                    url: handleUrl, // In real O365, this must be a signed endpoint or whitelisted
                    body: JSON.stringify({ action: "Approved" }),
                    headers: [{ name: "Content-Type", value: "application/json" }]
                },
                {
                    type: "Action.Http",
                    title: "Reject",
                    method: "POST",
                    url: handleUrl,
                    body: JSON.stringify({ action: "Rejected" }),
                    headers: [{ name: "Content-Type", value: "application/json" }]
                }
            ]
        };
    }

    async sendApprovalEmail(to, requestDetails, actionToken) {
        const { requestId, employeeName, requestType } = requestDetails;

        // Fallback Links for non-Actionable Message clients (or simple robust approach)
        // Using GET links for simplicity in fallback, or POST forms if possible. 
        // Here we assume the handle endpoint accepts GET for links or POST for cards.
        const approveLink = `${process.env.APP_URL}/api/approvals/handle?token=${actionToken}&action=Approved`;
        const rejectLink = `${process.env.APP_URL}/api/approvals/handle?token=${actionToken}&action=Rejected`;

        // Construct Header for Actionable Messages (Declarative)
        // <script type="application/adaptivecard+json"> ... </script>
        const cardJson = this.getAdaptiveCard(requestId, employeeName, requestType, actionToken);

        const htmlBody = `
      <html>
      <head>
        <script type="application/adaptivecard+json">${JSON.stringify(cardJson)}</script>
      </head>
      <body>
        <h2>Approval Needed: ${requestType}</h2>
        <p><strong>Employee:</strong> ${employeeName}</p>
        <p>Please review this request.</p>
        <br/>
        <!-- Fallback Buttons -->
        <a href="${approveLink}" style="padding:10px 20px; background-color:green; color:white; text-decoration:none;">Approve</a>
        &nbsp;
        <a href="${rejectLink}" style="padding:10px 20px; background-color:red; color:white; text-decoration:none;">Reject</a>
      </body>
      </html>
    `;

        try {
            await this.transporter.sendMail({
                from: process.env.SMTP_FROM,
                to: to,
                subject: `ACTION REQUIRED: Approval for ${employeeName}`,
                html: htmlBody
            });
            logger.info(`Approval Email sent to ${to} for Request ${requestId}`);
        } catch (err) {
            logger.error('Failed to send email', err);
            // Don't throw, just log. We don't want to rollback the request creation if email fails (or maybe we do?)
        }
    }
}

export default new EmailService();

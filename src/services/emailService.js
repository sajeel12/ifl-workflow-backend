import nodemailer from 'nodemailer';
import logger from '../utils/logger.js';

// Build transporter options — auto-detects Outlook vs internal Exchange relay
const smtpPort = parseInt(process.env.SMTP_PORT || '25', 10);
const hasAuth = !!(process.env.SMTP_USER && process.env.SMTP_PASS);

const transporterOptions = {
    host: process.env.SMTP_HOST,
    port: smtpPort,
    secure: process.env.SMTP_SECURE === 'true', // true for port 465, false for 587/25
    tls: {
        rejectUnauthorized: false // Accept self-signed certs (common in corporate environments)
    }
};

if (hasAuth) {
    // Authenticated SMTP (e.g. Outlook.com on port 587) — STARTTLS is required
    transporterOptions.requireTLS = true;  // Enforce STARTTLS upgrade
    transporterOptions.auth = {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    };
    logger.info(`[Email] Configured for authenticated SMTP → ${process.env.SMTP_HOST}:${smtpPort} (STARTTLS)`);
} else {
    // Anonymous internal relay (e.g. Exchange on port 25) — no TLS needed
    transporterOptions.ignoreTLS = true;
    transporterOptions.tls.ciphers = 'SSLv3';
    logger.info(`[Email] Configured for anonymous relay → ${process.env.SMTP_HOST}:${smtpPort} (no TLS)`);
}

const transporter = nodemailer.createTransport(transporterOptions);


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
    <html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
    <head>
        <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <!--[if mso]>
        <xml><o:OfficeDocumentSettings><o:AllowPNG/><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml>
        <![endif]-->
    </head>
    <body style="margin:0;padding:0;background-color:#f3f2f1;font-family:Arial,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f3f2f1;">
            <tr>
                <td align="center" style="padding:20px 10px;">
                    <!-- Outer container -->
                    <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background-color:#ffffff;border:1px solid #e1dfdd;">
                        <!-- Header -->
                        <tr>
                            <td bgcolor="#0078D4" style="background-color:#0078D4;padding:20px;text-align:center;">
                                <h1 style="color:#ffffff;margin:0;font-size:20px;font-weight:600;font-family:Arial,sans-serif;">Ibrahim Fibres Limited</h1>
                            </td>
                        </tr>
                        <!-- Content -->
                        <tr>
                            <td style="padding:30px;color:#323130;font-family:Arial,sans-serif;">
                                <h2 style="color:#0078D4;margin-top:0;margin-bottom:20px;font-family:Arial,sans-serif;font-size:18px;">${subject}</h2>

                                <!-- Info box -->
                                <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f8f9fa;border-left:4px solid #0078D4;margin-bottom:20px;">
                                    <tr>
                                        <td style="padding:15px;">
                                            <p style="margin:0 0 4px 0;font-weight:600;color:#605e5c;font-size:12px;font-family:Arial,sans-serif;text-transform:uppercase;">REQUESTER</p>
                                            <p style="margin:0 0 12px 0;font-size:15px;font-weight:600;color:#201f1e;font-family:Arial,sans-serif;">${requesterName || 'Unknown'}</p>
                                            <p style="margin:0 0 12px 0;font-size:13px;color:#605e5c;font-family:Arial,sans-serif;">${requesterEmail || 'No Email'}</p>

                                            <p style="margin:0 0 4px 0;font-weight:600;color:#605e5c;font-size:12px;font-family:Arial,sans-serif;text-transform:uppercase;">DETAILS</p>
                                            <p style="margin:0;font-size:14px;line-height:1.5;color:#323130;font-family:Arial,sans-serif;">${requestDetails}</p>
                                        </td>
                                    </tr>
                                </table>

                                <!-- Button (VML for Outlook, fallback for others) -->
                                <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                    <tr>
                                        <td align="center" style="padding-top:10px;">
                                            <!--[if mso]>
                                            <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word"
                                                href="${approvalLink}"
                                                style="height:44px;v-text-anchor:middle;width:240px;"
                                                arcsize="6%"
                                                stroke="f"
                                                fillcolor="#0078D4">
                                                <w:anchorlock/>
                                                <center style="color:#ffffff;font-family:Arial,sans-serif;font-size:14px;font-weight:bold;">Review &amp; Approve/Reject</center>
                                            </v:roundrect>
                                            <![endif]-->
                                            <!--[if !mso]><!-->
                                            <a href="${approvalLink}" style="background-color:#0078D4;color:#ffffff;display:inline-block;font-family:Arial,sans-serif;font-size:14px;font-weight:bold;line-height:44px;text-align:center;text-decoration:none;width:240px;-webkit-text-size-adjust:none;">Review &amp; Approve/Reject</a>
                                            <!--<![endif]-->
                                        </td>
                                    </tr>
                                </table>
                            </td>
                        </tr>
                        <!-- Footer -->
                        <tr>
                            <td bgcolor="#f3f2f1" style="background-color:#f3f2f1;padding:15px;text-align:center;color:#605e5c;font-size:12px;font-family:Arial,sans-serif;">
                                <p style="margin:0;">This is an automated notification from the IFL Workflow System.</p>
                            </td>
                        </tr>
                    </table>
                </td>
            </tr>
        </table>
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
    <html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
    <head>
        <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <!--[if mso]>
        <xml><o:OfficeDocumentSettings><o:AllowPNG/><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml>
        <![endif]-->
    </head>
    <body style="margin:0;padding:0;background-color:#f3f2f1;font-family:Arial,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f3f2f1;">
            <tr>
                <td align="center" style="padding:20px 10px;">
                    <!-- Outer container -->
                    <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background-color:#ffffff;border:1px solid #e1dfdd;">
                        <!-- Header -->
                        <tr>
                            <td bgcolor="#0078D4" style="background-color:#0078D4;padding:20px;text-align:center;">
                                <h1 style="color:#ffffff;margin:0;font-size:20px;font-weight:600;font-family:Arial,sans-serif;">Ibrahim Fibres Limited</h1>
                            </td>
                        </tr>
                        <!-- Content -->
                        <tr>
                            <td style="padding:30px;color:#323130;font-family:Arial,sans-serif;">

                                <!-- Status banner using table -->
                                <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:20px;">
                                    <tr>
                                        <td bgcolor="${statusColor}" style="background-color:${statusColor};padding:12px 15px;">
                                            <table cellpadding="0" cellspacing="0" border="0">
                                                <tr>
                                                    <td style="font-size:20px;padding-right:10px;vertical-align:middle;font-family:Arial,sans-serif;">${statusIcon}</td>
                                                    <td style="color:#ffffff;font-weight:600;font-size:15px;font-family:Arial,sans-serif;vertical-align:middle;">${subject}</td>
                                                </tr>
                                            </table>
                                        </td>
                                    </tr>
                                </table>

                                <p style="margin:0 0 20px 0;line-height:1.6;font-size:14px;color:#323130;font-family:Arial,sans-serif;">${message}</p>

                                <!-- Info box -->
                                <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f8f9fa;border:1px solid #e1dfdd;">
                                    <tr>
                                        <td style="padding:0;">
                                            <!-- Request ID row -->
                                            <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                                <tr>
                                                    <td style="padding:12px 15px;border-bottom:1px solid #eee;font-family:Arial,sans-serif;">
                                                        <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                                            <tr>
                                                                <td style="font-weight:600;color:#605e5c;font-size:14px;font-family:Arial,sans-serif;">Request ID</td>
                                                                <td align="right" style="color:#201f1e;font-size:14px;font-family:Arial,sans-serif;">#${requestId}</td>
                                                            </tr>
                                                        </table>
                                                    </td>
                                                </tr>
                                                <!-- Type row -->
                                                <tr>
                                                    <td style="padding:12px 15px;border-bottom:1px solid #eee;font-family:Arial,sans-serif;">
                                                        <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                                            <tr>
                                                                <td style="font-weight:600;color:#605e5c;font-size:14px;font-family:Arial,sans-serif;">Type</td>
                                                                <td align="right" style="color:#201f1e;font-size:14px;font-family:Arial,sans-serif;">${requestType}</td>
                                                            </tr>
                                                        </table>
                                                    </td>
                                                </tr>
                                                <!-- Status row -->
                                                <tr>
                                                    <td style="padding:12px 15px;${rejecterRole || comment ? 'border-bottom:1px solid #eee;' : ''}font-family:Arial,sans-serif;">
                                                        <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                                            <tr>
                                                                <td style="font-weight:600;color:#605e5c;font-size:14px;font-family:Arial,sans-serif;">Status</td>
                                                                <td align="right" style="color:${statusColor};font-weight:600;font-size:14px;font-family:Arial,sans-serif;">${currentStage || status}</td>
                                                            </tr>
                                                        </table>
                                                    </td>
                                                </tr>
                                                ${rejecterRole ? `
                                                <!-- Rejected by row -->
                                                <tr>
                                                    <td style="padding:12px 15px;${comment ? 'border-bottom:1px solid #eee;' : ''}font-family:Arial,sans-serif;">
                                                        <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                                            <tr>
                                                                <td style="font-weight:600;color:#605e5c;font-size:14px;font-family:Arial,sans-serif;">Rejected By</td>
                                                                <td align="right" style="color:#201f1e;font-size:14px;font-family:Arial,sans-serif;">${rejecterRole}</td>
                                                            </tr>
                                                        </table>
                                                    </td>
                                                </tr>
                                                ` : ''}
                                                ${comment ? `
                                                <!-- Comment row -->
                                                <tr>
                                                    <td style="padding:12px 15px;font-family:Arial,sans-serif;">
                                                        <p style="margin:0 0 5px 0;font-weight:600;color:#605e5c;font-size:14px;font-family:Arial,sans-serif;">Comment</p>
                                                        <p style="margin:0;color:#201f1e;font-style:italic;font-size:14px;font-family:Arial,sans-serif;">"${comment}"</p>
                                                    </td>
                                                </tr>
                                                ` : ''}
                                            </table>
                                        </td>
                                    </tr>
                                </table>

                                ${nextSteps ? `
                                <!-- Next steps -->
                                <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:20px;">
                                    <tr>
                                        <td style="background-color:#eff6fc;border-left:4px solid #0078D4;padding:15px;font-family:Arial,sans-serif;">
                                            <p style="margin:0 0 5px 0;font-weight:700;color:#0078D4;font-size:14px;font-family:Arial,sans-serif;">Next Steps</p>
                                            <p style="margin:0;font-size:14px;color:#323130;font-family:Arial,sans-serif;">${nextSteps}</p>
                                        </td>
                                    </tr>
                                </table>
                                ` : ''}
                            </td>
                        </tr>
                        <!-- Footer -->
                        <tr>
                            <td bgcolor="#f3f2f1" style="background-color:#f3f2f1;padding:15px;text-align:center;color:#605e5c;font-size:12px;font-family:Arial,sans-serif;">
                                <p style="margin:0;">This is an automated notification from the IFL Workflow System.<br>Please do not reply to this email.</p>
                            </td>
                        </tr>
                    </table>
                </td>
            </tr>
        </table>
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

export const sendOnboardingDCINotification = async (toEmail, request, actionLink) => {
    const subject = `DCI Approval Required: Onboarding Request #${request.id} for ${request.fullName}`;
    const message = `IT has completed the configuration for ${request.fullName}. Please review and provide final approval.`;

    return sendApprovalEmail(toEmail, subject, message, actionLink, request.fullName, '');
};

export const sendOnboardingNotification = async (toEmail, request, actionLink, type) => {
    let subject = '';
    let message = '';

    const userInfo = `${request.fullName} (${request.designation})`;

    switch (type) {
        case 'IT_OPS':
            subject = `IT Ops Action: Configure Services for ${userInfo}`;
            message = `A new onboarding request needs service configuration.`;
            break;
        case 'HOD_REVIEW':
            subject = `HOD Review: Onboarding Request for ${userInfo}`;
            message = `IT Operations has configured services. Please review and approve.`;
            break;
        case 'DCI_INPUT':
            subject = `DCI Team Action: Configure ID for ${userInfo}`;
            message = `HOD has approved the request. Please configure DCI services (NT User, Email, etc.).`;
            break;
        case 'DCI_MANAGER_APPROVAL':
            subject = `DCI Manager Approval: Onboarding Request for ${userInfo}`;
            message = `DCI Team has submitted the configuration. Please provide final approval.`;
            break;
        case 'IT_HOD_APPROVAL':
            subject = `IT HOD Approval: Email Services for ${userInfo}`;
            message = `Special Email Services were requested. Please approve.`;
            break;
        default:
            subject = `Onboarding Action Required for ${userInfo}`;
            message = `Your input is required for this request.`;
    }

    // Reuse generic approval email sender
    return sendApprovalEmail(toEmail, subject, message, actionLink, request.fullName, 'HR Dept');
};

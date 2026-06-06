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


export const sendApprovalEmail = async (toEmail, subject, requestDetails, approvalLink, requesterName, requesterEmail, displayOpts = {}) => {
    logger.info(`[Email] Sending approval email to ${toEmail}`);
    // displayOpts.reqId   — request number shown large in the body (e.g. "42")
    // displayOpts.stageName — stage label shown below the separator (e.g. "IT Configuration")

    const adaptiveCardPayload = {
        "type": "AdaptiveCard",
        "version": "1.0",
        "originator": process.env.ACTIONABLE_MESSAGE_PROVIDER_ID || "ProviderID-Guid-Here-If-Registered",
        "body": [
            {
                "type": "TextBlock",
                "text": "New Employee Onboarding",
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

    // Two-column heading row: "Request | Stage" side by side with labeled titles.
    // Falls back to a plain h2 if displayOpts are not provided (legacy callers).
    const F = "'Segoe UI',Calibri,Arial,sans-serif"; // enterprise font stack
    const headingHtml = displayOpts.reqId
        ? `<table width="100%" cellpadding="0" cellspacing="0" border="0"
               style="margin-bottom:16px;border:1px solid #dde3ec;border-radius:4px;overflow:hidden;">
               <tr>
                   <td style="padding:1px 14px;width:50%;vertical-align:middle;background:#f4f6f9;border-right:1px solid #dde3ec;">
                       <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:#8a96a8;font-family:${F};line-height:1;margin:0;padding:0;">Request</div>
                       <div style="font-size:20px;font-weight:700;color:#0f172a;font-family:${F};line-height:1;margin:0;padding:0;">${displayOpts.reqId}</div>
                   </td>
                   <td style="padding:1px 14px;width:50%;vertical-align:middle;background:#f4f6f9;">
                       <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:#8a96a8;font-family:${F};line-height:1;margin:0;padding:0;">Stage</div>
                       <div style="font-size:15px;font-weight:600;color:#0078D4;font-family:${F};line-height:1;margin:0;padding:0;">${displayOpts.stageName || ''}</div>
                   </td>
               </tr>
           </table>`
        : `<h2 style="color:#0078D4;margin-top:0;margin-bottom:18px;font-family:${F};font-size:17px;">${subject}</h2>`;

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
    <body style="margin:0;padding:0;background-color:#eef0f3;font-family:'Segoe UI',Calibri,Arial,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#eef0f3;">
            <tr>
                <td align="center" style="padding:24px 10px;">
                    <!-- Outer container -->
                    <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background-color:#ffffff;border:1px solid #d0d5de;border-radius:4px;overflow:hidden;">
                        <!-- Header -->
                        <tr>
                            <td bgcolor="#0078D4" style="background-color:#0078D4;padding:18px 24px;text-align:center;">
                                <h1 style="color:#ffffff;margin:0;font-size:18px;font-weight:600;font-family:'Segoe UI',Calibri,Arial,sans-serif;letter-spacing:0.01em;">New Employee Onboarding</h1>
                            </td>
                        </tr>
                        <!-- Content -->
                        <tr>
                            <td style="padding:24px 28px;color:#1e2735;font-family:'Segoe UI',Calibri,Arial,sans-serif;">
                                ${headingHtml}

                                <!-- Section label above the details box -->
                                <div style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.07em;color:#374151;font-family:'Segoe UI',Calibri,Arial,sans-serif;border-bottom:1px solid #e5e9f0;padding-bottom:6px;margin-bottom:10px;">Request Details</div>

                                <!-- Info box: render details as a bullet list when the
                                     body starts with "::BULLETS::"; otherwise as a paragraph. -->
                                <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f6f8fb;border-left:3px solid #0078D4;margin-bottom:22px;">
                                    <tr>
                                        <td style="padding:13px 16px;">
                                            ${(() => {
                                                if (typeof requestDetails === 'string' && requestDetails.startsWith('::BULLETS::')) {
                                                    const items = requestDetails.split('\n').slice(1).filter(Boolean);
                                                    return `<ul style="margin:0;padding:0 0 0 18px;font-size:14px;line-height:1.75;color:#1e2735;font-family:'Segoe UI',Calibri,Arial,sans-serif;">${items.map(i => `<li style="margin-bottom:3px;">${i}</li>`).join('')}</ul>`;
                                                }
                                                return `<p style="margin:0;font-size:14px;line-height:1.6;color:#1e2735;font-family:'Segoe UI',Calibri,Arial,sans-serif;">${requestDetails}</p>`;
                                            })()}
                                        </td>
                                    </tr>
                                </table>

                                <!-- Button (VML for Outlook, fallback for others) -->
                                <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                    <tr>
                                        <td align="center" style="padding-top:6px;">
                                            <!--[if mso]>
                                            <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word"
                                                href="${approvalLink}"
                                                style="height:42px;v-text-anchor:middle;width:220px;"
                                                arcsize="6%"
                                                stroke="f"
                                                fillcolor="#0078D4">
                                                <w:anchorlock/>
                                                <center style="color:#ffffff;font-family:'Segoe UI',Calibri,Arial,sans-serif;font-size:14px;font-weight:600;">Review &amp; Approve/Reject</center>
                                            </v:roundrect>
                                            <![endif]-->
                                            <!--[if !mso]><!-->
                                            <a href="${approvalLink}" style="background-color:#0078D4;color:#ffffff;display:inline-block;font-family:'Segoe UI',Calibri,Arial,sans-serif;font-size:14px;font-weight:600;line-height:42px;text-align:center;text-decoration:none;width:220px;border-radius:3px;-webkit-text-size-adjust:none;">Review &amp; Approve/Reject</a>
                                            <!--<![endif]-->
                                        </td>
                                    </tr>
                                </table>
                            </td>
                        </tr>
                        <!-- Footer -->
                        <tr>
                            <td bgcolor="#eef0f3" style="background-color:#eef0f3;padding:12px 24px;text-align:center;border-top:1px solid #d0d5de;">
                                <p style="margin:0;color:#6b7280;font-size:11px;font-family:'Segoe UI',Calibri,Arial,sans-serif;line-height:1.5;">This is an automated notification from the IGC SharePoint Portal.</p>
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

/**
 * Send the generated Work Order PDF as an email attachment.
 * Used to deliver the signed Work Order to the DCI Manager (and optional CCs)
 * once it has been generated.
 */
export const sendWorkOrderPDF = async (toEmail, request, pdfPath, ccList = []) => {
    if (!toEmail) {
        logger.warn('[Email] sendWorkOrderPDF: no recipient provided — skipping');
        return;
    }
    const fs = await import('fs');
    const path = await import('path');
    if (!pdfPath || !fs.existsSync(pdfPath)) {
        logger.warn(`[Email] sendWorkOrderPDF: PDF not found at ${pdfPath} — skipping`);
        return;
    }

    const filename = path.basename(pdfPath);
    const reqNo = `#${request.id}`;
    const userInfo = `${request.fullName || '—'}${request.designation ? ' (' + request.designation + ')' : ''}`;
    const subject = `[Work Order] Onboarding ${reqNo} — ${userInfo}`;

    const htmlBody = `
    <!DOCTYPE html>
    <html><head><meta charset="utf-8"></head>
    <body style="margin:0;padding:0;background:#f3f2f1;font-family:Arial,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f2f1;">
            <tr><td align="center" style="padding:20px 10px;">
                <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border:1px solid #e1dfdd;">
                    <tr><td bgcolor="#0078D4" style="background:#0078D4;padding:20px;text-align:center;">
                        <h1 style="color:#fff;margin:0;font-size:20px;font-weight:600;">Ibrahim Fibres Limited</h1>
                    </td></tr>
                    <tr><td style="padding:30px;color:#323130;">
                        <h2 style="color:#0078D4;margin-top:0;margin-bottom:14px;font-size:18px;">Work Order Generated</h2>
                        <p style="margin:0 0 14px 0;font-size:14px;line-height:1.5;">
                            The signed Work Order PDF for onboarding request ${reqNo} has been generated and is attached
                            for your records.
                        </p>
                        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8f9fa;border-left:4px solid #0078D4;margin-bottom:14px;">
                            <tr><td style="padding:14px;font-size:13px;color:#323130;">
                                <strong>Employee:</strong> ${request.fullName || '—'}<br>
                                <strong>Employee ID:</strong> ${request.employeeId || '—'}<br>
                                <strong>Department:</strong> ${[request.department, request.subDepartment].filter(Boolean).join(' / ') || '—'}<br>
                                <strong>Request #:</strong> ${request.id}<br>
                                <strong>Approval Status:</strong> ${request.approvalStatus || 'Approved'}
                            </td></tr>
                        </table>
                        <p style="margin:0;font-size:13px;color:#605e5c;">
                            No further action is required from you for this work order — it has been forwarded to
                            the DCI Implementer for provisioning.
                        </p>
                    </td></tr>
                    <tr><td bgcolor="#f3f2f1" style="background:#f3f2f1;padding:15px;text-align:center;color:#605e5c;font-size:12px;">
                        Automated notification · IFL Workflow System · Please do not reply.
                    </td></tr>
                </table>
            </td></tr>
        </table>
    </body></html>`;

    try {
        const info = await transporter.sendMail({
            from: process.env.SMTP_FROM,
            to: toEmail,
            cc: ccList && ccList.length ? ccList.join(',') : undefined,
            subject,
            html: htmlBody,
            attachments: [{ filename, path: pdfPath, contentType: 'application/pdf' }]
        });
        logger.info(`[Email] Work Order PDF sent to ${toEmail}${ccList.length ? ' (cc: ' + ccList.join(',') + ')' : ''}: ${info.messageId}`);
        return info;
    } catch (err) {
        logger.error(`[Email] Failed to send Work Order PDF: ${err.message}`);
    }
};

export const sendOnboardingNotification = async (toEmail, request, actionLink, type) => {
    const userInfo = `${request.fullName || '—'}${request.designation ? ' (' + request.designation + ')' : ''}`;
    const dept = [request.department, request.subDepartment].filter(Boolean).join(' / ') || '—';
    const reqNo = String(request.id); // no "#" prefix

    // Each stage email is three or four bullets. "Next:" is omitted when not applicable.
    const buildBullets = (action, next) => {
        const lines = ['::BULLETS::', `Employee: ${userInfo}`, `Department: ${dept}`, `Action: ${action}`];
        if (next) lines.push(`Next: ${next}`);
        return lines.join('\n');
    };

    let subject, stageName, body;
    switch (type) {
        case 'IT_OPS':
            stageName = 'IT Configuration';
            subject   = `Request ${reqNo} — ${stageName}`;
            body      = buildBullets('Configure intranet, email, printers, file shares.', 'Forwarded to HOD for approval.');
            break;
        case 'HOD_REVIEW':
            stageName = 'HOD Approval';
            subject   = `Request ${reqNo} — ${stageName}`;
            body      = buildBullets('Review configured services and approve or reject.', 'Forwarded to DCI Team.');
            break;
        case 'DCI_INPUT':
            stageName = 'DCI Setup';
            subject   = `Request ${reqNo} — ${stageName}`;
            body      = buildBullets('Configure NT user, SMTP, mailbox limits, GPO.', 'Forwarded to DCI Manager for review.');
            break;
        case 'DCI_CHANGES_REQUESTED':
            stageName = 'Changes Requested';
            subject   = `Request ${reqNo} — ${stageName}`;
            body      = buildBullets('Review the remarks on the form and resubmit.', 'Returns to DCI Manager after resubmission.');
            break;
        case 'DCI_MANAGER_APPROVAL':
            stageName = 'Manager Review';
            subject   = `Request ${reqNo} — ${stageName}`;
            body      = buildBullets('Approve, reject, or request changes.', 'Forwarded to IT HOD or directly to DCI Implementation.');
            break;
        case 'IT_HOD_APPROVAL':
            stageName = 'IT HOD Sign-off';
            subject   = `Request ${reqNo} — ${stageName}`;
            body      = buildBullets('Approve external email access.', 'Forwarded to DCI Implementation.');
            break;
        case 'DCI_IMPLEMENTATION':
            stageName = 'Account Provisioning';
            subject   = `Request ${reqNo} — ${stageName}`;
            body      = buildBullets('Create AD/Exchange account and upload proof screenshots.', 'Forwarded to OPS for desk setup.');
            break;
        case 'OPS_ACTION':
            stageName = 'Desk Setup';
            subject   = `Request ${reqNo} — ${stageName}`;
            body      = buildBullets('Complete the physical setup checklist at the user\'s desk.', 'Request will be marked Completed.');
            break;
        default:
            stageName = 'Action Required';
            subject   = `Request ${reqNo} — ${stageName}`;
            body      = buildBullets('Your input is required on this onboarding request.', 'Workflow will continue after your action.');
    }

    return sendApprovalEmail(
        toEmail, subject, body, actionLink,
        request.requesterName || 'HR', request.requesterEmail || '',
        { reqId: reqNo, stageName }
    );
};

export const sendDeletionNotification = async (toEmail, request, { deletedBy, reason, priorStatus }) => {
    const reqNo = `#${request.id}`;
    const userInfo = `${request.fullName || '—'}${request.designation ? ' (' + request.designation + ')' : ''}`;
    const dept = [request.department, request.subDepartment].filter(Boolean).join(' / ') || '—';
    const subject = `Onboarding ${reqNo} — Request Deleted by Administrator`;

    const htmlBody = `
    <!DOCTYPE html>
    <html xmlns="http://www.w3.org/1999/xhtml">
    <head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
    <body style="margin:0;padding:0;background-color:#f3f2f1;font-family:Arial,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f3f2f1;">
            <tr><td align="center" style="padding:20px 10px;">
                <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border:1px solid #e1dfdd;">
                    <!-- Header — red to signal termination -->
                    <tr><td bgcolor="#b91c1c" style="background-color:#b91c1c;padding:20px;text-align:center;">
                        <h1 style="color:#ffffff;margin:0;font-size:20px;font-weight:600;font-family:Arial,sans-serif;">Ibrahim Fibres Limited</h1>
                        <p style="color:#fecaca;margin:4px 0 0;font-size:13px;font-family:Arial,sans-serif;">Onboarding Workflow — Administrative Deletion</p>
                    </td></tr>
                    <!-- Content -->
                    <tr><td style="padding:30px;color:#323130;font-family:Arial,sans-serif;">
                        <h2 style="color:#b91c1c;margin-top:0;margin-bottom:16px;font-family:Arial,sans-serif;font-size:18px;">Onboarding Request ${reqNo} Has Been Deleted</h2>
                        <p style="font-size:14px;color:#323130;margin:0 0 20px;line-height:1.5;">
                            This is to inform you that the above onboarding request has been <strong>permanently removed</strong> from the workflow by a system administrator. No further action is required or possible on this request.
                        </p>
                        <!-- Details box -->
                        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fef2f2;border-left:4px solid #b91c1c;margin-bottom:20px;">
                            <tr><td style="padding:16px;">
                                <table width="100%" cellpadding="4" cellspacing="0" border="0" style="font-size:13px;color:#323130;font-family:Arial,sans-serif;">
                                    <tr><td style="font-weight:600;width:140px;color:#6b7280;">Employee:</td><td>${userInfo}</td></tr>
                                    <tr><td style="font-weight:600;color:#6b7280;">Department:</td><td>${dept}</td></tr>
                                    <tr><td style="font-weight:600;color:#6b7280;">Request ID:</td><td>${reqNo}</td></tr>
                                    <tr><td style="font-weight:600;color:#6b7280;">Stage at deletion:</td><td>${priorStatus}</td></tr>
                                    <tr><td style="font-weight:600;color:#6b7280;">Deleted by:</td><td>${deletedBy}</td></tr>
                                    <tr><td style="font-weight:600;color:#6b7280;vertical-align:top;">Reason:</td><td style="font-style:italic;">${reason}</td></tr>
                                </table>
                            </td></tr>
                        </table>
                        <p style="font-size:13px;color:#6b7280;margin:0;line-height:1.5;">If you have questions about this action, please contact your system administrator. Any action links you received for this request are now invalid.</p>
                    </td></tr>
                    <!-- Footer -->
                    <tr><td bgcolor="#f3f2f1" style="background-color:#f3f2f1;padding:15px;text-align:center;color:#605e5c;font-size:12px;font-family:Arial,sans-serif;">
                        <p style="margin:0;">This is an automated notification from the IFL Workflow System.</p>
                    </td></tr>
                </table>
            </td></tr>
        </table>
    </body>
    </html>`;

    try {
        const info = await transporter.sendMail({
            from: process.env.SMTP_FROM,
            to:   toEmail,
            subject,
            html: htmlBody
        });
        logger.info(`[Email] Deletion notice sent to ${toEmail} for request #${request.id}: ${info.messageId}`);
        return info;
    } catch (err) {
        logger.error(`[Email] Failed to send deletion notice to ${toEmail}: ${err.message}`);
        throw err;
    }
};

// Offboarding stage notification — same bullet shape as
// sendOnboardingNotification but with offboarding-specific subjects/bodies.
export const sendOffboardingNotification = async (toEmail, request, actionLink, type) => {
    const userInfo = `${request.fullName || '—'}${request.designation ? ' (' + request.designation + ')' : ''}`;
    const dept = request.department || '—';
    const reqNo = `#${request.id}`;

    const buildBullets = (action, next) => {
        const lines = ['::BULLETS::', `Employee: ${userInfo}`, `Department: ${dept}`, `Action: ${action}`];
        if (next) lines.push(`Next: ${next}`);
        return lines.join('\n');
    };

    let subject, body;
    switch (type) {
        case 'DCI_MANAGER_APPROVAL':
            subject = `Offboarding ${reqNo} — Manager Approval`;
            body = buildBullets(
                'Review the user\'s granted privileges and approve or reject the revocation.',
                'Approved → DCI Implementer for AD deletion.'
            );
            break;
        case 'DCI_IMPLEMENTER':
            subject = `Offboarding ${reqNo} — Account Revocation`;
            body = buildBullets(
                'Delete AD account, confirm SmartX and door-access revocation.',
                'Final notification will go to HOD and IT HOD on completion.'
            );
            break;
        default:
            subject = `Offboarding ${reqNo} — Action Required`;
            body = buildBullets('Your input is required.', 'Workflow will continue.');
    }
    return sendApprovalEmail(toEmail, subject, body, actionLink, 'Offboarding Workflow', '');
};

// Final offboarding-completed notification (no action link — informational only).
// Sent to the employee's HOD and IT HOD when the DCI Implementer finishes.
export const sendOffboardingCompletedNotification = async (toEmailList, request) => {
    const userInfo = `${request.fullName || request.employeeId} (${request.designation || '—'}, ${request.department || '—'})`;
    const subject  = `Offboarding Completed: ${userInfo}`;
    const body =
        `Offboarding has been completed for ${userInfo}.\n\n` +
        `AD account, SmartX access, and door-access have all been revoked. ` +
        `This is a courtesy notice — no further action is required from you.`;
    return sendRequesterNotification(toEmailList, subject, body, {
        requestId:   request.id,
        requestType: 'Offboarding',
        status:      'Completed',
        currentStage: 'Completed'
    });
};

export const sendPortalAccessLink = async (toEmail, roleName, portalUrl) => {
    logger.info(`[Email] Sending portal access link to ${toEmail} for ${roleName}`);
    const subject = `Your ${roleName} Portal Access Link`;
    const htmlBody = `
        <div style="font-family:Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
            <div style="background:#0078D4;padding:20px 28px;">
                <div style="color:#fff;font-size:1.1rem;font-weight:700;">IFL Workflow</div>
            </div>
            <div style="padding:28px;">
                <h2 style="font-size:1.1rem;color:#0f172a;margin:0 0 10px;">${roleName} Portal — Access Link</h2>
                <p style="font-size:0.92rem;color:#475569;margin:0 0 22px;line-height:1.6;">
                    Click the button below to open your portal. The link is valid for <strong>8 hours</strong>.
                    Do not share it with others.
                </p>
                <a href="${portalUrl}"
                   style="display:inline-block;padding:12px 28px;background:#0078D4;color:#fff;
                          text-decoration:none;border-radius:7px;font-size:0.95rem;font-weight:600;">
                    Open ${roleName} Portal &rarr;
                </a>
                <p style="font-size:0.78rem;color:#94a3b8;margin:22px 0 0;">
                    If you did not request this link, ignore this email.
                </p>
            </div>
        </div>`;

    await transporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER || 'workflow@ifl.com',
        to:   toEmail,
        subject,
        html: htmlBody,
        text: `Open your ${roleName} portal: ${portalUrl}  (valid 8 hours)`
    });
};

import PDFDocument from 'pdfkit';
import fs from 'fs';

// Page constants — A4 portrait
const PAGE_W = 595;
const PAGE_H = 842;
const M = 30;                 // outer page margin
const W = PAGE_W - 2 * M;     // content width

// Format helpers
const fmt = (v) => {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) {
        if (isNaN(v.getTime())) return '';
        return v.toLocaleDateString('en-GB');
    }
    return String(v);
};

const fmtDateTime = (v) => {
    if (!v) return '';
    const d = (v instanceof Date) ? v : new Date(v);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
};

/**
 * Generate the Intranet & Internet Proxy Form PDF.
 * Layout matches the IFL paper form: plain black-and-white, two boxed
 * sections (Applicant + System Infrastructure), signature lines at bottom.
 */
export const generateOnboardingPDF = async (request, outputPath) => {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({
            size: 'A4',
            margin: 0,
            info: {
                Title:    `Intranet & Internet Proxy Form — Req #${request.id}`,
                Author:   'Ibrahim Fibres Limited',
                Subject:  `Onboarding for ${request.fullName || ''}`,
                Producer: 'IFL Workflow System'
            }
        });
        const stream = fs.createWriteStream(outputPath);
        doc.pipe(stream);

        doc.fillColor('#000');
        doc.strokeColor('#000');
        doc.lineWidth(0.5);

        // ─── Drawing helpers ───────────────────────────────────────────

        const text = (str, x, y, opts = {}) => {
            doc.text(str || '', x, y, { lineBreak: false, ...opts });
        };

        const labelText = (str, x, y, opts = {}) => {
            doc.font('Helvetica').fontSize(8.5);
            text(str, x, y, opts);
        };

        const valueText = (str, x, y, w) => {
            doc.font('Helvetica').fontSize(9);
            text(fmt(str), x, y, { width: w, ellipsis: true, lineBreak: false });
        };

        const fieldBox = (x, y, w, h, value) => {
            doc.lineWidth(0.5).rect(x, y, w, h).stroke();
            doc.font('Helvetica').fontSize(9).fillColor('#000');
            doc.text(fmt(value), x + 4, y + 4, {
                width: w - 8, height: h - 4, lineBreak: false, ellipsis: true
            });
        };

        // Label on the left, bordered text box on the right
        const labeledField = (label, x, y, labelW, fieldW, h, value) => {
            labelText(label + ':', x, y + 3);
            fieldBox(x + labelW, y, fieldW, h, value);
        };

        // Checkbox: small square, optional tick inside, label to the right
        const checkbox = (label, x, y, checked) => {
            doc.lineWidth(0.5).rect(x, y + 1, 9, 9).stroke();
            if (checked) {
                doc.font('Helvetica-Bold').fontSize(9).fillColor('#000');
                text('✓', x + 1.5, y + 1.5);
            }
            doc.font('Helvetica').fontSize(9);
            text(label, x + 14, y + 3);
        };

        const sectionLabel = (str, x, y) => {
            doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#000');
            const w = doc.widthOfString(str);
            text(str, x, y);
            // Subtle underline under section labels (like the original form)
            doc.moveTo(x, y + 11).lineTo(x + w, y + 11).lineWidth(0.5).stroke();
        };

        const horizontalRule = (x1, x2, y) => {
            doc.lineWidth(0.5).moveTo(x1, y).lineTo(x2, y).stroke();
        };

        // ════════════════════════════════════════════════════════════════
        // APPLICANT BOX
        // ════════════════════════════════════════════════════════════════
        const appTop = M;
        const appHeight = 540;     // ~64% of A4 — leaves room for the System Infra box below
        const appBottom = appTop + appHeight;

        doc.lineWidth(0.7).rect(M, appTop, W, appHeight).stroke();
        doc.lineWidth(0.5);

        // Title bar (small bordered box near the top)
        const titleX = M + 90;
        const titleW = W - 180;
        const titleY = appTop + 12;
        doc.rect(titleX, titleY, titleW, 22).stroke();
        doc.font('Helvetica-Bold').fontSize(13).fillColor('#000');
        text('Intranet & Internet Proxy Form', titleX, titleY + 6, {
            width: titleW, align: 'center'
        });

        // Top-right "Request Initiated On" field
        let y = titleY + 30;
        const initLabelW = 110;
        labelText('Request Initiated On:', M + W - 230, y + 3);
        fieldBox(M + W - 230 + initLabelW, y, 110, 16, fmtDateTime(request.hrSubmittedAt));

        // ─── Applicant fields (2-column grid) ───────────────────────────
        const colLeftX = M + 8;
        const colRightX = M + W / 2 + 4;
        const colWidth = W / 2 - 12;

        y += 22;
        labeledField('Employee Number', colLeftX, y, 95, colWidth - 100, 16, request.employeeId);
        labeledField('Department',      colRightX, y, 70, colWidth - 75,  16, request.department);

        y += 22;
        labeledField('Request Initator Name', colLeftX, y, 110, colWidth - 115, 16, request.requesterName);
        labeledField('Project / Unit',         colRightX, y, 70,  colWidth - 75,  16, request.location || 'Head Office');

        y += 22;
        labeledField('Designation', colLeftX, y, 65, colWidth - 70, 16, request.designation);
        labeledField('Joining Date', colRightX, y, 65, colWidth - 70, 16,
            request.joiningDate ? fmt(request.joiningDate) : 'N/A');

        // Office Ext / Home / Mobile (3 fields on one row)
        y += 22;
        labelText('Office Extension:', colLeftX, y + 3);
        fieldBox(colLeftX + 88, y, 50, 16, request.officeExtension);
        text('-', colLeftX + 142, y + 3);
        labelText('Home Phone #:', colLeftX + 165, y + 3);
        fieldBox(colLeftX + 235, y, 45, 16, request.homePhone);
        text('-', colLeftX + 282, y + 3);
        labelText('Mobile #:', colLeftX + 305, y + 3);
        fieldBox(colLeftX + 350, y, M + W - colLeftX - 350 - 8, 16, request.mobilePhone);

        // ─── Intranet & Internet Services ───────────────────────────────
        y += 30;
        sectionLabel('Intranet & Internet Services:', colLeftX, y);

        y += 18;
        checkbox('Intranet', colLeftX, y, request.intranetAccess);
        labelText('Internet Facility:', colLeftX + 130, y + 3);
        checkbox('General Browsing', colLeftX + 210, y, request.internetAccess);
        checkbox('Specific WebSites', colLeftX + 340, y, request.specificWebsites);

        y += 22;
        labelText('Purpose of Use: (Please Specify)', colLeftX, y);
        const purposeRule1 = colLeftX + 170;
        horizontalRule(purposeRule1, M + W - 8, y + 9);
        doc.font('Helvetica').fontSize(9);
        text(fmt(request.internetPurpose), purposeRule1 + 3, y + 1, {
            width: M + W - 8 - purposeRule1 - 3, ellipsis: true, lineBreak: false
        });

        // ─── External Email Services ────────────────────────────────────
        y += 22;
        sectionLabel('External Email Services:', colLeftX, y);

        y += 18;
        checkbox('Incoming', colLeftX + 80, y, request.emailIncoming);
        checkbox('Outgoing', colLeftX + 200, y, request.emailOutgoing);

        y += 22;
        labelText('Purpose of Use: (Please Specify)', colLeftX, y);
        const purposeRule2 = colLeftX + 170;
        horizontalRule(purposeRule2, M + W - 8, y + 9);
        doc.font('Helvetica').fontSize(9);
        text(fmt(request.emailPurpose), purposeRule2 + 3, y + 1, {
            width: M + W - 8 - purposeRule2 - 3, ellipsis: true, lineBreak: false
        });

        // ─── Print Services ─────────────────────────────────────────────
        y += 22;
        sectionLabel('Print Services:', colLeftX, y);

        y += 18;
        checkbox('Laser Printer', colLeftX + 80, y, request.laserPrinter);
        labelText('Network Printer Name:', colLeftX + 200, y + 3);
        fieldBox(colLeftX + 295, y, M + W - 8 - (colLeftX + 295), 16, request.laserPrinterLocation);

        y += 18;
        checkbox('Dot Matrix Printer', colLeftX + 80, y, request.dotMatrixPrinter);
        labelText('Network Printer Name:', colLeftX + 200, y + 3);
        fieldBox(colLeftX + 295, y, M + W - 8 - (colLeftX + 295), 16, request.dotMatrixPrinterLocation);

        // ─── File Share Services ────────────────────────────────────────
        y += 22;
        sectionLabel('File Share Services:', colLeftX, y);

        y += 18;
        labeledField('Dept. Share  (S:)', colLeftX, y, 90, colWidth - 95, 16, request.deptSharePath);
        labeledField('Home Folder (Z:)', colRightX, y, 90, colWidth - 95, 16, request.homeFolderPath);

        y += 18;
        labeledField('Terminal User (T:)',   colLeftX, y, 90, colWidth - 95, 16, '');
        labeledField('IFL-Portal Site Link', colRightX, y, 90, colWidth - 95, 16, request.iflPortalLink);

        // ─── NOTE block — flows naturally below the file share section ─
        y += 22;
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#000');
        text('NOTE:', colLeftX, y);
        y += 12;
        doc.font('Helvetica').fontSize(7.5);
        const noteText = 'Applicant hereby notified that any dissemination, distribution or misuse of this profile is strictly prohibited and any vulnerability or violation of company policies caused damages due to this shall be born by the applicant. If you have any doubt on the use of the profile, please notify to the IT deptt immediately by available means. It is also deemed that HOD knows the consequences of such violation.';
        doc.text(noteText, colLeftX, y, {
            width: W - 16, height: 50, lineGap: 1.2, align: 'left'
        });

        // ─── Three-signature row anchored to the bottom of the applicant box
        const sigRowY = appBottom - 40;
        const sigSlotW = (W - 16) / 3;
        for (let i = 0; i < 3; i++) {
            const sx = colLeftX + i * sigSlotW;
            horizontalRule(sx + 10, sx + sigSlotW - 10, sigRowY);
        }
        doc.font('Helvetica').fontSize(9).fillColor('#000');
        const sigLabels = [
            { line1: "Applicant's Signature",       line2: '' },
            { line1: "Applicant's Head Of Deptt.",  line2: '' },
            { line1: 'Director / GM Technology / Manager', line2: '(Required for Internet / Email Facility)' }
        ];
        sigLabels.forEach((sig, i) => {
            const sx = colLeftX + i * sigSlotW;
            doc.font('Helvetica').fontSize(9);
            text(sig.line1, sx + 10, sigRowY + 4, { width: sigSlotW - 20, align: i === 2 ? 'left' : 'left' });
            if (sig.line2) {
                doc.font('Helvetica').fontSize(7);
                text(sig.line2, sx + 10, sigRowY + 16, { width: sigSlotW - 20 });
            }
        });

        // Name / Des labels under first two signatures
        doc.font('Helvetica').fontSize(8.5);
        const nameDesY = sigRowY + 22;
        text('Name:', colLeftX, nameDesY);
        text('Des:',  colLeftX, nameDesY + 11);
        text('Name:  :', colLeftX + sigSlotW, nameDesY);
        text('Des:',     colLeftX + sigSlotW, nameDesY + 11);

        // ════════════════════════════════════════════════════════════════
        // SYSTEM INFRASTRUCTURE BOX
        // ════════════════════════════════════════════════════════════════
        const sysTop = appBottom + 6;
        const sysBottom = PAGE_H - M;
        const sysHeight = sysBottom - sysTop;

        doc.lineWidth(0.7).rect(M, sysTop, W, sysHeight).stroke();
        doc.lineWidth(0.5);

        // Title
        doc.font('Helvetica-Bold').fontSize(10).fillColor('#000');
        text('For System Infrastructure Team Only', colLeftX, sysTop + 8);
        const titleW2 = doc.widthOfString('For System Infrastructure Team Only');
        horizontalRule(colLeftX, colLeftX + titleW2, sysTop + 21);

        let sy = sysTop + 32;

        // 4-row 2-column grid for the DCI fields
        labeledField('NT User Name',    colLeftX, sy, 80, colWidth - 85, 16, request.ntUserName);
        labeledField('DG Members',      colRightX, sy, 80, colWidth - 85, 16, request.dgMembers);

        sy += 22;
        labeledField('Ex.Display Name', colLeftX, sy, 80, colWidth - 85, 16, request.exchangeDisplayName);
        labeledField('Mail Size Limit', colRightX, sy, 80, colWidth - 85, 16, request.mailSizeLimit);

        sy += 22;
        labeledField('SMTP',            colLeftX, sy, 80, colWidth - 85, 16, request.smtpAddress);
        labeledField('Recipent Limit',  colRightX, sy, 80, colWidth - 85, 16, request.recipientLimit || '15 / 15');

        sy += 22;
        labeledField('Member of (if any)',   colLeftX, sy, 95, colWidth - 100, 16, request.memberOf);
        labeledField('Mailbox Storage Limit', colRightX, sy, 105, colWidth - 110, 16, request.mailboxStorageLimit || '250 MB');

        // ─── Group Policy Level ─────────────────────────────────────────
        sy += 28;
        sectionLabel('Group Policy Level:', colLeftX, sy);

        sy += 16;
        const gpl = request.groupPolicyLevel || '';
        const isHighly  = gpl === 'Highly Managed';
        const isLightly = gpl === 'Lightly Managed' || gpl === 'IT User';
        const highlyVal  = isHighly  ? (request.ntUserName || '✓') : '';
        const lightlyVal = isLightly ? `${request.ntUserName || '✓'}${gpl === 'IT User' ? '  (IT User)' : ''}` : '';
        labeledField('HighlyManagedUsers', colLeftX, sy, 110, colWidth - 115, 16, highlyVal);
        labeledField('LightlyManagUser',   colRightX, sy, 95, colWidth - 100, 16, lightlyVal);

        // ─── New / Previous Facilities ──────────────────────────────────
        sy += 22;
        labelText('New / Previous Facilities ( if any )', colLeftX, sy + 3);
        const newPrevX = colLeftX + 175;
        horizontalRule(newPrevX, M + W - 8, sy + 12);

        // ─── Extra Facility / Allegations / Comments / Malfunctioning ───
        sy += 18;
        labelText('Extra Facility / Allegations / Comments / Malfunctioning ( if any )', colLeftX, sy + 3);
        const extraStartX = colLeftX + 290;
        horizontalRule(extraStartX, M + W - 8, sy + 12);
        // Two extra free-text lines underneath
        sy += 18;
        const extraLine1Y = sy - 5;
        horizontalRule(colLeftX, M + W - 8, sy + 8);
        sy += 16;
        horizontalRule(colLeftX, M + W - 8, sy + 8);
        // Render the extra facility text on the lines below the label
        if (request.extraFacility) {
            doc.font('Helvetica').fontSize(8.5).fillColor('#000');
            doc.text(String(request.extraFacility), colLeftX + 2, extraLine1Y, {
                width: W - 16, height: 28, lineGap: 4, ellipsis: true
            });
        }

        // ─── Manager / HOD IT signature row at the bottom ───────────────
        const manY = sysBottom - 28;
        horizontalRule(colLeftX + 30,       colLeftX + 200,             manY);
        horizontalRule(M + W - 200,         M + W - 30,                  manY);
        doc.font('Helvetica').fontSize(9).fillColor('#000');
        text('Manager', colLeftX + 95,   manY + 5);
        text('HOD IT',  M + W - 130,     manY + 5);

        doc.end();
        stream.on('finish', () => resolve(outputPath));
        stream.on('error', reject);
    });
};

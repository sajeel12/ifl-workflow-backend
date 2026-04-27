import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOGO_PATH = path.resolve(__dirname, '..', '..', 'public', 'logo.png');

// Brand palette — kept in one place so it's easy to retheme later
const COLOR = {
    brandDark:   '#0F2A47',  // deep navy — header band
    brand:       '#0F4C81',  // primary blue — accents
    brandLight:  '#3B82F6',  // section bars
    accent:      '#0078D4',  // microsoft-style highlight
    success:     '#16A34A',
    danger:      '#DC2626',
    warning:     '#D97706',
    text:        '#0F172A',
    textMuted:   '#64748B',
    textLight:   '#94A3B8',
    border:      '#E2E8F0',
    bgSoft:      '#F8FAFC',
    bgYellow:    '#FEF3C7',
    bgGreen:     '#DCFCE7',
    bgRed:       '#FEE2E2',
    bgGray:      '#F1F5F9',
    white:       '#FFFFFF'
};

const PAGE = { width: 595, height: 842 };
const MARGIN = 40;
const CONTENT_W = PAGE.width - MARGIN * 2;

const fmtDate = (d) => {
    if (!d) return '—';
    const dt = (d instanceof Date) ? d : new Date(d);
    if (isNaN(dt.getTime())) return '—';
    return dt.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
};

const fmtVal = (v) => {
    if (v === null || v === undefined || v === '') return '—';
    if (v === true) return 'Yes';
    if (v === false) return 'No';
    return String(v);
};

export const generateOnboardingPDF = async (request, outputPath) => {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({
            size: 'A4',
            margin: MARGIN,
            bufferPages: true,
            info: {
                Title: `Onboarding Work Order #${request.id}`,
                Author: 'IFL Workflow System',
                Subject: `Onboarding for ${request.fullName || ''}`,
                Producer: 'Ibrahim Fibres Limited'
            }
        });
        const stream = fs.createWriteStream(outputPath);
        doc.pipe(stream);

        // --- helpers bound to this doc ---
        const ensureSpace = (need) => {
            if (doc.y + need > PAGE.height - 70) doc.addPage();
        };

        const drawHeaderBand = () => {
            // Solid brand band across the top
            doc.save();
            doc.rect(0, 0, PAGE.width, 90).fill(COLOR.brandDark);

            // Logo
            try {
                if (fs.existsSync(LOGO_PATH)) {
                    doc.image(LOGO_PATH, MARGIN, 22, { fit: [110, 46] });
                }
            } catch { /* logo optional */ }

            // Company wordmark
            doc.fillColor(COLOR.white)
               .font('Helvetica-Bold').fontSize(16)
               .text('IBRAHIM FIBRES LIMITED', MARGIN + 130, 28, { width: 260 });
            doc.font('Helvetica').fontSize(9).fillColor('#A8C5E0')
               .text('Workflow Automation · IT Onboarding Module', MARGIN + 130, 50, { width: 260 });

            // Right side document badge
            doc.font('Helvetica-Bold').fontSize(9).fillColor(COLOR.white)
               .text('WORK ORDER', PAGE.width - MARGIN - 140, 28, { width: 140, align: 'right' });
            doc.font('Helvetica-Bold').fontSize(14).fillColor(COLOR.white)
               .text(`#${request.id}`, PAGE.width - MARGIN - 140, 42, { width: 140, align: 'right' });
            doc.font('Helvetica').fontSize(8).fillColor('#A8C5E0')
               .text(fmtDate(new Date()), PAGE.width - MARGIN - 140, 62, { width: 140, align: 'right' });
            doc.restore();
        };

        const drawTitleStrip = () => {
            const y = 100;
            doc.font('Helvetica-Bold').fontSize(18).fillColor(COLOR.text)
               .text('User Onboarding — Service Request', MARGIN, y);
            doc.font('Helvetica').fontSize(10).fillColor(COLOR.textMuted)
               .text(`Intranet, Internet, Email, File-Share & Identity Provisioning`, MARGIN, y + 24);
            // Thin accent rule
            doc.moveTo(MARGIN, y + 44).lineTo(MARGIN + CONTENT_W, y + 44)
               .lineWidth(2).strokeColor(COLOR.brandLight).stroke();
            doc.y = y + 56;
        };

        const statusColor = (status) => {
            if (!status) return { bg: COLOR.bgGray, fg: COLOR.textMuted };
            const s = String(status).toLowerCase();
            if (s.includes('reject')) return { bg: COLOR.bgRed,    fg: COLOR.danger };
            if (s.includes('approve') || s === 'completed') return { bg: COLOR.bgGreen,  fg: COLOR.success };
            if (s.includes('pending')) return { bg: COLOR.bgYellow, fg: COLOR.warning };
            return { bg: COLOR.bgGray, fg: COLOR.textMuted };
        };

        const pill = (text, x, y, color) => {
            const c = color || statusColor(text);
            const padX = 8, padY = 3;
            doc.font('Helvetica-Bold').fontSize(9);
            const w = doc.widthOfString(text) + padX * 2;
            const h = 16;
            doc.save();
            doc.roundedRect(x, y, w, h, 8).fill(c.bg);
            doc.fillColor(c.fg).text(text, x + padX, y + padY, { lineBreak: false });
            doc.restore();
            return w;
        };

        const drawMetaCard = () => {
            const y = doc.y;
            const cellW = CONTENT_W / 4;
            const h = 56;

            doc.save();
            doc.roundedRect(MARGIN, y, CONTENT_W, h, 6).fill(COLOR.bgSoft);
            doc.lineWidth(0.5).strokeColor(COLOR.border).roundedRect(MARGIN, y, CONTENT_W, h, 6).stroke();

            const cells = [
                { label: 'REQUEST #',   value: `#${request.id}` },
                { label: 'EMPLOYEE ID', value: request.employeeId || '—' },
                { label: 'STAGE',       value: request.status || '—' },
                { label: 'APPROVAL',    value: request.approvalStatus || 'Pending' }
            ];

            cells.forEach((c, i) => {
                const cx = MARGIN + i * cellW + 12;
                doc.font('Helvetica-Bold').fontSize(7).fillColor(COLOR.textMuted)
                   .text(c.label, cx, y + 10, { width: cellW - 24, characterSpacing: 0.5 });
                if (c.label === 'APPROVAL' || c.label === 'STAGE') {
                    pill(c.value, cx, y + 26);
                } else {
                    doc.font('Helvetica-Bold').fontSize(13).fillColor(COLOR.text)
                       .text(c.value, cx, y + 24, { width: cellW - 24, lineBreak: false });
                }
                if (i > 0) {
                    doc.moveTo(MARGIN + i * cellW, y + 12)
                       .lineTo(MARGIN + i * cellW, y + h - 12)
                       .lineWidth(0.5).strokeColor(COLOR.border).stroke();
                }
            });
            doc.restore();
            doc.y = y + h + 14;
        };

        const sectionHeading = (title, tag) => {
            ensureSpace(40);
            const y = doc.y;
            // Left accent bar
            doc.save();
            doc.rect(MARGIN, y, 4, 22).fill(COLOR.brandLight);
            doc.font('Helvetica-Bold').fontSize(12).fillColor(COLOR.text)
               .text(title, MARGIN + 12, y + 4);
            if (tag) {
                doc.font('Helvetica-Bold').fontSize(8).fillColor(COLOR.brand);
                const tagW = doc.widthOfString(tag) + 14;
                doc.roundedRect(PAGE.width - MARGIN - tagW, y + 3, tagW, 16, 8).fill(COLOR.bgSoft);
                doc.fillColor(COLOR.brand)
                   .text(tag, PAGE.width - MARGIN - tagW + 7, y + 7, { lineBreak: false });
            }
            doc.restore();
            doc.y = y + 28;
        };

        // Render two-column key/value rows. Pass an array of {label, value, pill}
        const fieldGrid = (fields) => {
            const rowH = 24;
            const colW = CONTENT_W / 2;

            for (let i = 0; i < fields.length; i += 2) {
                ensureSpace(rowH + 4);
                const y = doc.y;
                const pair = [fields[i], fields[i + 1]];

                pair.forEach((f, idx) => {
                    if (!f) return;
                    const cx = MARGIN + idx * colW;
                    doc.font('Helvetica-Bold').fontSize(7).fillColor(COLOR.textMuted)
                       .text(String(f.label).toUpperCase(), cx + 6, y, { width: colW - 12, characterSpacing: 0.5 });
                    if (f.pill) {
                        pill(fmtVal(f.value), cx + 6, y + 9);
                    } else {
                        doc.font('Helvetica').fontSize(10).fillColor(COLOR.text)
                           .text(fmtVal(f.value), cx + 6, y + 9, { width: colW - 12, ellipsis: true, lineBreak: false });
                    }
                });
                doc.y = y + rowH;
            }
            // Subtle row separator after section
            doc.moveTo(MARGIN, doc.y + 2).lineTo(MARGIN + CONTENT_W, doc.y + 2)
               .lineWidth(0.4).strokeColor(COLOR.border).stroke();
            doc.y += 12;
        };

        // Render a clean vertical service list — one row per service with status
        // dot, label and configuration detail. Always shows every service so the
        // work order doubles as full documentation (disabled rows are dimmed).
        const serviceList = (services) => {
            const ROW_H = 28;
            const STATUS_W = 26;
            const LABEL_W = 170;
            const DETAIL_X = MARGIN + STATUS_W + LABEL_W + 8;
            const DETAIL_W = MARGIN + CONTENT_W - DETAIL_X;

            services.forEach((s, idx) => {
                const on = !!s.on;
                // Detail height may push to a 2nd line — measure first
                doc.font('Helvetica').fontSize(9.5);
                const detailText = on
                    ? (s.detail && String(s.detail).trim() ? String(s.detail) : 'Requested')
                    : 'Not requested';
                const detailH = doc.heightOfString(detailText, { width: DETAIL_W });
                const rowH = Math.max(ROW_H, detailH + 12);

                ensureSpace(rowH + 4);
                const y = doc.y;

                // Zebra background
                if (idx % 2 === 0) {
                    doc.save();
                    doc.rect(MARGIN, y, CONTENT_W, rowH).fill(COLOR.bgSoft);
                    doc.restore();
                }

                // Status icon (filled circle for enabled, hollow for disabled)
                doc.save();
                if (on) {
                    doc.circle(MARGIN + 12, y + rowH / 2, 7).fill(COLOR.success);
                    doc.fillColor(COLOR.white).font('Helvetica-Bold').fontSize(9)
                       .text('✓', MARGIN + 8.5, y + rowH / 2 - 5, { lineBreak: false });
                } else {
                    doc.lineWidth(1.2).strokeColor(COLOR.textLight)
                       .circle(MARGIN + 12, y + rowH / 2, 7).stroke();
                }
                doc.restore();

                // Label
                doc.font('Helvetica-Bold').fontSize(10)
                   .fillColor(on ? COLOR.text : COLOR.textMuted)
                   .text(s.label, MARGIN + STATUS_W, y + 6, { width: LABEL_W, lineBreak: false });

                // Detail
                doc.font('Helvetica').fontSize(9.5)
                   .fillColor(on ? COLOR.text : COLOR.textLight)
                   .text(detailText, DETAIL_X, y + 6, { width: DETAIL_W });

                doc.y = y + rowH;
            });

            // Bottom rule
            doc.moveTo(MARGIN, doc.y + 2).lineTo(MARGIN + CONTENT_W, doc.y + 2)
               .lineWidth(0.4).strokeColor(COLOR.border).stroke();
            doc.y += 12;
        };

        const remarksBlock = (label, text) => {
            if (!text) return;
            ensureSpace(60);
            const y = doc.y;
            const padding = 12;
            doc.font('Helvetica-Bold').fontSize(8).fillColor(COLOR.textMuted)
               .text(label.toUpperCase(), MARGIN, y, { characterSpacing: 0.5 });
            doc.y = y + 12;

            const textY = doc.y;
            doc.font('Helvetica-Oblique').fontSize(10).fillColor(COLOR.text);
            const textHeight = doc.heightOfString(text, { width: CONTENT_W - padding * 2 });
            doc.save();
            doc.rect(MARGIN, textY, 3, textHeight + padding).fill(COLOR.brandLight);
            doc.rect(MARGIN + 3, textY, CONTENT_W - 3, textHeight + padding).fill(COLOR.bgSoft);
            doc.fillColor(COLOR.text)
               .text(text, MARGIN + padding + 3, textY + padding / 2, { width: CONTENT_W - padding * 2 });
            doc.restore();
            doc.y = textY + textHeight + padding + 8;
        };

        const drawApprovalTimeline = () => {
            const steps = [
                { role: 'HR Submitted',     ts: request.hrSubmittedAt,        ok: true },
                { role: 'IT Configured',    ts: request.itSubmittedAt,        ok: !!request.itSubmittedAt },
                { role: 'HOD Approved',     ts: request.hodApprovedAt,        ok: !!request.hodApprovedAt },
                { role: 'DCI Submitted',    ts: request.dciSubmittedAt,       ok: !!request.dciSubmittedAt },
                { role: 'DCI Mgr Decided',  ts: request.dciManagerDecidedAt,  ok: !!request.dciManagerDecidedAt },
            ];
            if (request.itHodDecidedAt) {
                steps.push({ role: 'IT HOD Decided', ts: request.itHodDecidedAt, ok: true });
            }

            sectionHeading('Approval Flow', 'TIMELINE');
            ensureSpace(70);
            const y = doc.y;
            const stepW = CONTENT_W / steps.length;

            // connector line
            doc.moveTo(MARGIN + 16, y + 14).lineTo(MARGIN + CONTENT_W - 16, y + 14)
               .lineWidth(2).strokeColor(COLOR.border).stroke();

            steps.forEach((s, i) => {
                const cx = MARGIN + stepW * i + stepW / 2;
                // dot
                const dotColor = s.ok ? COLOR.success : COLOR.textLight;
                doc.save();
                doc.circle(cx, y + 14, 8).fill(dotColor);
                doc.fillColor(COLOR.white).font('Helvetica-Bold').fontSize(9)
                   .text(s.ok ? '✓' : String(i + 1), cx - 3, y + 9, { lineBreak: false });
                doc.restore();
                // label
                doc.font('Helvetica-Bold').fontSize(8).fillColor(COLOR.text)
                   .text(s.role, MARGIN + stepW * i, y + 30, { width: stepW, align: 'center' });
                doc.font('Helvetica').fontSize(7).fillColor(COLOR.textMuted)
                   .text(s.ts ? fmtDate(s.ts) : 'Pending', MARGIN + stepW * i, y + 42, { width: stepW, align: 'center' });
            });
            doc.y = y + 64;
        };

        const drawFooterOnAllPages = () => {
            const range = doc.bufferedPageRange();
            for (let i = 0; i < range.count; i++) {
                doc.switchToPage(i);
                const fy = PAGE.height - 40;
                doc.save();
                doc.rect(0, fy, PAGE.width, 40).fill(COLOR.bgSoft);
                doc.moveTo(0, fy).lineTo(PAGE.width, fy).lineWidth(0.5).strokeColor(COLOR.border).stroke();
                doc.font('Helvetica').fontSize(8).fillColor(COLOR.textMuted)
                   .text('Confidential · Generated by IFL Workflow System', MARGIN, fy + 14, { width: CONTENT_W / 2 });
                doc.font('Helvetica-Bold').fontSize(8).fillColor(COLOR.textMuted)
                   .text(`Page ${i + 1} of ${range.count}`, MARGIN + CONTENT_W / 2, fy + 14, { width: CONTENT_W / 2, align: 'right' });
                doc.restore();
            }
        };

        // ============================================================
        // BUILD THE DOCUMENT
        // ============================================================
        drawHeaderBand();
        drawTitleStrip();
        drawMetaCard();

        // 1. Employee details
        sectionHeading('Employee Details', 'HR');
        fieldGrid([
            { label: 'Full Name',      value: request.fullName },
            { label: 'Employee ID',    value: request.employeeId },
            { label: 'Department',     value: request.department },
            { label: 'Sub-Department', value: request.subDepartment },
            { label: 'Designation',    value: request.designation },
            { label: 'Location',       value: request.location || request.projectUnit },
            { label: 'HOD',            value: request.hod },
            { label: 'Joining Date',   value: request.joiningDate ? fmtDate(request.joiningDate) : '—' },
            { label: 'Office Ext.',    value: request.officeExtension },
            { label: 'Mobile',         value: request.mobilePhone },
            { label: 'Request Mode',   value: request.requestMode || 'New' },
            { label: 'Initiated By',   value: request.requesterName || 'HR' }
        ]);

        // 2. Services requested — vertical list with proper details
        sectionHeading('Services Requested', 'IT OPS');
        serviceList([
            {
                label: 'Intranet Access',
                on: request.intranetAccess,
                detail: 'IFL intranet portal & internal applications.'
            },
            {
                label: 'Internet Access',
                on: request.internetAccess,
                detail: request.specificWebsites
                    ? `Restricted — specific websites only${request.internetPurpose ? '. ' + request.internetPurpose : ''}`
                    : (request.internetPurpose || 'Open internet access')
            },
            {
                label: 'Email — Incoming',
                on: request.emailIncoming,
                detail: request.emailPurpose || 'External incoming mail allowed.'
            },
            {
                label: 'Email — Outgoing',
                on: request.emailOutgoing,
                detail: request.emailPurpose || 'External outgoing mail allowed.'
            },
            {
                label: 'Laser Printer',
                on: request.laserPrinter,
                detail: request.laserPrinterLocation || 'Default location'
            },
            {
                label: 'Dot-Matrix Printer',
                on: request.dotMatrixPrinter,
                detail: request.dotMatrixPrinterLocation || 'Default location'
            }
        ]);

        // 3. File share & SharePoint
        if (request.deptSharePath || request.homeFolderPath || request.iflPortalLink) {
            sectionHeading('File Share & SharePoint', 'IT OPS');
            fieldGrid([
                { label: 'Department Share (S:)',  value: request.deptSharePath },
                { label: 'Home Folder (Z:)',       value: request.homeFolderPath },
                { label: 'SharePoint / Portal',    value: request.iflPortalLink },
                { label: 'SharePoint Role',        value: request.sharepointRole, pill: true }
            ]);
        }

        // 4. DCI / Identity
        if (request.ntUserName || request.smtpAddress || request.exchangeDisplayName) {
            sectionHeading('DCI Configuration — Identity', 'DCI TEAM');
            fieldGrid([
                { label: 'NT User Name',         value: request.ntUserName },
                { label: 'Exchange Display',     value: request.exchangeDisplayName },
                { label: 'SMTP Address',         value: request.smtpAddress },
                { label: 'Group Policy',         value: request.groupPolicyLevel, pill: true },
                { label: 'Member Of',            value: request.memberOf },
                { label: 'DG Members',           value: request.dgMembers },
                { label: 'Mail Size Limit',      value: request.mailSizeLimit },
                { label: 'Recipient Limit',      value: request.recipientLimit },
                { label: 'Mailbox Storage',      value: request.mailboxStorageLimit },
                request.extraFacility ? { label: 'Extra Facility', value: request.extraFacility } : null
            ].filter(Boolean));
        }

        // 5. Approval flow / timeline
        drawApprovalTimeline();

        // 6. Remarks blocks
        if (request.hodRemarks)               remarksBlock('HOD Remarks',                  request.hodRemarks);
        if (request.dciChangeRequestRemarks)  remarksBlock('DCI Manager — Change Request', request.dciChangeRequestRemarks);
        if (request.dciRemarks)               remarksBlock('DCI Manager Remarks',          request.dciRemarks);
        if (request.itHodRemarks)             remarksBlock('IT HOD Remarks',               request.itHodRemarks);

        // 7. Sign-off footer
        ensureSpace(80);
        const sy = doc.y + 6;
        doc.save();
        doc.roundedRect(MARGIN, sy, CONTENT_W, 70, 6).fill(COLOR.bgSoft);
        doc.lineWidth(0.5).strokeColor(COLOR.border).roundedRect(MARGIN, sy, CONTENT_W, 70, 6).stroke();
        doc.font('Helvetica-Bold').fontSize(9).fillColor(COLOR.brand)
           .text('AUTHORIZATION', MARGIN + 14, sy + 12, { characterSpacing: 0.5 });
        doc.font('Helvetica').fontSize(9).fillColor(COLOR.text)
           .text(`This Work Order has been digitally generated by the IFL Workflow System after passing all required approval gates. The current approval status is `, MARGIN + 14, sy + 28, { width: CONTENT_W - 28, continued: true })
           .font('Helvetica-Bold').fillColor(COLOR.brand)
           .text(`${request.approvalStatus || 'Pending'}`, { continued: true })
           .font('Helvetica').fillColor(COLOR.text)
           .text(`. The DCI Implementer is authorized to provision the AD/Exchange account and OPS to complete physical setup.`);
        doc.restore();

        // Footer on all pages (must be after all content for buffered pages)
        drawFooterOnAllPages();

        doc.end();
        stream.on('finish', () => resolve(outputPath));
        stream.on('error', reject);
    });
};

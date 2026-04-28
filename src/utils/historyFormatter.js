const FIELD_LABELS = {
    intranetAccess: 'Intranet Access',
    internetAccess: 'Internet Access',
    specificWebsites: 'Specific Websites',
    internetPurpose: 'Internet Purpose',
    emailIncoming: 'Incoming Email',
    emailOutgoing: 'Outgoing Email',
    emailPurpose: 'Email Purpose',
    laserPrinter: 'Laser Printer',
    laserPrinterLocation: 'Laser Printer Location',
    dotMatrixPrinter: 'Dot Matrix Printer',
    dotMatrixPrinterLocation: 'Dot Matrix Location',
    deptSharePath: 'Department Share',
    homeFolderPath: 'Home Folder',
    iflPortalLink: 'SharePoint / Portal Link',
    sharepointRole: 'SharePoint Role',
    ntUserName: 'NT User Name',
    exchangeDisplayName: 'Exchange Display Name',
    smtpAddress: 'SMTP Address',
    memberOf: 'Member Of',
    dgMembers: 'DG Members',
    mailSizeLimit: 'Mail Size Limit',
    recipientLimit: 'Recipient Limit',
    mailboxStorageLimit: 'Mailbox Storage Limit',
    extraFacility: 'Extra Facility',
    groupPolicyLevel: 'Group Policy Level',
    hodRemarks: 'HOD Remarks',
    dciRemarks: 'DCI Remarks',
    itHodRemarks: 'IT HOD Remarks'
};

const formatValue = (v) => {
    if (v === true || v === 'true') return 'Yes';
    if (v === false || v === 'false') return 'No';
    if (v === null || v === undefined || v === '') return '—';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
};

const looksLikeJson = (s) => typeof s === 'string' && (s.trim().startsWith('{') || s.trim().startsWith('['));

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Inline SVG icons (16×16) — kept small enough to embed directly in HTML
const SVG_CHECK = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;color:#16a34a;"><polyline points="20 6 9 17 4 12"></polyline></svg>';
const SVG_CROSS = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;color:#dc2626;"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';

const valuePill = (v) => {
    if (v === true || v === 'true') return `<span style="display:inline-flex;align-items:center;gap:4px;background:#dcfce7;color:#16a34a;padding:1px 8px;border-radius:10px;font-size:0.75rem;font-weight:600;">${SVG_CHECK} Yes</span>`;
    if (v === false || v === 'false') return `<span style="display:inline-flex;align-items:center;gap:4px;background:#f1f5f9;color:#64748b;padding:1px 8px;border-radius:10px;font-size:0.75rem;font-weight:600;">${SVG_CROSS} No</span>`;
    if (v === null || v === undefined || v === '') return `<span style="color:#94a3b8;font-style:italic;">—</span>`;
    return `<span style="color:#0f172a;">${escapeHtml(String(v))}</span>`;
};

/**
 * Convert a raw timeline event details payload into a human-readable
 * list of "Label: Value" lines. Plain text (e.g. remarks) is returned as-is.
 */
export const humanizeDetails = (details) => {
    if (!details) return '';

    if (!looksLikeJson(details)) return details;

    let parsed;
    try {
        parsed = JSON.parse(details);
    } catch {
        return details;
    }

    if (Array.isArray(parsed)) {
        return parsed
            .map(item => {
                if (item && typeof item === 'object') {
                    if ('item' in item) {
                        return `${item.checked ? '✔' : '✗'} ${item.item}`;
                    }
                    return Object.entries(item).map(([k, v]) => `${FIELD_LABELS[k] || k}: ${formatValue(v)}`).join(', ');
                }
                return String(item);
            })
            .join('\n');
    }

    if (parsed && typeof parsed === 'object') {
        return Object.entries(parsed)
            .filter(([, v]) => v !== null && v !== undefined && v !== '')
            .map(([k, v]) => `${FIELD_LABELS[k] || k}: ${formatValue(v)}`)
            .join('\n');
    }

    return String(parsed);
};

/**
 * HTML version of humanizeDetails — renders inline SVG icons for booleans
 * and a styled key/value grid. Returns safe HTML; values are escaped.
 */
export const humanizeDetailsHTML = (details) => {
    if (!details) return '';

    if (!looksLikeJson(details)) {
        return `<div style="white-space:pre-wrap;">${escapeHtml(details)}</div>`;
    }

    let parsed;
    try { parsed = JSON.parse(details); } catch { return escapeHtml(details); }

    if (Array.isArray(parsed)) {
        return '<ul style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;">' +
            parsed.map(item => {
                if (item && typeof item === 'object') {
                    if ('item' in item) {
                        const icon = item.checked ? SVG_CHECK : SVG_CROSS;
                        return `<li style="display:flex;align-items:center;gap:8px;font-size:0.85rem;color:#334155;">${icon}<span>${escapeHtml(item.item)}</span></li>`;
                    }
                    const cells = Object.entries(item)
                        .map(([k, v]) => `<strong style="color:#475569;">${escapeHtml(FIELD_LABELS[k] || k)}:</strong> ${valuePill(v)}`)
                        .join(' · ');
                    return `<li style="font-size:0.85rem;">${cells}</li>`;
                }
                return `<li>${escapeHtml(String(item))}</li>`;
            }).join('') + '</ul>';
    }

    if (parsed && typeof parsed === 'object') {
        const rows = Object.entries(parsed)
            .filter(([, v]) => v !== null && v !== undefined && v !== '')
            .map(([k, v]) => `<div><strong style="color:#475569;font-weight:600;">${escapeHtml(FIELD_LABELS[k] || k)}:</strong> ${valuePill(v)}</div>`)
            .join('');
        return `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:6px 16px;font-size:0.85rem;">${rows}</div>`;
    }

    return escapeHtml(String(parsed));
};

/**
 * Friendly label for an action key — falls back to the raw action string.
 */
export const humanizeAction = (action) => {
    if (!action) return '';
    return action.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
};

/**
 * Produce a single user-friendly sentence describing a workflow event.
 * Used by the inline history panel where staged users should see a clean
 * narrative — not internal JSON dumps. Hides implementation details by design.
 */
export const narrate = (event = {}) => {
    const action = event.action || '';
    const details = event.details || '';
    const isJson = looksLikeJson(details);

    // Pull the optional remarks/note string out of plain-text details
    const remark = !isJson && details ? String(details).trim() : '';

    switch (action) {
        case 'Request Initiated':
            return remark || 'Request submitted by HR.';
        case 'IT Services Configured':
            return 'IT Operations configured the requested services and forwarded the request.';
        case 'HOD Approved':
            return remark
                ? `Head of Department approved the request. Remarks: ${remark}`
                : 'Head of Department approved the request.';
        case 'HOD Rejected':
            return remark
                ? `Head of Department rejected the request. Remarks: ${remark}`
                : 'Head of Department rejected the request.';
        case 'DCI Configuration Submitted':
            return 'DCI Team submitted the AD/Exchange identity configuration.';
        case 'DCI Manager Approved':
            return remark
                ? `DCI Manager approved the configuration. Remarks: ${remark}`
                : 'DCI Manager approved the configuration.';
        case 'DCI Manager Approved (High Risk)':
            return 'DCI Manager approved; routed to IT HOD for email-policy sign-off.';
        case 'DCI Manager Rejected':
            return remark
                ? `DCI Manager rejected the request. Remarks: ${remark}`
                : 'DCI Manager rejected the request.';
        case 'DCI Manager Requested Changes':
            return remark
                ? `DCI Manager requested changes. Notes: ${remark}`
                : 'DCI Manager requested changes — sent back to DCI Team.';
        case 'IT HOD Approved':
            return remark
                ? `IT HOD approved external email access. Remarks: ${remark}`
                : 'IT HOD approved external email access.';
        case 'IT HOD Rejected':
            return remark
                ? `IT HOD rejected the request. Remarks: ${remark}`
                : 'IT HOD rejected the request.';
        case 'DCI Implementation Completed':
            return remark || 'Account provisioned and proof uploaded by DCI Implementer.';
        case 'OPS Checklist Completed':
            return 'Workstation setup verified by OPS — request closed.';
        case 'Email Regenerated':
            return 'Action email re-sent by Admin.';
        case 'Work Order PDF Emailed':
            return 'Work Order PDF sent to DCI Manager for record.';
        default:
            return humanizeAction(action) + (remark ? `. ${remark}` : '');
    }
};

export default { humanizeDetails, humanizeDetailsHTML, humanizeAction, narrate };

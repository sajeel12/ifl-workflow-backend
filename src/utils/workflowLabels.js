/**
 * Centralised mapping from internal workflow strings → user-facing labels.
 *
 * Source of truth: the client's "Workflow Stage Nomenclature" table. Any
 * place we show a status to a user MUST go through one of the helpers in
 * this file so a one-line edit here updates every screen, email, and PDF.
 */

// Internal status (OnboardingRequest.status) → user-facing label.
export const STATUS_LABEL = {
    Draft:                    'Draft',
    PendingIT:                'Pending IT Operations',
    PendingHOD:               'Pending HOD Approval',
    PendingDCI:               'Pending DCI Configuration',
    PendingDCIManager:        'Pending Manager Approval',
    PendingITHOD:             'Pending IT HOD Approval',
    PendingDCIImplementation: 'Pending Implementation',
    PendingOPSAction:         'Pending OPS Verification',
    Completed:                'Closed',
    Approved:                 'Approved',
    Rejected:                 'Rejected',
    Submitted:                'Submitted'
};

// Internal status → role currently responsible (label + machine roleKey).
export const STATUS_OWNER = {
    PendingIT:                { label: 'IT Operations',           roleKey: 'IT_OPS' },
    PendingHOD:               { label: 'Head of Department',      roleKey: 'HOD' },
    PendingDCI:               { label: 'DCI Team',                roleKey: 'DCI_TEAM' },
    PendingDCIManager:        { label: 'DCI Manager',             roleKey: 'DCI_MANAGER' },
    PendingITHOD:             { label: 'IT HOD',                  roleKey: 'IT_HOD' },
    PendingDCIImplementation: { label: 'DCI Implementation Team', roleKey: 'DCI_IMPLEMENTER' },
    PendingOPSAction:         { label: 'IT OPS Team',             roleKey: 'OPS_TEAM' },
    Completed:                { label: '—',                       roleKey: null },
    Rejected:                 { label: 'Closed',                  roleKey: null },
    Draft:                    { label: 'HR / IT Requestor',       roleKey: null }
};

// Pretty label for a status, with sensible fallback.
export const labelFor = (status) =>
    STATUS_LABEL[status] || (status || '').replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase()).trim();

// Owner label for a status.
export const ownerFor = (status) => (STATUS_OWNER[status] || { label: '—' }).label;

// Color hint for the badge UI — keep consistent across screens.
export const colorFor = (status) => {
    if (!status) return 'default';
    if (status === 'Rejected')  return 'danger';
    if (status === 'Completed') return 'success';
    if (status === 'Approved')  return 'success';
    if (status.startsWith('Pending')) return 'warning';
    return 'info';
};

export default { STATUS_LABEL, STATUS_OWNER, labelFor, ownerFor, colorFor };

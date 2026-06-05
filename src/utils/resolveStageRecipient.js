import WorkflowApproverConfig from '../models/WorkflowApproverConfig.js';
import WorkflowApproverLocationOverride from '../models/WorkflowApproverLocationOverride.js';

// Map workflow status -> the role currently responsible for it. Status names are
// shared between onboarding and offboarding (e.g. PendingDCIManager,
// PendingDCIImplementation), so this map serves both.
export const STATUS_TO_ROLE = {
    PendingIT: { key: 'IT_OPS', label: 'IT Operations' },
    PendingHOD: { key: 'HOD', label: 'Head of Department' },
    PendingDCI: { key: 'DCI_TEAM', label: 'DCI Team' },
    PendingDCIManager: { key: 'DCI_MANAGER', label: 'DCI Manager' },
    PendingITHOD: { key: 'IT_HOD', label: 'IT HOD' },
    PendingDCIImplementation: { key: 'DCI_IMPLEMENTER', label: 'DCI Implementer' },
    // Step 12 owner is IT Operations (same group as Step 2) per client requirement.
    PendingOPSAction: { key: 'IT_OPS', label: 'IT Operations' },
    Completed: { key: null, label: 'Completed' },
    Rejected: { key: null, label: 'Closed (Rejected)' }
};

// IT_OPS and HR_INITIATOR are split by location group; all other roles use a
// single global config row. Mirrors the same constant in recipientService.js.
export const LOCATION_AWARE_ROLE_KEYS = new Set(['IT_OPS', 'HR_INITIATOR']);

// Resolve who is currently configured for a given workflow status, optionally
// scoped by location for location-aware roles (IT_OPS / HR_INITIATOR). Checks the
// per-location override first, then falls back to the global config row, and
// honours the primary->secondary fallback (primaryExpiredAt). Returns
// { role, name, email, username }. Shared by the approval form gate, the admin
// resend flow, and the in-flight rebind on approver change.
export const resolveStageRecipient = async (status, location = null) => {
    const map = STATUS_TO_ROLE[status];
    if (!map) return { role: status, name: '', email: '' };
    if (!map.key) return { role: map.label, name: '', email: '' };
    try {
        let cfg = null;
        if (location && LOCATION_AWARE_ROLE_KEYS.has(map.key)) {
            cfg = await WorkflowApproverLocationOverride.findOne({
                where: { roleKey: map.key, location, isActive: true }
            });
        }
        if (!cfg) {
            cfg = await WorkflowApproverConfig.findOne({ where: { roleKey: map.key, isActive: true } });
        }
        if (!cfg) return { role: map.label, name: '', email: '', username: '' };
        const usingSecondary = cfg.primaryExpiredAt && cfg.secondaryEmail;
        return {
            role:     map.label + (usingSecondary ? ' (Secondary)' : ''),
            name:     usingSecondary ? cfg.secondaryName     : cfg.approverName,
            email:    usingSecondary ? cfg.secondaryEmail    : cfg.approverEmail,
            username: usingSecondary ? (cfg.secondaryUsername || '') : (cfg.approverUsername || '')
        };
    } catch {
        return { role: map.label, name: '', email: '' };
    }
};

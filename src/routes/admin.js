import express from 'express';
import adminController from '../controllers/adminController.js';
import * as ejController from '../controllers/employeeJourneyController.js';
import { diagnoseLookup, findUserByEmail, searchUsersByName } from '../services/adService.js';
import { adminApiGuard, adminPageGuard } from '../middleware/adminMiddleware.js';

const router = express.Router();

// ── Page routes ───────────────────────────────────────────────────────────────
// adminPageGuard reads X-Auth-User directly — no ssoMiddleware, never 401,
// so IIS Windows-Auth never re-prompts. Non-admins get a 403 render page.
// If the header is absent (direct Node access), guard passes through and the
// API guards on each data call still protect the data.
router.get('/hod-panel',          adminPageGuard, adminController.renderHodPanel);
router.get('/settings',           adminPageGuard, adminController.renderSettingsPanel);
router.get('/offboarding',        adminPageGuard, adminController.renderOffboardingPanel);
router.get('/workflow-approvers', adminPageGuard, adminController.renderWorkflowApproversPanel);
router.get('/onboarding-history',  adminPageGuard, adminController.renderOnboardingHistoryPanel);
router.get('/offboarding-history', adminPageGuard, adminController.renderOffboardingHistoryPanel);
router.get('/system-config',      adminPageGuard, adminController.renderSystemConfigPanel);
router.get('/employee-journey',   adminPageGuard, adminController.renderEmployeeJourneyPanel);

// ── API guard ─────────────────────────────────────────────────────────────────
// adminApiGuard reads X-Auth-User directly (same as adminPageGuard) and returns
// 403 JSON on failure — never 401. IIS intercepts 401 and shows a Windows Auth
// login popup for every fetch() call, which breaks the admin page JS.
const guard = [adminApiGuard];

router.get('/employees',                        ...guard, adminController.searchEmployees);
router.get('/employee/:id',                     ...guard, adminController.getEmployeeDetails);
router.put('/employee/:id',                     ...guard, adminController.updateEmployeeDetails);
router.post('/assign-hod',                      ...guard, adminController.assignHod);
router.post('/remove-hod',                      ...guard, adminController.removeHod);
router.post('/sync-now',                        ...guard, adminController.triggerManualSync);
router.post('/update-sync-config',              ...guard, adminController.updateSyncConfig);
router.get('/departments',                      ...guard, adminController.getDepartments);
router.post('/assign-department-hod',           ...guard, adminController.assignDepartmentHod);
router.get('/locations',                        ...guard, adminController.getLocations);
router.get('/workflow-approvers/by-location',   ...guard, adminController.getApproversForLocation);
router.put('/workflow-approvers/by-location',   ...guard, adminController.upsertApproverForLocation);
router.get('/workflow-approvers/api',           ...guard, adminController.getWorkflowApprovers);
router.put('/workflow-approvers/:id/revert',    ...guard, adminController.revertDelegation);
router.put('/workflow-approvers/:id',           ...guard, adminController.updateWorkflowApprover);
router.get('/onboarding-requests',              ...guard, adminController.getOnboardingRequests);
router.get('/onboarding-timeline/:id',          ...guard, adminController.getOnboardingTimeline);
router.get('/offboarding-requests',             ...guard, adminController.getOffboardingRequests);
router.get('/offboarding-timeline/:id',         ...guard, adminController.getOffboardingTimeline);

// ── Employee Journey APIs (admin-only, adminApiGuard) ─────────────────────
router.get('/ej/employees',                              ...guard, ejController.listEmployees);
router.get('/ej/employees-ad-batch',                     ...guard, ejController.getEmployeesAdBatch);
router.get('/ej/employees/:employeeNumber',              ...guard, ejController.getEmployeeDetail);
router.get('/ej/employees/:employeeNumber/ad-profile',   ...guard, ejController.getEmployeeAdProfile);
router.get('/ej/requests/:requestId/timeline',           ...guard, ejController.getRequestTimeline);
router.post('/system-config/update',            ...guard, adminController.updateSystemConfig);
router.post('/onboarding/:id/resend-email',     ...guard, adminController.resendStageEmail);

// Search AD users by name/sAMAccountName/email — powers the approver search box.
// Also accepts ?employeeId=X for a reliable exact-match lookup by employeeID attribute.
router.get('/ad-search', ...guard, async (req, res) => {
    const q          = (req.query.q          || '').trim();
    const employeeId = (req.query.employeeId || '').trim();

    try {
        if (employeeId) {
            const { findUserByEmployeeIdViaSidecar } = await import('../services/adService.js');
            const user = await findUserByEmployeeIdViaSidecar(employeeId);
            return res.json({ success: true, results: user ? [user] : [] });
        }
        if (q.length < 2) return res.status(400).json({ success: false, error: 'q must be at least 2 characters' });
        const results = await searchUsersByName(q);
        res.json({ success: true, results });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Resolve AD sAMAccountName from an email address — used by the admin UI
// to populate the login name field after an employee is selected from search.
router.get('/ad-user', ...guard, async (req, res) => {
    const email = (req.query.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'email query param required' });
    try {
        const user = await findUserByEmail(email);
        if (!user) return res.json({ found: false, sAMAccountName: null, displayName: null });
        res.json({
            found:          true,
            sAMAccountName: user.sAMAccountName || null,
            displayName:    user.displayName    || null,
            mail:           user.mail           || null,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/ad-lookup', ...guard, async (req, res) => {
    const username = (req.query.username || '').trim();
    if (!username) return res.status(400).json({ error: 'username query param required' });
    try {
        const result = await diagnoseLookup(username);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;

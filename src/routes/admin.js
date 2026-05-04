import express from 'express';
import adminController from '../controllers/adminController.js';

const router = express.Router();

// Render Views
router.get('/hod-panel', adminController.renderHodPanel);
router.get('/settings', adminController.renderSettingsPanel);
router.get('/offboarding', adminController.renderOffboardingPanel);
router.get('/workflow-approvers', adminController.renderWorkflowApproversPanel);
router.get('/onboarding-history', adminController.renderOnboardingHistoryPanel);
router.get('/system-config', adminController.renderSystemConfigPanel);

// API endpoints internally for the admin section
router.get('/employees', adminController.searchEmployees);
router.get('/employee/:id', adminController.getEmployeeDetails);
router.put('/employee/:id', adminController.updateEmployeeDetails);
router.post('/assign-hod', adminController.assignHod);
router.post('/remove-hod', adminController.removeHod);
router.post('/sync-now', adminController.triggerManualSync);
router.post('/update-sync-config', adminController.updateSyncConfig);// Department HOD Assignment
router.get('/departments', adminController.getDepartments);
router.post('/assign-department-hod', adminController.assignDepartmentHod);

// Workflow Approver Configuration (per-location) — must be before /:id wildcard
router.get('/locations',                       adminController.getLocations);
router.get('/workflow-approvers/by-location',  adminController.getApproversForLocation);
router.put('/workflow-approvers/by-location',  adminController.upsertApproverForLocation);

// Workflow Approver Configuration (global) — /:id wildcard AFTER specific routes
router.get('/workflow-approvers/api', adminController.getWorkflowApprovers);
router.put('/workflow-approvers/:id', adminController.updateWorkflowApprover);

// Onboarding History & Timeline
router.get('/onboarding-requests', adminController.getOnboardingRequests);
router.get('/onboarding-timeline/:id', adminController.getOnboardingTimeline);

// System Configuration (Printers, File Paths, SharePoint)
router.post('/system-config/update', adminController.updateSystemConfig);

// Resend the active stage email for an onboarding request (admin recovery)
router.post('/onboarding/:id/resend-email', adminController.resendStageEmail);

export default router;

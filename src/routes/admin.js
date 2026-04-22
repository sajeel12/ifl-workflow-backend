import express from 'express';
import adminController from '../controllers/adminController.js';

const router = express.Router();

// Render Views
router.get('/hod-panel', adminController.renderHodPanel);
router.get('/settings', adminController.renderSettingsPanel);
router.get('/offboarding', adminController.renderOffboardingPanel);
router.get('/workflow-approvers', adminController.renderWorkflowApproversPanel);

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

// Workflow Approver Configuration
router.get('/workflow-approvers/api', adminController.getWorkflowApprovers);
router.put('/workflow-approvers/:id', adminController.updateWorkflowApprover);

export default router;

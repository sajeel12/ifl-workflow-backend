import express from 'express';
import { upload } from '../utils/upload.js';
const router = express.Router();
import * as onboardingController from '../controllers/onboardingController.js';
import * as approvalController from '../controllers/approvalController.js';
import * as workflowTestController from '../controllers/workflowTestController.js';
import { ssoMiddleware } from '../middleware/ssoMiddleware.js';
import * as authController from '../controllers/authController.js';
import * as offboardingController from '../controllers/offboardingController.js';


router.post('/test/access-request', workflowTestController.createTestAccessRequest);


router.get('/test/request/:requestId/status', workflowTestController.getRequestStatus);


router.post('/test/approve/:token', workflowTestController.testApproveReject);


router.all('/approvals/handle', approvalController.handleApprovalClick);


router.get('/auth/me', ssoMiddleware, authController.getCurrentUser);

// User Onboarding Routes
// /initiate is gated by SSO so the requester identity comes from AD, not form input.
// /handle stays unauthenticated — it's reached via one-time email approval tokens
// (DCI Manager / IT HOD actionable cards) that have their own auth.
router.get('/onboarding/initiate', ssoMiddleware, onboardingController.handleRequest);
router.post('/onboarding/initiate', ssoMiddleware, onboardingController.handleRequest);
router.get('/onboarding/handle', onboardingController.handleRequest);
router.post('/onboarding/handle', onboardingController.handleRequest);

// Proof upload is performed by the DCI Implementer in a logged-in browser session,
// so SSO is required — implementerName is taken from req.user, not the form.
router.post('/onboarding/upload-proof', ssoMiddleware, upload.array('dciProof', 5), onboardingController.handleProofUpload);

// Lookup active onboarding request by employeeId (used by HR form JS)
router.get('/onboarding/lookup', onboardingController.lookupExistingRequest);

// History / status view for an existing onboarding request
router.get('/onboarding/history/:id', onboardingController.renderHistory);

// Role-scoped queue: pending actions or full history for a given role (JSON)
router.get('/onboarding/queue', onboardingController.getRoleQueue);

// Role-scoped queue (rendered page) — the user-facing "My Pending Actions" view
router.get('/my/queue', ssoMiddleware, onboardingController.renderRoleQueue);


router.get('/health', (req, res) => {
    res.json({ status: 'UP', timestamp: new Date() });
});



import { findUser, debugDumpAD, getAllUsers } from '../services/adService.js';
import * as hrmsController from '../controllers/hrmsController.js';

router.get('/ad-users', ssoMiddleware, async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 100;
        const users = await getAllUsers(limit);
        res.json({
            count: users.length,
            users: users,
            message: 'Use this to analyze AD data structure and available users'
        });
    } catch (error) {
        res.status(500).json({ error: error.message, stack: error.stack });
    }
});

router.get('/hrms/employee/:id', hrmsController.getEmployee);

router.get('/ad-debug/:username', async (req, res) => {
    try {
        const result = await findUser(req.params.username);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- Offboarding Routes ---
router.get('/offboarding/initiate', ssoMiddleware, offboardingController.initiate);
router.post('/offboarding/initiate', ssoMiddleware, offboardingController.initiate);
router.get('/offboarding/pending-manager', offboardingController.getPendingManager);
router.get('/offboarding/pending-system', offboardingController.getPendingSystem);
router.get('/offboarding/all', offboardingController.getAll);

// Token-based Handle Routes
router.get('/offboarding/handle', (req, res) => offboardingController.handleRequest(req, res));
router.post('/offboarding/handle', (req, res) => offboardingController.handleRequest(req, res));

export default router;

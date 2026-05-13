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
// GET /initiate renders the HR form openly (same pattern as /admin/hod-panel) —
// the page's JS resolves SSO identity client-side and pre-fills the form.
// POST /initiate IS gated by SSO so the requester identity must be authenticated
// at the moment of submission. The form's submit-handler attaches the sidecar
// token as a hidden field which ssoMiddleware reads (in addition to the header).
router.get('/onboarding/initiate', onboardingController.handleRequest);
router.post('/onboarding/initiate', ssoMiddleware, onboardingController.handleRequest);
// GET /handle stays open at Node so email-link clicks don't get blocked when
// the browser hasn't yet established an SSO context (Outlook → fresh browser
// session, etc.). The form renders with the action token; the form's JS
// hydrates the user's identity via /token.aspx + /api/auth/me, and runs a
// soft mismatch check client-side.
//
// POST /handle is the strict gate: ssoMiddleware extracts the sidecar token
// from the form body (which the submit-handler attached), populates req.user,
// and the controller compares req.user.email against the request's stored
// currentStageAssigneeEmail before any action is processed. A forwarded
// recipient can never submit, even if they reach the form.
router.get('/onboarding/handle', onboardingController.handleRequest);
router.post('/onboarding/handle', ssoMiddleware, onboardingController.handleRequest);

// Proof upload is performed by the DCI Implementer; the form attaches the
// sidecar token in the multipart body the same way the HR form does.
router.post('/onboarding/upload-proof', ssoMiddleware, upload.array('dciProof', 5), onboardingController.handleProofUpload);

// Lookup active onboarding request by employeeId (used by HR form JS)
router.get('/onboarding/lookup', onboardingController.lookupExistingRequest);

// History / status view for an existing onboarding request
router.get('/onboarding/history/:id', onboardingController.renderHistory);

// JSON details for a single request — used by the role-portal sidebar's
// history-row detail popup. SSO-gated.
router.get('/onboarding/:id/details', ssoMiddleware, onboardingController.getRequestDetails);

// Role-scoped queue: pending actions or full history for a given role (JSON)
// Requires SSO so a malicious caller can't enumerate every role's queue.
router.get('/onboarding/queue', ssoMiddleware, onboardingController.getRoleQueue);

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

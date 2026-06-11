import express from 'express';
import { uploadProofImages, uploadHostnameScreenshot } from '../utils/upload.js';
const router = express.Router();
import * as onboardingController from '../controllers/onboardingController.js';
import * as approvalController from '../controllers/approvalController.js';
import * as workflowTestController from '../controllers/workflowTestController.js';
import { ssoMiddleware } from '../middleware/ssoMiddleware.js';
import * as authController from '../controllers/authController.js';
import * as offboardingController from '../controllers/offboardingController.js';
import * as portalController from '../controllers/portalController.js';
import * as employeeJourneyController from '../controllers/employeeJourneyController.js';


router.post('/test/access-request', workflowTestController.createTestAccessRequest);


router.get('/test/request/:requestId/status', workflowTestController.getRequestStatus);


router.post('/test/approve/:token', workflowTestController.testApproveReject);


// Manually fire the escalation check — for testing the 5-min threshold.
// Remove or guard this before going to production.
router.post('/test/trigger-escalation', async (req, res) => {
    const { runEscalationCheck } = await import('../services/escalationService.js');
    try {
        const result = await runEscalationCheck();
        res.json({ ok: true, ...result });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});


router.all('/approvals/handle', approvalController.handleApprovalClick);


router.get('/auth/me', ssoMiddleware, authController.getCurrentUser);

// Portal sidecar-token authentication.
// IIS URL Rewrite inbound rules run before Windows Auth completes, so
// X-Auth-User / {LOGON_USER} is always empty on proxied requests.
// Portal pages use window.iflFetch to call this endpoint with the sidecar
// token (which does carry the Windows identity from token.aspx) instead.
router.get('/portal-auth/:roleSlug', ssoMiddleware, portalController.apiPortalAuth);

// GET /initiate stays OPEN at Node — gating it with ssoMiddleware causes an
// IIS Windows-auth login-prompt loop, because a fresh browser navigation
// carries no sidecar token (the token is attached client-side AFTER the page
// loads). The form renders open; its JS hydrates the SSO identity via
// /token.aspx + /api/auth/me and pre-fills the requester.
//
// POST /initiate IS the hard gate: ssoMiddleware reads the sidecar token the
// submit-handler attached, populates req.user, and the controller validates
// HR authorization (resolveHRGroupForEmail) before creating the request.
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
// IMPORTANT: multer (`upload.array`) MUST run before ssoMiddleware so the
// multipart body is parsed and `req.body['x-sidecar-token']` is visible.
// If ssoMiddleware runs first, req.body is empty for multipart requests and
// the sidecar token (which the form submits as a hidden field) can't be read,
// causing a 401 → IIS Windows-auth login-prompt loop.
router.post('/onboarding/upload-proof', uploadProofImages, ssoMiddleware, onboardingController.handleProofUpload);

// OPS desk-setup verification (multipart: hostname screenshot). Same multer →
// ssoMiddleware ordering rationale as /upload-proof above.
router.post('/onboarding/ops-verify', uploadHostnameScreenshot, ssoMiddleware, onboardingController.handleOPSVerify);

// Serve the Work Order PDF for the DCI Implementer. Open at Node (no ssoMiddleware)
// for the same reason as GET /handle — the page loads before the sidecar token is
// attached. The token itself acts as the gate: we only serve if the token is valid
// and the request is in PendingDCIImplementation status.
router.get('/onboarding/pdf/:token', onboardingController.serveWorkOrderPDF);

// Lookup active onboarding request by employeeId (used by HR form JS)
router.get('/onboarding/lookup', onboardingController.lookupExistingRequest);

// DCI form helpers — AD NT-name availability check + AD group type-ahead.
// Open at Node (like /hrms/employee) so the token-bearing DCI form JS can call
// them; they only expose AD account existence + group names (low sensitivity).
router.get('/onboarding/check-ntname', onboardingController.checkNtName);
// OPS Desk-Setup hostname cross-check — confirms the machine exists in AD.
router.get('/onboarding/check-hostname', onboardingController.checkHostname);
router.get('/onboarding/ad-groups', onboardingController.searchGroups);

// HR location group for the signed-in user — used by the initiate form to
// hydrate the Location Group field client-side after SSO auth completes.
router.get('/onboarding/my-hr-location', ssoMiddleware, onboardingController.getMyHRLocation);

// History / status view for an existing onboarding request
router.get('/onboarding/history/:id', onboardingController.renderHistory);

// JSON details for a single request — used by the role-portal sidebar's
// history-row detail popup. SSO-gated.
router.get('/onboarding/:id/details', ssoMiddleware, onboardingController.getRequestDetails);

// /onboarding/queue and /my/queue removed — role-based portal (/portal/:slug/view)
// is the single source of truth for pending and history.

// ── Employee Journey Tracking (Phase 3) ──────────────────────────────────
// Employee-centric journey visualization APIs.
// All routes are SSO-protected since they expose employee data.

// List all employees with search/filter
router.get('/employees', ssoMiddleware, employeeJourneyController.listEmployees);

// Get employee detail with journey summary
router.get('/employees/:employeeNumber', ssoMiddleware, employeeJourneyController.getEmployeeDetail);

// Get employee journey data formatted for D3.js visualization
router.get('/employees/:employeeNumber/journey-graph', ssoMiddleware, employeeJourneyController.getEmployeeJourneyGraph);

// Get related requests (parent, children, dependencies)
router.get('/requests/:requestId/related', ssoMiddleware, employeeJourneyController.getRelatedRequests);

// Get detailed timeline/stage events for a request
router.get('/requests/:requestId/timeline', ssoMiddleware, employeeJourneyController.getRequestTimeline);


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
// GET /initiate stays OPEN at Node — gating the page-load route with
// ssoMiddleware re-introduces the IIS Windows-auth prompt loop (rewrite
// happens before auth, so req.user is absent on fresh navigation). The page
// renders open; the page's client JS hydrates SSO. POST /initiate is the
// hard gate — ssoMiddleware reads the sidecar token from the body, the
// controller then verifies the submitter is on the HR or IT Ops list.
router.get('/offboarding/initiate', offboardingController.initiate);
router.post('/offboarding/initiate', ssoMiddleware, offboardingController.initiate);
router.get('/offboarding/pending-manager', offboardingController.getPendingManager);
router.get('/offboarding/pending-system', offboardingController.getPendingSystem);
router.get('/offboarding/all', offboardingController.getAll);

// Role-scoped portal queue for offboarding — mirrors /onboarding/queue.
// SSO-gated so a malicious caller can't enumerate every role's queue.
router.get('/offboarding/queue', ssoMiddleware, offboardingController.getRoleQueue);

// Per-request offboarding history / status view (open — used from email links,
// dashboards, and the admin panel). Mirrors /api/onboarding/history/:id.
router.get('/offboarding/history/:id', offboardingController.renderHistory);

// Live AD account snapshot for the employee on an offboarding request — powers
// the "Active Directory Account" panel on the DCI Manager / Implementer form so
// reviewers see the real AD account + groups deletion will remove, not just the
// DB privilege snapshot. SSO-gated; scoped by request id inside the controller.
router.get('/offboarding/:id/ad-profile', ssoMiddleware, offboardingController.getEmployeeAdProfile);

// Serve the revocation Work Order PDF (generated at DCI Manager approval) to the
// DCI Implementer. Open like onboarding's /onboarding/pdf/:token — validated by
// the live stage token inside the controller.
router.get('/offboarding/pdf/:token', offboardingController.serveRevocationPDF);

// Quick employee-state lookup for the initiate form's "Get Employee Data"
// flow. Returns { state: 'active' | 'completed' | null } so the form can
// warn the user before submitting a duplicate.
router.get('/offboarding/lookup', offboardingController.lookupExistingRequest);

// Token-based Handle Routes.
// GET stays open (email-link click pattern). POST is SSO-gated for the
// forwarded-email guard inside the controller.
// IMPORTANT: multer runs BEFORE ssoMiddleware on POST so multipart bodies
// (DCI Implementer's optional proof upload) are parsed and the sidecar
// token in the body becomes visible — same gotcha as onboarding upload-proof.
router.get('/offboarding/handle', (req, res) => offboardingController.handleRequest(req, res));
router.post('/offboarding/handle', uploadProofImages, ssoMiddleware, (req, res) => offboardingController.handleRequest(req, res));

export default router;

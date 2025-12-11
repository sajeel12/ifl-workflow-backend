import express from 'express';
const router = express.Router();
import * as onboardingController from '../controllers/onboardingController.js';
import * as approvalController from '../controllers/approvalController.js';
import { ssoMiddleware } from '../middleware/ssoMiddleware.js';

// Public / Hybrid Route (Token Protected, no SSO required for Outlook)
// Supports /api/approvals/handle via POST (Actionable Message) or GET (Link)
router.all('/approvals/handle', approvalController.handleApprovalClick);

// Protected Routes (Require SSO)
router.post('/onboarding/start', ssoMiddleware, onboardingController.createAccessRequest);

// Health Check
router.get('/health', (req, res) => {
    res.json({ status: 'UP', timestamp: new Date() });
});

// Debug Route for AD
import { findUser, debugDumpAD } from '../services/adService.js';
router.get('/ad-debug/:username', async (req, res) => {
    try {
        const result = await findUser(req.params.username);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

export default router;

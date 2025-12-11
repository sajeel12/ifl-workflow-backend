import express from 'express';
const router = express.Router();
import * as onboardingController from '../controllers/onboardingController.js';
import * as approvalController from '../controllers/approvalController.js';
import ssoMiddleware from '../middleware/ssoMiddleware.js';

// Public / Hybrid Route (Token Protected, no SSO required for Outlook)
// Supports /api/approvals/handle via POST (Actionable Message) or GET (Link)
router.all('/approvals/handle', approvalController.handleApproval);

// Protected Routes (Require SSO)
router.post('/onboarding/start', ssoMiddleware, onboardingController.startOnboarding);

// Health Check
router.get('/health', (req, res) => {
    res.json({ status: 'UP', timestamp: new Date() });
});

// Debug Route for AD
import adService from '../services/adService.js';
router.get('/ad-debug/:username', async (req, res) => {
    try {
        const result = await adService.debugUser(req.params.username);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

export default router;

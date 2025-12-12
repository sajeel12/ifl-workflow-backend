import express from 'express';
const router = express.Router();
import * as onboardingController from '../controllers/onboardingController.js';
import * as approvalController from '../controllers/approvalController.js';
import { ssoMiddleware } from '../middleware/ssoMiddleware.js';
import * as authController from '../controllers/authController.js';

// Public / Hybrid Route (Token Protected, no SSO required for Outlook)
// Supports /api/approvals/handle via POST (Actionable Message) or GET (Link)
router.all('/approvals/handle', approvalController.handleApprovalClick);

// Protected Routes (Require SSO)
router.get('/auth/me', ssoMiddleware, authController.getCurrentUser);
router.post('/onboarding/start', ssoMiddleware, onboardingController.createAccessRequest);

// Health Check
router.get('/health', (req, res) => {
    res.json({ status: 'UP', timestamp: new Date() });
});

// Debug Routes for AD
import { findUser, debugDumpAD, getAllUsers } from '../services/adService.js';

// Get all AD users (for testing and analyzing data structure)
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

// Get specific user by username
router.get('/ad-debug/:username', async (req, res) => {
    try {
        const result = await findUser(req.params.username);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

export default router;

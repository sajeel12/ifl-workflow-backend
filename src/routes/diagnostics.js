/**
 * Diagnostics Routes
 *
 * SSO Authentication diagnostic endpoints
 * These routes help identify which layer of authentication is failing
 */

import express from 'express';
import * as diagnosticsController from '../controllers/diagnosticsController.js';

const router = express.Router();

/**
 * GET /diagnostics/auth-ui
 * Render the diagnostic UI page
 */
router.get('/auth-ui', diagnosticsController.renderDiagnosticUI);

/**
 * GET /diagnostics/auth
 * API endpoint that tests all authentication layers
 * Returns JSON with detailed status of each layer
 */
router.get('/auth', diagnosticsController.testAuthLayers);

export default router;

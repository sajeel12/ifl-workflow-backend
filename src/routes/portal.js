import express from 'express';
import * as portalController from '../controllers/portalController.js';

const router = express.Router();

// GET  /portal/:roleSlug                    — login page (email entry)
// POST /portal/:roleSlug                    — request access link via email
// GET  /portal/:roleSlug/enter?action=TOKEN — auto-auth from email action link
// GET  /portal/:roleSlug/view?token=        — dashboard (portal session token)

router.get('/:roleSlug/enter',  portalController.enterViaActionToken);
router.get('/:roleSlug/view',   portalController.showDashboard);
router.get('/:roleSlug',        portalController.showLogin);
router.post('/:roleSlug',       portalController.requestAccess);

export default router;

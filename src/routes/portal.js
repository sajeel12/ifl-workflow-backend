import express from 'express';
import * as portalController from '../controllers/portalController.js';

const router = express.Router();

// GET  /portal/:roleSlug          — login page (email entry)
// POST /portal/:roleSlug          — request access link
// GET  /portal/:roleSlug/view     — dashboard (requires ?token=)

router.get('/:roleSlug',        portalController.showLogin);
router.post('/:roleSlug',       portalController.requestAccess);
router.get('/:roleSlug/view',   portalController.showDashboard);

export default router;

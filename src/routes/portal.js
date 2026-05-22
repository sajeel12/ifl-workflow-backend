import express from 'express';
import * as portalController from '../controllers/portalController.js';

const router = express.Router();

// GET /portal/:roleSlug                    — auto-login via Windows Auth (IIS X-Auth-User header)
// GET /portal/:roleSlug/enter?action=TOKEN — entry from email link; action token + Windows Auth
// GET /portal/:roleSlug/view?token=SESSION — dashboard; portal session token is the auth credential
//
// No ssoMiddleware on any route — it is not needed (Windows Auth identity comes from the IIS
// X-Auth-User header read directly in the controller) and would cause IIS challenge-loop issues.
// No POST route — the old email-entry form is replaced by automatic Windows Auth resolution.

router.get('/:roleSlug/enter', portalController.enterViaActionToken);
router.get('/:roleSlug/view',  portalController.showDashboard);
router.get('/:roleSlug',       portalController.showLogin);

export default router;

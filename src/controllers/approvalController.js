import workflowService from '../services/workflowService.js';
import logger from '../utils/logger.js';

export const handleApproval = async (req, res) => {
    // Supports both GET (Link click) and POST (Adaptive Card Action.Http)
    let { token, action } = req.query;
    const bodyAction = req.body.action;

    // Prefer Body action if present (POST), else Query param (GET)
    const finalAction = bodyAction || action;
    const tokenToUse = token || req.body.token; // Sometimes token isn't in query in POST if not configured

    if (!tokenToUse || !finalAction) {
        return res.status(400).send('Missing token or action');
    }

    try {
        const result = await workflowService.handleApprovalAction(tokenToUse, finalAction, "Via Email");

        // Response Strategy:
        // If POST (Adaptive Card), return JSON to update card
        // If GET (Browser Link), return simple HTML page
        if (req.method === 'POST') {
            // Return Adaptive Card update
            res.set('CARD-UPDATE-IN-BODY', 'true'); // Sometimes required by O365
            return res.json({
                type: 'AdaptiveCard',
                body: [
                    {
                        type: 'TextBlock',
                        text: `Identify Confirmed: Request ${finalAction}`,
                        weight: 'Bolder',
                        color: finalAction === 'Approved' ? 'Good' : 'Attention'
                    }
                ]
            });
        } else {
            // Simple HTML for browser
            res.send(`<h1>Request ${finalAction}</h1><p>You can close this window.</p>`);
        }

    } catch (error) {
        logger.error('Approval Controller Error', error);
        res.status(500).send('Proceesing failed');
    }
};

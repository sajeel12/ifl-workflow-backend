import * as workflowService from '../services/workflowService.js';

/**
 * Handles clicks from Email (GET for links, POST for Adaptive Cards)
 */
export const handleApprovalClick = async (req, res) => {
    try {
        // Support both Query (Link) and Body (Adaptive Card)
        const token = req.query.token || req.body.token;
        const action = req.query.action || req.body.action; // 'Approve' or 'Reject'
        const comment = req.body.comment || '';

        if (!token || !action) {
            return res.status(400).send('Missing token or action');
        }

        const result = await workflowService.handleApprovalAction(token, action, comment);

        if (req.method === 'POST') {
            // Adaptive Card expects a specific JSON response to update the card in-place
            res.set('CARD-UPDATE-IN-BODY', 'true'); // Hint (not strict standard but helpful)
            res.json({
                "type": "AdaptiveCard",
                "body": [
                    { "type": "TextBlock", "text": result.message, "weight": "Bolder" }
                ]
            });
        } else {
            // GET Request (Browser Link) -> Show simple HTML page
            res.send(`<h1>${result.message}</h1><p>You may close this window.</p>`);
        }

    } catch (err) {
        res.status(500).send(`Error: ${err.message}`);
    }
};

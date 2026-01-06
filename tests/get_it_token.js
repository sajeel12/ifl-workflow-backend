import OnboardingRequest from '../src/models/OnboardingRequest.js';

// Ensure DB_DIALECT is set if it's not already in process.env
// But since we run this with `node`, we pass it in the command line or it defaults.
// The model already imports the sequelize instance which is connected.

const getToken = async () => {
    try {
        // Wait for connection? usually sequelize connects on first query or we can sync.

        const request = await OnboardingRequest.findOne({
            order: [['createdAt', 'DESC']]
        });

        if (request) {
            console.log(`Token: ${request.currentStageToken}`);
        } else {
            console.log('No request found');
        }
    } catch (error) {
        console.error('Error:', error);
    }
};

getToken();

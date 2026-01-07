import OnboardingRequest from '../src/models/OnboardingRequest.js';
import sequelize from '../src/config/database.js';

const getToken = async () => {
    try {
        await sequelize.authenticate();
        // Get the latest request
        const request = await OnboardingRequest.findOne({
            order: [['id', 'DESC']]
        });

        if (request) {
            console.log('REQUEST_ID:', request.id);
            console.log('STATUS:', request.status);
            console.log('TOKEN:', request.currentStageToken);
        } else {
            console.log('No request found.');
        }

    } catch (err) {
        console.error(err);
    }
};

getToken();

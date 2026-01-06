import OnboardingRequest from '../src/models/OnboardingRequest.js';

const checkStatus = async () => {
    try {
        const request = await OnboardingRequest.findOne({
            order: [['createdAt', 'DESC']]
        });

        if (request) {
            console.log(`Status: ${request.status}`);
            console.log(`Approval Status: ${request.approvalStatus}`);
            console.log(`Current Token: ${request.currentStageToken}`);
        } else {
            console.log('No request found');
        }
    } catch (error) {
        console.error('Error:', error);
    }
};

checkStatus();

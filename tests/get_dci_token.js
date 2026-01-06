import OnboardingRequest from '../src/models/OnboardingRequest.js';
import crypto from 'crypto';

const prepareDCI = async () => {
    try {
        const token = crypto.randomBytes(20).toString('hex');
        const request = await OnboardingRequest.create({
            employeeId: 'DCIUser',
            fullName: 'DCI Check User',
            department: 'IT',
            status: 'PendingDSI', // DSI/DCI stage
            currentStageToken: token,
            hrSubmittedAt: new Date(),
            itSubmittedAt: new Date(),
            hodApprovedAt: new Date()
        });
        console.log(`Token: ${token}`);
    } catch (error) {
        console.error('Error:', error);
    }
};

prepareDCI();

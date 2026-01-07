import OnboardingRequest from '../src/models/OnboardingRequest.js';
import crypto from 'crypto';
import sequelize from '../src/config/database.js';

// Mock DB connection since we are running standalone script
// Actually we need to connect to the valid DB.
// Since server uses sqlite memory or file, we must use the same instance or be careful.
// Standard `sequelize.sync` in server wipes it.
// So we should run this script AFTER server is up, but this script needs to connect to the SAME DB file.
// If DB_DIALECT=sqlite is used with default storage (memory or local file), we need to match it.
// `config/database.js` uses `process.env.DB_STORAGE || 'database.sqlite'`.

const preparePhase4 = async () => {
    try {
        await sequelize.authenticate();
        // Create Request
        const randomToken = crypto.randomBytes(16).toString('hex');
        const request = await OnboardingRequest.create({
            employeeId: 'PHASE4_TEST_' + Date.now(),
            fullName: 'Phase 4 User',
            department: 'IT',
            status: 'PendingDSIManager',
            intranetAccess: true,
            emailIncoming: false,
            emailOutgoing: false,
            currentStageToken: randomToken
        });

        console.log('Request Created with Token: ' + randomToken);
        console.log('ID:', request.id);

        // We will manually call the service method? 
        // Or just use the token to hit the endpoint?
        // Let's print the token so I can use the browser to approve as DCI Manager.
        // It's safer to test the transition logic.

    } catch (err) {
        console.error(err);
    }
};

preparePhase4();

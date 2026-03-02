import 'dotenv/config';
import oracleSyncService from '../src/services/oracleSyncService.js';
import sequelize from '../src/config/database.js';
import logger from '../src/utils/logger.js';

async function testSync() {
    console.log('--- Starting Oracle Sync Manual Test ---');

    try {
        // Ensure DB is ready
        await sequelize.authenticate();
        console.log('✅ Local Database Connected.');

        console.log('Attempting to run Sync...');
        const result = await oracleSyncService.runSync('TEST_MANUAL');

        if (result.success) {
            console.log(`✅ Sync Completed Successfully!`);
            console.log(`📊 Records Processed: ${result.processed}`);
        } else {
            console.error(`❌ Sync Failed: ${result.error}`);
            console.log('Note: If this is a connection error, verify your VPN/Network and ORACLE_ environment variables.');
        }

    } catch (err) {
        console.error('Unexpected Test Error:', err);
    } finally {
        // Close DB connection so script can exit
        await sequelize.close();
        console.log('--- Test Finished ---');
        process.exit(0);
    }
}

testSync();

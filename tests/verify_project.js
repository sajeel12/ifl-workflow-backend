import sequelize from '../src/config/database.js';
import logger from '../src/utils/logger.js';
import { findUser } from '../src/services/adService.js';

async function verify() {
    logger.info('--- Verifying Project Setup ---');

    try {
        await sequelize.authenticate();
        logger.info('[PASS] Database Connection');
    } catch (err) {
        logger.error(`[FAIL] Database Connection: ${err.message}`);
    }

    try {
        if (process.env.AD_URL && !process.env.AD_URL.includes('your-domain')) {
            const user = await findUser('administrator'); // common user
            logger.info(`[PASS] AD Connection (Found: ${user ? 'Yes' : 'No'})`);
        } else {
            logger.warn('[SKIP] AD Config invalid, skipping AD test');
        }
    } catch (err) {
        logger.error(`[FAIL] AD Connection: ${err.message}`);
    }

    process.exit(0);
}

verify();

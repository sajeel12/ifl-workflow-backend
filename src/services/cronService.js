import cron from 'node-cron';
import oracleSyncService from './oracleSyncService.js';
import logger from '../utils/logger.js';

class CronService {
    constructor() {
        this.tasks = {};
    }

    // Default: Run every night at 2:00 AM
    scheduleHrmsSync(cronExpr = '0 2 * * *') {
        if (this.tasks['hrmsSync']) {
            this.tasks['hrmsSync'].stop();
        }

        logger.info(`[CronService] Scheduling HRMS Sync with expression: ${cronExpr}`);
        const task = cron.schedule(cronExpr, async () => {
            logger.info(`[CronService] Triggering Scheduled HRMS Sync...`);
            await oracleSyncService.runSync('SCHEDULED');
        }, {
            scheduled: true,
            timezone: "Asia/Karachi" // Default to Pakistan time, change if needed
        });

        this.tasks['hrmsSync'] = task;
        return task;
    }

    stopHrmsSync() {
        if (this.tasks['hrmsSync']) {
            this.tasks['hrmsSync'].stop();
            logger.info(`[CronService] HRMS Sync schedule stopped.`);
            return true;
        }
        return false;
    }
}

export default new CronService();

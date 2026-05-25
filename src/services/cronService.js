import cron from 'node-cron';
import oracleSyncService from './oracleSyncService.js';
import { runEscalationCheck } from './escalationService.js';
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
            timezone: "Asia/Karachi"
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

    // Check every 2 hours for requests where the primary approver has not acted
    // within 48 hours and automatically escalate them to the configured secondary.
    // Running every 2h means the worst-case delay beyond the 48h deadline is 2h —
    // acceptable for accountability purposes.
    scheduleEscalationCheck(cronExpr = '0 */2 * * *') {
        if (this.tasks['escalation']) {
            this.tasks['escalation'].stop();
        }

        logger.info(`[CronService] Scheduling 48h escalation check with expression: ${cronExpr}`);
        const task = cron.schedule(cronExpr, async () => {
            logger.info(`[CronService] Triggering 48h escalation check...`);
            try {
                const result = await runEscalationCheck();
                logger.info(`[CronService] Escalation check complete — checked: ${result.checked}, escalated: ${result.escalated}`);
            } catch (err) {
                logger.error(`[CronService] Escalation check failed: ${err.message}`);
            }
        }, {
            scheduled: true,
            timezone: "Asia/Karachi"
        });

        this.tasks['escalation'] = task;
        return task;
    }

    stopEscalationCheck() {
        if (this.tasks['escalation']) {
            this.tasks['escalation'].stop();
            logger.info(`[CronService] Escalation check schedule stopped.');`);
            return true;
        }
        return false;
    }
}

export default new CronService();

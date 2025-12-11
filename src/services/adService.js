import { Client } from 'ldapjs-promise';
import logger from '../utils/logger.js';
import dotenv from 'dotenv';
dotenv.config();

class ADService {
    constructor() {
        // Configuration loaded lazily to ensure environment is ready
    }

    _getConfig() {
        const config = {
            url: process.env.AD_URL,
            baseDN: process.env.AD_BASE_DN,
            user: process.env.AD_USER,
            pass: process.env.AD_PASSWORD
        };

        if (!config.url || !config.user || !config.pass) {
            const missing = Object.keys(config).filter(k => !config[k]).join(', ');
            throw new Error(`Missing AD Configuration: ${missing}. Check your .env file.`);
        }
        return config;
    }

    async _getClient() {
        const config = this._getConfig();
        const client = new Client({ url: config.url });

        try {
            await client.bind(config.user, config.pass);
            logger.info('LDAP Bind Successful');
            return client;
        } catch (err) {
            logger.error('LDAP Bind Failed', err);
            throw err;
        }
    }

    async findUser(username) {
        // username format: DOMAIN\user or user@domain.com
        // We strip domain for sAMAccountName search usually
        const sAMAccountName = username.split('\\').pop().split('@')[0];

        const config = this._getConfig();
        const client = await this._getClient();
        const opts = {
            filter: `(&(objectClass=user)(sAMAccountName=${sAMAccountName}))`,
            scope: 'sub',
            attributes: ['cn', 'mail', 'manager', 'department', 'title']
        };

        try {
            const results = await client.search(config.baseDN, opts);

            // Debug Log
            if (process.env.NODE_ENV === 'development') {
                logger.debug(`LDAP Search Results for ${sAMAccountName}: ${JSON.stringify(results)}`);
            }

            if (!results || results.length === 0) return null;

            const entry = results[0];
            if (!entry) return null;

            // Safe access using optional chaining or '||'
            return {
                name: entry.cn || entry.name || sAMAccountName,  // Fallback
                email: entry.mail || entry.userPrincipalName,
                managerDn: entry.manager,
                department: entry.department,
                title: entry.title
            };
        } catch (err) {
            logger.error('LDAP Search Failed', err);
            return null;
        } finally {
            await client.unbind();
        }
    }

    async validateManager(managerEmail) {
        try {
            const user = await this.findUser(managerEmail);
            return !!user;
        } catch (err) {
            logger.error('Error validating manager', err);
            return false;
        }
    }
}

export default new ADService();

import { Client } from 'ldapjs-promise';
import logger from '../utils/logger.js';
import dotenv from 'dotenv';
dotenv.config();

class ADService {
    constructor() {
        this.config = {
            url: process.env.AD_URL,
            baseDN: process.env.AD_BASE_DN,
            user: process.env.AD_USER,
            pass: process.env.AD_PASSWORD
        };
    }

    async _getClient() {
        const client = new Client({ url: this.config.url });
        // In a real scenario, you bind with a service account
        try {
            await client.bind(this.config.user, this.config.pass);
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

        const client = await this._getClient();
        const opts = {
            filter: `(&(objectClass=user)(sAMAccountName=${sAMAccountName}))`,
            scope: 'sub',
            attributes: ['cn', 'mail', 'manager', 'department', 'title']
        };

        try {
            const results = await client.search(this.config.baseDN, opts);
            // Results are typically an array of entries
            if (results.length === 0) return null;

            const entry = results[0];
            return {
                name: entry.cn,
                email: entry.mail,
                managerDn: entry.manager, // Returns DN, usually need another fetch to get manager email
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
        // TODO: Implement logic to check if manager exists by email
        return true;
    }
}

export default new ADService();

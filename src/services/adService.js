import { Client } from 'ldapjs-promise';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

dotenv.config();

// Configuration from .env
const adConfig = {
    url: process.env.AD_URL, // e.g., 'ldap://192.168.1.5'
    bindDN: process.env.AD_USER, // e.g., 'CN=Service Account,CN=Users,DC=example,DC=com'
    bindCredentials: process.env.AD_PASSWORD,
    searchBase: process.env.AD_BASE_DN, // e.g., 'DC=example,DC=com'
    domain: process.env.AD_DOMAIN // e.g., 'example.com'
};

/**
 * Constructs proper bind DN from username
 */
function getBindDN(user, baseDN, domain) {
    // If already a full DN (contains CN=), use as-is
    if (user.includes('CN=') || user.includes('cn=')) {
        return user;
    }

    // If it's a UPN format (user@domain.com), use as-is
    if (user.includes('@')) {
        return user;
    }

    // Try UPN format first (more modern)
    if (domain) {
        return `${user}@${domain}`;
    }

    // Fallback: construct full DN
    // Assumes user is in CN=Users container
    return `CN=${user},CN=Users,${baseDN}`;
}

/**
 * Creates and binds an LDAP client
 */
async function getAdClient() {
    console.log('[AD Service] Initialization...');
    console.log(`[AD Service] URL: ${adConfig.url}`);
    console.log(`[AD Service] Original User: ${adConfig.bindDN}`);
    console.log(`[AD Service] Search Base: ${adConfig.searchBase}`);
    console.log(`[AD Service] Domain: ${adConfig.domain}`);

    // Construct proper bind DN
    const bindDN = getBindDN(adConfig.bindDN, adConfig.searchBase, adConfig.domain);
    console.log(`[AD Service] Computed Bind DN: ${bindDN}`);

    const client = new Client({ url: adConfig.url });

    try {
        await client.bind(bindDN, adConfig.bindCredentials);
        console.log('[AD Service] Bind successful.');
        return client;
    } catch (err) {
        console.error('[AD Service] Bind failed:', err.message);
        console.error('[AD Service] Tried binding with:', bindDN);
        throw err;
    }
}

/**
 * Find a user by their sAMAccountName or Email
 * @param {string} query - content to search for (username or email)
 */
export async function findUser(query) {
    const client = await getAdClient();

    // Construct filter: checks sAMAccountName OR mail
    // Using wildcard to be more permissive in debug
    const filter = `(&(objectClass=user)(objectCategory=person)(|(sAMAccountName=${query})(mail=${query})))`;

    const opts = {
        filter: filter,
        scope: 'sub',
        attributes: ['sAMAccountName', 'displayName', 'mail', 'manager', 'department', 'title', 'memberOf']
    };

    console.log(`[AD Service] Searching with filter: ${filter}`);

    try {
        const response = await client.search(adConfig.searchBase, opts);

        // Handle different response formats from ldapjs-promise
        let entries = [];
        if (Array.isArray(response)) {
            entries = response;
        } else if (response && response.entries) {
            entries = response.entries;
        } else if (response && response.searchEntries) {
            entries = response.searchEntries;
        }

        console.log(`[AD Service] Search returned ${entries.length} results.`);
        console.log('[AD Service] Response structure:', Object.keys(response || {}));

        if (entries.length > 0) {
            console.log('[AD Service] First match raw data:', JSON.stringify(entries[0], null, 2));
            return entries[0];
        }
        return null;
    } catch (err) {
        console.error('[AD Service] Search error:', err);
        throw err;
    } finally {
        await client.unbind();
    }
}

/**
 * Get all users from AD (for API endpoint)
 * Returns array of user objects
 */
export async function getAllUsers(limit = 100) {
    console.log('[AD Service] ===== Fetching all users =====');
    console.log(`[AD Service] Search Base: ${adConfig.searchBase}`);
    console.log(`[AD Service] URL: ${adConfig.url}`);
    console.log(`[AD Service] Bind DN: ${adConfig.bindDN}`);

    const client = await getAdClient();

    const opts = {
        filter: '(&(objectClass=user)(objectCategory=person))',
        scope: 'sub',
        sizeLimit: limit,
        attributes: ['sAMAccountName', 'displayName', 'mail', 'manager', 'department', 'title', 'memberOf', 'dn']
    };

    console.log(`[AD Service] Filter: ${opts.filter}`);
    console.log(`[AD Service] Scope: ${opts.scope}`);
    console.log(`[AD Service] Size Limit: ${opts.sizeLimit}`);

    try {
        const response = await client.search(adConfig.searchBase, opts);

        console.log(`[AD Service] Response type: ${typeof response}`);
        console.log(`[AD Service] Response is array: ${Array.isArray(response)}`);
        console.log(`[AD Service] Response keys:`, response ? Object.keys(response) : 'null');
        console.log(`[AD Service] Raw response:`, JSON.stringify(response, null, 2));

        // Handle different response formats
        let entries = [];
        if (Array.isArray(response)) {
            entries = response;
        } else if (response && response.entries) {
            entries = response.entries;
        } else if (response && response.searchEntries) {
            entries = response.searchEntries;
        }

        console.log(`[AD Service] Found ${entries.length} users`);
        if (entries.length > 0) {
            console.log(`[AD Service] First user sample:`, JSON.stringify(entries[0], null, 2));
        }
        return entries;
    } catch (err) {
        console.error('[AD Service] Error fetching users:', err);
        console.error('[AD Service] Error stack:', err.stack);
        throw err;
    } finally {
        await client.unbind();
    }
}

/**
 * DEBUG: Dumps the first 100 users found in the base DN.
 * Use this to verify what data we are actually getting.
 */
export async function debugDumpAD() {
    console.log('\n=== STARTING AD DEBUG DUMP ===');
    const client = await getAdClient();

    const opts = {
        filter: '(&(objectClass=user)(objectCategory=person))',
        scope: 'sub',
        sizeLimit: 100, // Limit to prevent flooding
        attributes: ['sAMAccountName', 'displayName', 'mail', 'manager', 'department']
    };

    console.log(`[AD Debug] Search Base: ${adConfig.searchBase}`);
    console.log(`[AD Debug] Filter: ${opts.filter}`);
    console.log('[AD Debug] Fetching up to 100 users...');

    try {
        const response = await client.search(adConfig.searchBase, opts);

        // Handle different response formats
        let entries = [];
        if (Array.isArray(response)) {
            entries = response;
        } else if (response && response.entries) {
            entries = response.entries;
        } else if (response && response.searchEntries) {
            entries = response.searchEntries;
        }

        console.log(`[AD Debug] Total Users Found: ${entries.length}`);
        console.log('[AD Debug] Response structure:', Object.keys(response || {}));

        entries.forEach((entry, index) => {
            console.log(`\n--- User #${index + 1} ---`);
            console.log(`DN: ${entry.dn}`);
            console.log(`Name: ${entry.displayName}`);
            console.log(`Email: ${entry.mail}`);
            console.log(`Account: ${entry.sAMAccountName}`);
            console.log(`Manager: ${entry.manager}`);
            // Unwrap extra attributes if they exist as raw buffers sometimes in ldapjs
            // console.log('Raw:', JSON.stringify(entry, null, 2)); 
        });

        console.log('\n=== END AD DEBUG DUMP ===');
    } catch (err) {
        console.error('[AD Debug] Setup failed:', err);
    } finally {
        await client.unbind();
    }
}

// Allow direct execution: `node src/services/adService.js`
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    debugDumpAD().catch(console.error);
}

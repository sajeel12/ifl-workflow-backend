import { Client } from 'ldapjs-promise';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

dotenv.config();

const adConfig = {
    url: process.env.AD_URL, // e.g., 'ldap://192.168.1.5'
    bindDN: process.env.AD_USER, // e.g., 'CN=Service Account,CN=Users,DC=example,DC=com'
    bindCredentials: process.env.AD_PASSWORD,
    searchBase: process.env.AD_BASE_DN, // e.g., 'DC=example,DC=com'
    domain: process.env.AD_DOMAIN // e.g., 'example.com'
};


function getBindDN(user, baseDN, domain) {
    if (user.includes('CN=') || user.includes('cn=')) {
        return user;
    }

    if (user.includes('@')) {
        return user;
    }

    if (domain) {
        return `${user}@${domain}`;
    }

    return `CN=${user},CN=Users,${baseDN}`;
}


async function getAdClient() {
    console.log('[AD Service] Initialization...');
    console.log(`[AD Service] URL: ${adConfig.url}`);
    console.log(`[AD Service] Original User: ${adConfig.bindDN}`);
    console.log(`[AD Service] Search Base: ${adConfig.searchBase}`);
    console.log(`[AD Service] Domain: ${adConfig.domain}`);

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


export async function findUser(query) {
    const client = await getAdClient();

    const filter = `(&(objectClass=user)(objectCategory=person)(|(sAMAccountName=${query})(mail=${query})))`;

    const opts = {
        filter: filter,
        scope: 'sub',
        attributes: ['sAMAccountName', 'displayName', 'mail', 'manager', 'department', 'title', 'memberOf']
    };

    console.log(`[AD Service] Searching with filter: ${filter}`);

    return new Promise((resolve, reject) => {
        const entries = [];

        client.search(adConfig.searchBase, opts)
            .then(res => {
                res.on('searchEntry', (entry) => {
                    let userData = entry.pojo || entry.object;
                    if (!userData && entry.attributes) {
                        userData = {};
                        entry.attributes.forEach(attr => {
                            userData[attr.type] = attr.values.length === 1 ? attr.values[0] : attr.values;
                        });
                    }
                    entries.push(userData || entry);
                });

                res.on('error', (err) => {
                    console.error('[AD Service] Search error:', err);
                    client.unbind().catch(console.error);
                    reject(err);
                });

                res.on('end', (result) => {
                    console.log(`[AD Service] Search returned ${entries.length} results.`);

                    if (entries.length > 0) {
                        console.log('[AD Service] First match raw data:', JSON.stringify(entries[0], null, 2));
                        client.unbind()
                            .then(() => resolve(entries[0]))
                            .catch(() => resolve(entries[0]));
                    } else {
                        client.unbind()
                            .then(() => resolve(null))
                            .catch(() => resolve(null));
                    }
                });
            })
            .catch(err => {
                console.error('[AD Service] Search error:', err);
                client.unbind().catch(console.error);
                reject(err);
            });
    });
}


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

    return new Promise((resolve, reject) => {
        const entries = [];

        client.search(adConfig.searchBase, opts)
            .then(res => {
                console.log('[AD Service] Search initiated, waiting for entries...');

                res.on('searchEntry', (entry) => {
                    console.log('[AD Service] Received search entry');
                    console.log('[AD Service] Entry keys:', Object.keys(entry));
                    console.log('[AD Service] Entry type:', typeof entry);

                    let userData = null;
                    if (entry.pojo) {
                        userData = entry.pojo;
                        console.log('[AD Service] Using entry.pojo');
                    } else if (entry.object) {
                        userData = entry.object;
                        console.log('[AD Service] Using entry.object');
                    } else if (entry.attributes) {
                        userData = {};
                        entry.attributes.forEach(attr => {
                            userData[attr.type] = attr.values.length === 1 ? attr.values[0] : attr.values;
                        });
                        console.log('[AD Service] Constructed from attributes');
                    } else {
                        userData = entry;
                        console.log('[AD Service] Using raw entry');
                    }

                    entries.push(userData);
                });

                res.on('error', (err) => {
                    console.error('[AD Service] Search error:', err);
                    client.unbind().catch(console.error);
                    reject(err);
                });

                res.on('end', (result) => {
                    console.log(`[AD Service] Search completed. Status: ${result?.status}`);
                    console.log(`[AD Service] Found ${entries.length} users`);

                    if (entries.length > 0) {
                        console.log(`[AD Service] First user sample:`, JSON.stringify(entries[0], null, 2));
                    }

                    client.unbind()
                        .then(() => resolve(entries))
                        .catch(err => {
                            console.error('[AD Service] Unbind error:', err);
                            resolve(entries); // Still resolve with entries even if unbind fails
                        });
                });
            })
            .catch(err => {
                console.error('[AD Service] Search initiation failed:', err);
                client.unbind().catch(console.error);
                reject(err);
            });
    });
}


export async function getDepartmentHead(department) {
    console.log(`[AD Service] Looking up department head for: ${department}`);

    const client = await getAdClient();

    const filter = `(&(objectClass=user)(objectCategory=person)(department=${department})(|(title=*Head*)(title=*Director*)(title=*Manager*)))`;

    const opts = {
        filter: filter,
        scope: 'sub',
        attributes: ['sAMAccountName', 'displayName', 'mail', 'title', 'department']
    };

    console.log(`[AD Service] Department head search filter: ${filter}`);

    return new Promise((resolve, reject) => {
        const entries = [];

        client.search(adConfig.searchBase, opts)
            .then(res => {
                res.on('searchEntry', (entry) => {
                    let userData = entry.pojo || entry.object;
                    if (!userData && entry.attributes) {
                        userData = {};
                        entry.attributes.forEach(attr => {
                            userData[attr.type] = attr.values.length === 1 ? attr.values[0] : attr.values;
                        });
                    }
                    entries.push(userData || entry);
                });

                res.on('error', (err) => {
                    console.error('[AD Service] Department head search error:', err);
                    client.unbind().catch(console.error);
                    reject(err);
                });

                res.on('end', (result) => {
                    console.log(`[AD Service] Department head search returned ${entries.length} results`);

                    if (entries.length > 0) {
                        const head = entries.find(e => e.title?.includes('Head')) ||
                            entries.find(e => e.title?.includes('Director')) ||
                            entries[0];

                        const email = head.mail;
                        console.log(`[AD Service] Found department head: ${head.displayName} (${email})`);

                        client.unbind()
                            .then(() => resolve(email))
                            .catch(() => resolve(email));
                    } else {
                        console.warn(`[AD Service] No department head found for ${department}`);
                        const fallbackEmail = process.env.DEFAULT_DEPT_HEAD_EMAIL || 'dept-head@test.com';
                        console.log(`[AD Service] Using fallback email: ${fallbackEmail}`);

                        client.unbind()
                            .then(() => resolve(fallbackEmail))
                            .catch(() => resolve(fallbackEmail));
                    }
                });
            })
            .catch(err => {
                console.error('[AD Service] Department head search error:', err);
                client.unbind().catch(console.error);
                reject(err);
            });
    });
}


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
        });

        console.log('\n=== END AD DEBUG DUMP ===');
    } catch (err) {
        console.error('[AD Debug] Setup failed:', err);
    } finally {
        await client.unbind();
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    debugDumpAD().catch(console.error);
}

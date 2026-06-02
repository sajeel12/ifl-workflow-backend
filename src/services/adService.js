import crypto from 'crypto';
import logger from '../utils/logger.js';

// ── IIS sidecar lookup (adlookup.aspx) ────────────────────────────────────────
// Preferred path: the ASPX runs under IIS app-pool Windows identity, so it can
// query AD via System.DirectoryServices without explicit bind credentials.
// Node calls it over loopback — no NTLM handshake needed.
const ADLOOKUP_URL   = process.env.ADLOOKUP_URL  || '';
const ADSEARCH_URL   = process.env.ADSEARCH_URL  || '';
const SHARED_SECRET  = process.env.SSO_SHARED_SECRET || 'IFL_WORKFLOW_SECRET_KEY_2025';

function _hmacHex(data) {
    return crypto.createHmac('sha256', SHARED_SECRET).update(data).digest('hex');
}

async function _lookupViaSidecar(email) {
    if (!ADLOOKUP_URL) return null;
    try {
        const url = new URL(ADLOOKUP_URL);
        url.searchParams.set('email', email.toLowerCase());
        const res = await fetch(url.toString(), { signal: AbortSignal.timeout(5000) });
        if (!res.ok) { logger.warn(`[ADLookup] sidecar HTTP ${res.status}`); return null; }
        const d = await res.json();
        if (!d.found || !d.sAMAccountName) return null;
        const age      = Math.abs(Date.now() / 1000 - d.timestamp);
        const expected = _hmacHex(`${d.sAMAccountName}|${d.timestamp}|${d.mail}`);
        if (age > 30 || d.signature !== expected) {
            logger.warn(`[ADLookup] HMAC mismatch or stale response for ${email}`);
            return null;
        }
        logger.info(`[ADLookup] ${email} → ${d.sAMAccountName} (IIS sidecar)`);
        return { sAMAccountName: d.sAMAccountName, displayName: d.displayName, mail: d.mail };
    } catch (e) {
        logger.warn(`[ADLookup] sidecar error: ${e.message}`);
        return null;
    }
}

// Connect timeout for all LDAP clients. Keeps startup fast when a DC is
// unreachable (192.168.10.10 times out in 21 s without this).
const LDAP_CONNECT_TIMEOUT = parseInt(process.env.AD_CONNECT_TIMEOUT_MS || '4000', 10);
const LDAP_TIMEOUT         = parseInt(process.env.AD_TIMEOUT_MS         || '8000', 10);

const _ldapOpts = { connectTimeout: LDAP_CONNECT_TIMEOUT, timeout: LDAP_TIMEOUT };

// ── Primary domain (IBRAHIM1_NT / ifl.net, port 389) ──────────────────────────
const adConfig = {
    url:      process.env.AD_URL     || 'ldap://your-dc.ifl.local',
    baseDN:   process.env.AD_BASE_DN || 'dc=ifl,dc=local',
    username: process.env.AD_USER    || 'svc_account@ifl.local',
    password: process.env.AD_PASS    || 'password',
    ..._ldapOpts,
};

// ── Global Catalog (port 3268) ─────────────────────────────────────────────────
const _gcBase = (process.env.AD_URL || '').replace(/:389$/, '').replace(/\/$/, '');
const adGcConfig = {
    url:      process.env.AD_GC_URL  || (_gcBase ? `${_gcBase}:3268` : 'ldap://your-dc.ifl.local:3268'),
    baseDN:   'AD_GC_BASE_DN' in process.env ? process.env.AD_GC_BASE_DN : '',
    username: process.env.AD_USER    || 'svc_account@ifl.local',
    password: process.env.AD_PASS    || 'password',
    ..._ldapOpts,
};

// ── Extra per-domain DCs (child domains not reachable via primary/GC) ──────────
// Format (semicolon-separated):
//   ldap://IP|DC=base,DC=dn|bindUser@domain|bindPassword
// Each child domain must have its OWN bind credentials — cross-domain bind
// with the primary service account (administrator@ibrahim.com) returns 52e.
const _extraDomainConfigs = (() => {
    const raw = (process.env.AD_EXTRA_DOMAINS || '').trim();
    if (!raw) return [];
    return raw.split(';').map(entry => {
        const parts = entry.trim().split('|');
        const [url, baseDN, username, password] = parts;
        if (!url || !baseDN) return null;
        return {
            url:      url.trim(),
            baseDN:   baseDN.trim(),
            username: (username || process.env.AD_USER || '').trim(),
            password: (password || process.env.AD_PASS || '').trim(),
            ..._ldapOpts,
        };
    }).filter(Boolean);
})();

let ad      = null;  // primary domain client
let adGC    = null;  // global catalog client
let adExtra = [];    // per-child-domain clients

// Track last init errors for the diagnostic endpoint
const _initErrors = {};

(async () => {
    try {
        const { default: ActiveDirectory } = await import('activedirectory2');

        try {
            ad = new ActiveDirectory(adConfig);
            logger.info(`[ADService] Primary initialised: ${adConfig.url} baseDN=${adConfig.baseDN}`);
        } catch (e) {
            _initErrors.primary = e.message;
            logger.warn(`[ADService] Primary init failed: ${e.message}`);
        }

        try {
            adGC = new ActiveDirectory(adGcConfig);
            logger.info(`[ADService] GC initialised: ${adGcConfig.url} baseDN="${adGcConfig.baseDN || '(root)'}"`);
        } catch (e) {
            _initErrors.gc = e.message;
            logger.warn(`[ADService] GC init failed: ${e.message}`);
        }

        for (let i = 0; i < _extraDomainConfigs.length; i++) {
            try {
                adExtra.push(new ActiveDirectory(_extraDomainConfigs[i]));
                logger.info(`[ADService] Extra domain [${i}] initialised: ${_extraDomainConfigs[i].url}`);
            } catch (e) {
                _initErrors[`extra_${i}`] = e.message;
                logger.warn(`[ADService] Extra domain [${i}] init failed: ${e.message}`);
            }
        }
    } catch (err) {
        _initErrors.module = err.message;
        logger.warn(`[ADService] activedirectory2 module unavailable: ${err.message}`);
    }
})();

// ── Internal: findUser on a specific client, returns { user|null, error|null } ─
function _findOn(client, username, label) {
    return new Promise(resolve => {
        client.findUser(username, (err, user) => {
            if (err) {
                logger.warn(`[ADService] [${label}] lookup error for ${username}: ${err.message}`);
                resolve({ user: null, error: err.message });
            } else {
                resolve({ user: user || null, error: null });
            }
        });
    });
}

/**
 * Find a user in the PRIMARY domain only.
 * Returns null (never a fake) when not found or AD unavailable.
 */
export const findUser = async (username) => {
    if (!ad) return null;
    const { user } = await _findOn(ad, username, 'PRIMARY');
    return user;
};

/**
 * Search for a user across ALL configured sources IN PARALLEL.
 *
 * Running in parallel means one unreachable DC (timeout) does not block a
 * reachable one. Sources with the same hostname as a timed-out source are
 * skipped to avoid waiting twice (e.g. PRIMARY + GC both at 192.168.10.10).
 *
 * Returns the first result that has a mail attribute, or null.
 * NEVER fabricates an email.
 */
export const findUserAnywhere = async (username) => {
    // Deduplicate by hostname so we don't fire GC if PRIMARY is the same dead host.
    const _hostOf = url => { try { return new URL(url).hostname; } catch { return url; } };
    const seenHosts = new Set();
    const sources = [];

    const addSource = (client, label, url, baseDN) => {
        if (!client) return;
        const host = _hostOf(url);
        if (seenHosts.has(host)) {
            logger.debug(`[ADService] Skipping ${label} — same host as an already-queued source (${host})`);
            return;
        }
        seenHosts.add(host);
        sources.push({ client, label, url, baseDN });
    };

    addSource(ad,   'PRIMARY', adConfig.url,   adConfig.baseDN);
    addSource(adGC, 'GC',      adGcConfig.url, adGcConfig.baseDN || '(root)');
    adExtra.forEach((c, i) => addSource(c, `EXTRA_${i}`, _extraDomainConfigs[i].url, _extraDomainConfigs[i].baseDN));

    if (sources.length === 0) {
        logger.warn(`[ADService] No AD clients available — cannot resolve ${username}`);
        return null;
    }

    // Fire all (deduplicated) sources simultaneously.
    const results = await Promise.all(
        sources.map(s => _findOn(s.client, username, s.label).then(r => ({ ...s, ...r })))
    );

    // Prefer a result that has a mail attribute.
    const withMail = results.find(r => r.user && r.user.mail);
    if (withMail) {
        logger.info(`[ADService] ${username} resolved via ${withMail.label} — mail: ${withMail.user.mail}`);
        return withMail.user;
    }

    // Fall back to any found result (at least has the account, even without mail).
    const anyFound = results.find(r => r.user);
    if (anyFound) {
        logger.warn(`[ADService] ${username} found via ${anyFound.label} but no mail attribute`);
        return anyFound.user;
    }

    const summary = results.map(r => `${r.label}:${r.error || 'not found'}`).join(' | ');
    logger.warn(`[ADService] ${username} not found anywhere. ${summary}`);
    return null;
};

/**
 * Search for a user by their email address (mail attribute).
 *
 * Primary path: IIS sidecar (adlookup.aspx) — runs under the app-pool Windows
 * identity, so it queries AD via System.DirectoryServices with no explicit bind
 * credentials and no NTLM challenge from Node.
 *
 * Fallback: activedirectory2 direct LDAP — used when ADLOOKUP_URL is not set or
 * the sidecar is temporarily unreachable.
 */
export const findUserByEmail = async (email) => {
    if (!email) return null;

    // ── 1. IIS sidecar (preferred) ─────────────────────────────────────────────
    const sidecar = await _lookupViaSidecar(email);
    if (sidecar) return sidecar;

    // ── 2. Direct LDAP fallback ────────────────────────────────────────────────
    const filter = `(|(mail=${email})(userPrincipalName=${email}))`;
    const attrs  = ['sAMAccountName', 'displayName', 'mail', 'userPrincipalName'];

    const searchOn = (client, label) => new Promise(resolve => {
        try {
            client.findUsers({ filter, attributes: attrs }, false, (err, users) => {
                if (err) {
                    logger.debug(`[ADService] findUserByEmail(${email}) ${label}: ${err.message}`);
                    resolve(null);
                } else {
                    resolve(users && users.length ? { ...users[0], _source: label } : null);
                }
            });
        } catch (e) {
            logger.warn(`[ADService] findUserByEmail exception on ${label}: ${e.message}`);
            resolve(null);
        }
    });

    const sources = [
        ad   && { client: ad,   label: 'PRIMARY' },
        adGC && { client: adGC, label: 'GC' },
        ...adExtra.map((c, i) => ({ client: c, label: `EXTRA_${i}` })),
    ].filter(Boolean);

    if (!sources.length) {
        logger.warn(`[ADService] No AD clients — cannot search by email ${email}`);
        return null;
    }

    const results = await Promise.all(sources.map(({ client, label }) => searchOn(client, label)));
    const found = results.find(r => r && r.sAMAccountName);
    if (found) {
        logger.info(`[ADService] findUserByEmail(${email}) → sAMAccountName=${found.sAMAccountName} via ${found._source}`);
        return found;
    }
    logger.warn(`[ADService] findUserByEmail(${email}) not found in any AD source`);
    return null;
};

/**
 * Find an AD user by their employeeID attribute via the adsearch.aspx sidecar.
 * Uses the reliable ?employeeId= path — immune to name/email mismatches.
 * Returns the user object or null.
 */
export const findUserByEmployeeIdViaSidecar = async (employeeId) => {
    if (!employeeId || !ADSEARCH_URL) return null;
    try {
        const url = new URL(ADSEARCH_URL);
        url.searchParams.set('employeeId', String(employeeId));
        const res = await fetch(url.toString(), { signal: AbortSignal.timeout(6000) });
        if (!res.ok) { logger.warn(`[ADSearch] employeeId HTTP ${res.status}`); return null; }
        const data = await res.json();
        if (!Array.isArray(data.results) || data.results.length === 0) return null;
        const age      = Math.abs(Date.now() / 1000 - data.timestamp);
        const expected = _hmacHex(`search|${employeeId}|${data.timestamp}|${data.results.length}`);
        if (age > 30 || data.signature !== expected) {
            logger.warn(`[ADSearch] HMAC mismatch for employeeId "${employeeId}"`);
            return null;
        }
        logger.info(`[ADSearch] employeeId(${employeeId}) → ${data.results[0].sAMAccountName}`);
        return data.results[0];
    } catch (e) {
        logger.warn(`[ADSearch] employeeId sidecar error: ${e.message}`);
        return null;
    }
};

/**
 * Search AD users by name / sAMAccountName / email via the adsearch.aspx sidecar.
 * Returns an array of { sAMAccountName, displayName, email, title, employeeID } — empty on failure.
 */
export const searchUsersByName = async (q) => {
    if (!q || q.length < 2 || !ADSEARCH_URL) return [];
    try {
        const url = new URL(ADSEARCH_URL);
        url.searchParams.set('q', q);
        const res = await fetch(url.toString(), { signal: AbortSignal.timeout(6000) });
        if (!res.ok) { logger.warn(`[ADSearch] HTTP ${res.status}`); return []; }
        const data = await res.json();
        if (!Array.isArray(data.results)) return [];
        const age      = Math.abs(Date.now() / 1000 - data.timestamp);
        const expected = _hmacHex(`search|${q}|${data.timestamp}|${data.results.length}`);
        if (age > 30 || data.signature !== expected) {
            logger.warn(`[ADSearch] HMAC mismatch for query "${q}"`);
            return [];
        }
        return data.results;
    } catch (e) {
        logger.warn(`[ADSearch] sidecar error: ${e.message}`);
        return [];
    }
};

// ── Internal: search by arbitrary LDAP filter, returns first match ────────────────
function _searchByFilter(client, filter, attrs, label) {
    return new Promise(resolve => {
        try {
            client.findUsers({ filter, attributes: attrs }, false, (err, users) => {
                if (err) { logger.debug(`[ADService] [${label}] filter search error: ${err.message}`); resolve(null); }
                else      resolve(users && users.length ? users[0] : null);
            });
        } catch (e) {
            logger.warn(`[ADService] [${label}] filter search exception: ${e.message}`);
            resolve(null);
        }
    });
}

// Full set of attributes we want for the 360° employee profile
const FULL_PROFILE_ATTRS = [
    'sAMAccountName', 'displayName', 'cn', 'mail', 'userPrincipalName',
    'employeeID', 'department', 'title', 'description',
    'userAccountControl', 'memberOf',
    'whenCreated', 'lastLogonTimestamp', 'pwdLastSet',
    'telephoneNumber', 'mobile', 'physicalDeliveryOfficeName'
];

/**
 * Find an AD user by their employeeID attribute.
 * Uses direct LDAP (not the sidecar — sidecar only searches by name/email).
 * Returns a rich profile object or null.
 */
export const findUserByEmployeeId = async (employeeId) => {
    if (!employeeId) return null;
    const filter = `(employeeID=${employeeId})`;

    const sources = [
        ad   && { client: ad,   label: 'PRIMARY' },
        adGC && { client: adGC, label: 'GC' },
        ...adExtra.map((c, i) => ({ client: c, label: `EXTRA_${i}` })),
    ].filter(Boolean);

    if (!sources.length) { logger.warn(`[ADService] No AD clients — cannot search by employeeID`); return null; }

    for (const { client, label } of sources) {
        const user = await _searchByFilter(client, filter, FULL_PROFILE_ATTRS, label);
        if (user && user.sAMAccountName) {
            logger.info(`[ADService] findUserByEmployeeId(${employeeId}) → ${user.sAMAccountName} via ${label}`);
            return user;
        }
    }
    logger.warn(`[ADService] findUserByEmployeeId(${employeeId}) not found`);
    return null;
};

/**
 * Get the full AD profile for a known sAMAccountName.
 * Returns a rich object with account status, groups, timestamps — or null.
 */
export const getFullADProfile = async (sAMAccountName) => {
    if (!sAMAccountName) return null;
    const filter = `(sAMAccountName=${sAMAccountName})`;

    const sources = [
        ad   && { client: ad,   label: 'PRIMARY' },
        adGC && { client: adGC, label: 'GC' },
        ...adExtra.map((c, i) => ({ client: c, label: `EXTRA_${i}` })),
    ].filter(Boolean);

    for (const { client, label } of sources) {
        const user = await _searchByFilter(client, filter, FULL_PROFILE_ATTRS, label);
        if (user && user.sAMAccountName) return parseADProfile(user);
    }
    return null;
};

/**
 * Parse raw AD object into a clean profile for the UI.
 */
export function parseADProfile(raw) {
    if (!raw) return null;

    // accountEnabled: sidecar pre-computes this as a boolean; LDAP uses UAC bits
    let disabled;
    if (typeof raw.accountEnabled === 'boolean') {
        disabled = !raw.accountEnabled;
    } else {
        const uac = parseInt(raw.userAccountControl || '0', 10);
        disabled  = (uac & 2) !== 0;
    }

    // Groups: sidecar returns full DN strings; LDAP also returns DN strings
    // Extract friendly CN name from each DN
    const groups = []
        .concat(raw.memberOf || [])
        .map(dn => { const m = String(dn).match(/^CN=([^,]+)/i); return m ? m[1] : dn; })
        .filter(Boolean);

    // Windows FILETIME → JS Date (LDAP path only — sidecar returns ISO string for whenCreated)
    const ft2date = v => {
        const n = parseInt(v, 10);
        if (!n || n <= 0) return null;
        return new Date(Math.round(n / 10000) - 11644473600000);
    };

    // createdAt: sidecar returns ISO string; LDAP returns via whenCreated field
    const createdAt = raw.createdAt || (raw.whenCreated ? String(raw.whenCreated) : null) || null;

    return {
        sAMAccountName:  raw.sAMAccountName  || null,
        displayName:     raw.displayName     || null,
        // sidecar returns both 'mail' and 'email' keys; LDAP returns 'mail'
        mail:            raw.mail || raw.email || null,
        upn:             raw.userPrincipalName || null,
        employeeID:      raw.employeeID      || null,
        department:      raw.department      || null,
        title:           raw.title           || null,
        phone:           raw.telephoneNumber || raw.mobile || null,
        office:          raw.physicalDeliveryOfficeName || raw.office    || null,
        locality:        raw.l                          || raw.locality  || null,
        streetAddress:   raw.streetAddress             || null,
        accountEnabled:  !disabled,
        accountStatus:   disabled ? 'Disabled' : 'Enabled',
        groups,
        createdAt:       createdAt,
        lastLogon:       ft2date(raw.lastLogonTimestamp),
        pwdLastSet:      ft2date(raw.pwdLastSet),
    };
}

// ── Expose raw attempt details for the diagnostic endpoint ─────────────────────
export const diagnoseLookup = async (username) => {
    const results = [];

    const run = async (client, label, url, baseDN) => {
        if (!client) { results.push({ source: label, url, skipped: true, reason: 'client not initialised' }); return; }
        const start = Date.now();
        const { user, error } = await _findOn(client, username, label);
        results.push({
            source:      label,
            url,
            baseDN:      baseDN || '(root)',
            durationMs:  Date.now() - start,
            found:        !!user,
            mail:         user?.mail         || null,
            displayName:  user?.displayName  || null,
            upn:          user?.userPrincipalName || null,
            dn:           user?.dn           || null,
            error:        error || null,
        });
    };

    await run(ad,   'PRIMARY', adConfig.url,   adConfig.baseDN);
    await run(adGC, 'GC',      adGcConfig.url, adGcConfig.baseDN || '(root)');
    for (let i = 0; i < adExtra.length; i++) {
        await run(adExtra[i], `EXTRA_${i}`, _extraDomainConfigs[i].url, _extraDomainConfigs[i].baseDN);
    }

    return { username, initErrors: _initErrors, attempts: results };
};

// ── Stub AD Service (group lookups used by RecipientService) ───────────────────
const ADService = {
    getGroupEmail: async (groupName) => {
        logger.debug(`[ADService] Group lookup: ${groupName}`);
        const mockGroups = {
            'IT_Operations_DL': 'asif.ashfaq@igc.com.pk',
            'DCI_Team_DL':      'dti.support@igc.com.pk',
            'OPS_Support_DL':   'ops.support@igc.com.pk',
        };
        return mockGroups[groupName] || null;
    },
    getUser: async () => null,
};

export const getAllUsers = async () => [];
export const debugDumpAD = async () => ({ message: 'Use /admin/ad-lookup for diagnostics' });
export default ADService;

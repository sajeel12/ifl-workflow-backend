/**
 * probe-ad-sidecar.mjs
 *
 * Calls adsearch.aspx directly (loopback) and prints the RAW JSON so we can
 * see exactly which attributes AD returns — confirms whether office/locality/
 * memberOf/whenCreated are present in the deployed sidecar response.
 *
 * Usage on the server:
 *   node probe-ad-sidecar.mjs ISRARULHAQ 128793
 *   (arg1 = sAMAccountName or name for ?q=, arg2 = employeeId for ?employeeId=)
 */

import 'dotenv/config';

const ADSEARCH_URL = process.env.ADSEARCH_URL || 'http://127.0.0.1:3000/adsearch.aspx';
const q = process.argv[2] || 'ISRARULHAQ';
const employeeId = process.argv[3] || '';

async function hit(label, paramKey, paramVal) {
    const url = new URL(ADSEARCH_URL);
    url.searchParams.set(paramKey, paramVal);
    console.log(`\n══════════════════════════════════════════════════════════`);
    console.log(`${label}: ${url.toString()}`);
    console.log(`══════════════════════════════════════════════════════════`);
    try {
        const res = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) });
        console.log(`HTTP ${res.status}`);
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); }
        catch { console.log('Non-JSON response:\n', text.slice(0, 1000)); return; }

        console.log(`results: ${Array.isArray(data.results) ? data.results.length : 'n/a'}`);
        (data.results || []).forEach((r, i) => {
            console.log(`\n  [${i}] keys present: ${Object.keys(r).join(', ')}`);
            console.log(`      sAMAccountName : ${r.sAMAccountName}`);
            console.log(`      displayName    : ${r.displayName}`);
            console.log(`      mail           : ${r.mail}`);
            console.log(`      employeeID     : ${r.employeeID}`);
            console.log(`      office         : ${JSON.stringify(r.office)}`);
            console.log(`      locality       : ${JSON.stringify(r.locality)}`);
            console.log(`      streetAddress  : ${JSON.stringify(r.streetAddress)}`);
            console.log(`      createdAt      : ${JSON.stringify(r.createdAt)}`);
            console.log(`      accountEnabled : ${JSON.stringify(r.accountEnabled)}`);
            console.log(`      memberOf count : ${Array.isArray(r.memberOf) ? r.memberOf.length : 'MISSING'}`);
        });
    } catch (e) {
        console.log(`ERROR: ${e.message}`);
    }
}

(async () => {
    console.log(`ADSEARCH_URL = ${ADSEARCH_URL}`);
    await hit('BY NAME/SAM (?q=)', 'q', q);
    if (employeeId) await hit('BY EMPLOYEE ID (?employeeId=)', 'employeeId', employeeId);
    console.log('\nDone.\n');
})();

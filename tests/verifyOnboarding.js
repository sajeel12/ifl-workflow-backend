import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

const BASE_URL = 'http://localhost:3000';

async function verifyWorkflow() {
    console.log('--- Starting Onboarding Verification ---');

    // 1. Simulate HR Submission
    console.log('[1] HR Submitting Request...');
    const hrData = new URLSearchParams({
        employeeId: 'EMP-001',
        fullName: 'John Doe',
        department: 'Engineering',
        designation: 'Software Engineer',
        joiningDate: '2025-01-01',
        intranetAccess: 'on',
        internetAccess: 'on'
    });

    const hrRes = await fetch(`${BASE_URL}/api/onboarding/handle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: hrData
    });

    const hrText = await hrRes.text();
    if (hrText.includes('Request Submitted')) {
        console.log('✅ HR Submission Successful');
    } else {
        console.error('❌ HR Submission Failed:', hrText);
        process.exit(1);
    }

    // 2. Get Token for IT
    console.log('[2] Fetching IT Token from DB...');
    const db = await open({
        filename: './database.sqlite',
        driver: sqlite3.Database
    });

    const request = await db.get("SELECT * FROM OnboardingRequests WHERE fullName = 'John Doe' ORDER BY id DESC LIMIT 1");
    if (!request) {
        console.error('❌ Request not found in DB');
        process.exit(1);
    }
    const itToken = request.currentStageToken;
    console.log(`✅ IT Token: ${itToken}`);

    // 3. Simulate IT Submission
    console.log('[3] IT Submitting Configuration...');
    const itData = new URLSearchParams({
        ntUserName: 'john.doe',
        groupPolicyLevel: 'IT User',
        emailIncoming: 'on'
    });

    const itRes = await fetch(`${BASE_URL}/api/onboarding/handle?token=${itToken}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: itData
    });

    const itText = await itRes.text();
    if (itText.includes('Configuration Saved')) {
        console.log('✅ IT Submission Successful');
    } else {
        console.error('❌ IT Submission Failed:', itText);
        process.exit(1);
    }

    // 4. Get Token for DSI
    console.log('[4] Fetching DSI Token from DB...');
    const requestAfterIT = await db.get("SELECT * FROM OnboardingRequests WHERE id = ?", request.id);
    const dsiToken = requestAfterIT.currentStageToken;
    console.log(`✅ DSI Token: ${dsiToken}`);

    // 5. Simulate DSI Approval
    console.log('[5] DSI Approving...');
    const dsiData = new URLSearchParams({
        action: 'Approve',
        dsiRemarks: 'Approved by DSI'
    });

    const dsiRes = await fetch(`${BASE_URL}/api/onboarding/handle?token=${dsiToken}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: dsiData
    });

    const dsiText = await dsiRes.text();
    if (dsiText.includes('Request Approved')) {
        console.log('✅ DSI Approval Successful');
    } else {
        console.error('❌ DSI Approval Failed:', dsiText);
        // Note: The UI says "Request Approved" but our controller renders "Request ${action}d" -> "Request Approved"
    }

    // 6. Final Status Check
    const finalRequest = await db.get("SELECT * FROM OnboardingRequests WHERE id = ?", request.id);
    if (finalRequest.status === 'Approved') {
        console.log('✅ Final Status Verified: Approved');
    } else {
        console.error(`❌ Final Status Incorrect: ${finalRequest.status}`);
        process.exit(1);
    }

    console.log('--- Verification Complete: SUCCESS ---');
    await db.close();
}

verifyWorkflow().catch(err => {
    console.error('Unexpected Error:', err);
    process.exit(1);
});

import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

const BASE_URL = 'http://localhost:3000';

async function getToken() {
    // 1. Create Request
    const hrData = new URLSearchParams({
        employeeId: 'SCREENSHOT-001',
        fullName: 'Screenshot User',
        requestMode: 'New'
    });

    await fetch(`${BASE_URL}/api/onboarding/handle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: hrData
    });

    // 2. Get Token
    const db = await open({
        filename: './database.sqlite',
        driver: sqlite3.Database
    });

    const request = await db.get("SELECT * FROM OnboardingRequests WHERE employeeId = 'SCREENSHOT-001' ORDER BY id DESC LIMIT 1");
    console.log(request.currentStageToken);
    await db.close();
}

getToken();

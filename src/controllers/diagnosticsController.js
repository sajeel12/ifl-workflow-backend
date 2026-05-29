/**
 * SSO Authentication Diagnostics Controller
 *
 * Tests each layer of the authentication flow and reports which layer is failing:
 * - LAYER 1: Browser (Can connect, send credentials)
 * - LAYER 2: IIS (Windows Auth, X-Auth-User header)
 * - LAYER 3: token.aspx (HMAC token generation, AD query)
 * - LAYER 4: Network (Loopback check, proxy trust)
 * - LAYER 5: Node.js (HMAC validation, secret match, token age)
 */

import crypto from 'crypto';

const SSO_SHARED_SECRET = process.env.SSO_SHARED_SECRET || 'IFL_WORKFLOW_SECRET_KEY_2025';
const SSO_TRUST_PROXY_HEADER = process.env.SSO_TRUST_PROXY_HEADER === 'true';

/**
 * Helper: Check if request is from loopback
 */
function isLoopback(req) {
    const ip = (req.socket && req.socket.remoteAddress) || '';
    const clean = ip.replace(/^::ffff:/, '');
    return clean === '127.0.0.1' || clean === '::1' || clean === 'localhost';
}

/**
 * Helper: Strip domain prefix from username
 */
function stripDomain(username) {
    if (!username) return '';
    const parts = String(username).split('\\');
    return (parts.length > 1 ? parts[1] : parts[0]).trim().toLowerCase();
}

/**
 * GET /api/diagnostics/auth
 *
 * Comprehensive authentication layer test
 * Returns detailed status of each layer
 */
export const testAuthLayers = async (req, res) => {
    const results = {
        timestamp: new Date().toISOString(),
        overallStatus: 'UNKNOWN',
        layers: {}
    };

    console.log('\n=== SSO DIAGNOSTICS START ===');
    console.log('Request URL:', req.url);
    console.log('Request Method:', req.method);
    console.log('Request IP:', req.socket?.remoteAddress);

    // LAYER 1: Browser Level
    console.log('\n[LAYER 1: BROWSER]');
    results.layers.browser = {
        layer: 'BROWSER',
        description: 'Browser connectivity and request',
        status: 'PASS',
        checks: {
            canConnect: true,
            userAgent: req.headers['user-agent'] || 'Unknown',
            acceptsJson: req.headers['accept']?.includes('application/json') || false
        },
        message: 'Browser successfully connected to Node.js'
    };
    console.log('✓ Browser connected');
    console.log('  User-Agent:', results.layers.browser.checks.userAgent);

    // LAYER 2: IIS Level - Windows Authentication
    console.log('\n[LAYER 2: IIS - Windows Authentication]');
    const xAuthUser = req.headers['x-auth-user'];
    const hasWindowsAuth = !!xAuthUser;

    results.layers.iis = {
        layer: 'IIS',
        description: 'IIS Windows Authentication and X-Auth-User header',
        status: hasWindowsAuth ? 'PASS' : 'FAIL',
        checks: {
            hasXAuthUserHeader: hasWindowsAuth,
            xAuthUserValue: xAuthUser || 'NOT SET',
            strippedUsername: xAuthUser ? stripDomain(xAuthUser) : null
        },
        message: hasWindowsAuth
            ? `Windows Auth successful. User: ${stripDomain(xAuthUser)}`
            : '❌ FAILED: X-Auth-User header missing. Windows Authentication may not be enabled in IIS.'
    };

    if (hasWindowsAuth) {
        console.log('✓ Windows Auth working');
        console.log('  Raw header:', xAuthUser);
        console.log('  Stripped username:', stripDomain(xAuthUser));
    } else {
        console.error('✗ Windows Auth FAILED');
        console.error('  X-Auth-User header is missing');
        console.error('  Check IIS → Authentication → Windows Authentication is Enabled');
    }

    // LAYER 3: token.aspx - HMAC Token Generation
    console.log('\n[LAYER 3: token.aspx - HMAC Token]');
    const rawToken = req.headers['x-sidecar-token']
                    || req.body?.['x-sidecar-token']
                    || req.query['x-sidecar-token'];
    const hasToken = !!rawToken;

    let tokenData = null;
    let tokenParseError = null;

    if (hasToken) {
        try {
            tokenData = JSON.parse(rawToken);
            results.layers.tokenAspx = {
                layer: 'token.aspx',
                description: 'HMAC token generation from token.aspx',
                status: 'PASS',
                checks: {
                    hasToken: true,
                    canParseJson: true,
                    hasUsername: !!tokenData.username,
                    hasTimestamp: !!tokenData.timestamp,
                    hasEmail: !!tokenData.email,
                    hasDisplayName: !!tokenData.displayName,
                    hasSignature: !!tokenData.signature,
                    username: tokenData.username,
                    email: tokenData.email,
                    displayName: tokenData.displayName,
                    timestamp: tokenData.timestamp,
                    tokenAge: Math.abs(Math.floor(Date.now() / 1000) - (tokenData.timestamp || 0))
                },
                message: `Token generated successfully for ${tokenData.username}`
            };
            console.log('✓ token.aspx working');
            console.log('  Username:', tokenData.username);
            console.log('  Email:', tokenData.email);
            console.log('  Display Name:', tokenData.displayName);
            console.log('  Timestamp:', tokenData.timestamp);
            console.log('  Token Age (seconds):', results.layers.tokenAspx.checks.tokenAge);
        } catch (err) {
            tokenParseError = err.message;
            results.layers.tokenAspx = {
                layer: 'token.aspx',
                description: 'HMAC token generation from token.aspx',
                status: 'FAIL',
                checks: {
                    hasToken: true,
                    canParseJson: false,
                    parseError: err.message
                },
                message: `❌ FAILED: Token exists but JSON parse failed: ${err.message}`
            };
            console.error('✗ token.aspx FAILED');
            console.error('  Token parse error:', err.message);
        }
    } else {
        results.layers.tokenAspx = {
            layer: 'token.aspx',
            description: 'HMAC token generation from token.aspx',
            status: 'WARN',
            checks: {
                hasToken: false
            },
            message: '⚠ No sidecar token provided. This is OK for diagnostic endpoint, but required for protected routes.'
        };
        console.warn('⚠ No sidecar token provided (expected for diagnostic endpoint)');
    }

    // LAYER 4: Network Level - Loopback Check
    console.log('\n[LAYER 4: NETWORK - Loopback Trust]');
    const clientIp = req.socket?.remoteAddress || 'unknown';
    const isFromLoopback = isLoopback(req);
    const shouldTrustProxy = SSO_TRUST_PROXY_HEADER;

    results.layers.network = {
        layer: 'NETWORK',
        description: 'Network routing and proxy header trust',
        status: isFromLoopback ? 'PASS' : 'WARN',
        checks: {
            clientIp: clientIp,
            cleanIp: clientIp.replace(/^::ffff:/, ''),
            isLoopback: isFromLoopback,
            trustProxyHeaderEnabled: shouldTrustProxy,
            canTrustXAuthUser: isFromLoopback && shouldTrustProxy
        },
        message: isFromLoopback
            ? `Request from loopback (${clientIp}). X-Auth-User header is trusted.`
            : `⚠ Request from non-loopback IP (${clientIp}). X-Auth-User header should NOT be trusted. This is expected if accessing directly.`
    };

    if (isFromLoopback) {
        console.log('✓ Request from loopback');
        console.log('  Client IP:', clientIp);
        console.log('  X-Auth-User trusted:', shouldTrustProxy);
    } else {
        console.warn('⚠ Request from non-loopback IP');
        console.warn('  Client IP:', clientIp);
        console.warn('  This means request did not go through IIS proxy');
    }

    // LAYER 5: Node.js Level - HMAC Validation
    console.log('\n[LAYER 5: NODE.JS - HMAC Validation]');

    if (tokenData) {
        const { username, timestamp, email, displayName, signature } = tokenData;

        // Check 1: Token age (5-minute window)
        const now = Math.floor(Date.now() / 1000);
        const tokenAge = Math.abs(now - timestamp);
        const tokenExpired = tokenAge > 300;

        // Check 2: Compute HMAC signature (v2 format)
        const signingDataV2 = `${username}|${timestamp}|${email || ''}|${displayName || ''}`;
        const computedHmacV2 = crypto.createHmac('sha256', SSO_SHARED_SECRET)
            .update(signingDataV2)
            .digest('hex');

        // Check 3: Compute HMAC signature (v1 legacy format)
        const signingDataV1 = `${username}|${timestamp}`;
        const computedHmacV1 = crypto.createHmac('sha256', SSO_SHARED_SECRET)
            .update(signingDataV1)
            .digest('hex');

        // Check 4: Timing-safe comparison
        let signatureValid = false;
        let signatureVersion = null;
        let hmacComparisonError = null;

        try {
            const providedBuffer = Buffer.from(signature, 'hex');
            const computedBufferV2 = Buffer.from(computedHmacV2, 'hex');
            const computedBufferV1 = Buffer.from(computedHmacV1, 'hex');

            if (providedBuffer.length === computedBufferV2.length &&
                crypto.timingSafeEqual(providedBuffer, computedBufferV2)) {
                signatureValid = true;
                signatureVersion = 'v2';
            } else if (providedBuffer.length === computedBufferV1.length &&
                       crypto.timingSafeEqual(providedBuffer, computedBufferV1)) {
                signatureValid = true;
                signatureVersion = 'v1 (legacy)';
            }
        } catch (err) {
            hmacComparisonError = err.message;
        }

        const nodeJsStatus = !tokenExpired && signatureValid ? 'PASS' : 'FAIL';

        results.layers.nodejs = {
            layer: 'NODE.JS',
            description: 'Node.js HMAC signature validation',
            status: nodeJsStatus,
            checks: {
                tokenAge: tokenAge,
                tokenExpired: tokenExpired,
                maxAge: 300,
                signatureProvided: signature,
                signatureValid: signatureValid,
                signatureVersion: signatureVersion,
                computedHmacV2: computedHmacV2,
                computedHmacV1: computedHmacV1,
                signingDataV2: signingDataV2,
                signingDataV1: signingDataV1,
                ssoSharedSecret: SSO_SHARED_SECRET.substring(0, 10) + '...',
                hmacComparisonError: hmacComparisonError
            },
            message: nodeJsStatus === 'PASS'
                ? `✓ HMAC validation successful (${signatureVersion})`
                : `❌ FAILED: ${tokenExpired ? 'Token expired (age: ' + tokenAge + 's, max: 300s)' : 'Invalid HMAC signature'}`
        };

        if (nodeJsStatus === 'PASS') {
            console.log('✓ HMAC validation passed');
            console.log('  Signature version:', signatureVersion);
            console.log('  Token age:', tokenAge, 'seconds');
        } else {
            console.error('✗ HMAC validation FAILED');
            if (tokenExpired) {
                console.error('  Token expired:', tokenAge, 'seconds (max 300)');
            }
            if (!signatureValid) {
                console.error('  Signature mismatch');
                console.error('  Provided:', signature);
                console.error('  Expected (v2):', computedHmacV2);
                console.error('  Expected (v1):', computedHmacV1);
                console.error('  Signing data (v2):', signingDataV2);
            }
        }
    } else {
        results.layers.nodejs = {
            layer: 'NODE.JS',
            description: 'Node.js HMAC signature validation',
            status: 'SKIP',
            checks: {
                reason: 'No token provided to validate'
            },
            message: 'Skipped - no token available for validation'
        };
        console.log('- Skipped (no token to validate)');
    }

    // Overall Status
    const layerStatuses = Object.values(results.layers).map(l => l.status);
    const hasFailed = layerStatuses.includes('FAIL');
    const hasWarning = layerStatuses.includes('WARN');

    if (hasFailed) {
        results.overallStatus = 'FAIL';
        const failedLayers = Object.values(results.layers)
            .filter(l => l.status === 'FAIL')
            .map(l => l.layer);
        results.summary = `❌ Authentication FAILED at: ${failedLayers.join(', ')}`;
    } else if (hasWarning) {
        results.overallStatus = 'PARTIAL';
        results.summary = '⚠ Authentication partially working - check warnings';
    } else {
        results.overallStatus = 'PASS';
        results.summary = '✓ All authentication layers working correctly';
    }

    console.log('\n=== OVERALL STATUS ===');
    console.log(results.summary);
    console.log('=== SSO DIAGNOSTICS END ===\n');

    return res.json(results);
};

/**
 * GET /api/diagnostics/auth-ui
 *
 * Render diagnostic UI page
 */
export const renderDiagnosticUI = (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>SSO Authentication Diagnostics</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }
        .container {
            max-width: 1200px;
            margin: 0 auto;
        }
        h1 {
            color: white;
            text-align: center;
            margin-bottom: 30px;
            font-size: 2.5em;
            text-shadow: 2px 2px 4px rgba(0,0,0,0.3);
        }
        .refresh-btn {
            display: block;
            margin: 0 auto 30px;
            padding: 15px 40px;
            font-size: 18px;
            background: white;
            border: none;
            border-radius: 30px;
            cursor: pointer;
            box-shadow: 0 4px 15px rgba(0,0,0,0.2);
            transition: all 0.3s;
        }
        .refresh-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 20px rgba(0,0,0,0.3);
        }
        .loading {
            text-align: center;
            color: white;
            font-size: 20px;
            padding: 40px;
        }
        .status-banner {
            background: white;
            padding: 20px;
            border-radius: 10px;
            margin-bottom: 30px;
            text-align: center;
            font-size: 24px;
            font-weight: bold;
            box-shadow: 0 4px 15px rgba(0,0,0,0.2);
        }
        .status-banner.pass { color: #27ae60; border-left: 6px solid #27ae60; }
        .status-banner.fail { color: #e74c3c; border-left: 6px solid #e74c3c; }
        .status-banner.partial { color: #f39c12; border-left: 6px solid #f39c12; }
        .layer-card {
            background: white;
            border-radius: 10px;
            padding: 25px;
            margin-bottom: 20px;
            box-shadow: 0 4px 15px rgba(0,0,0,0.2);
            transition: all 0.3s;
        }
        .layer-card:hover {
            transform: translateY(-5px);
            box-shadow: 0 6px 20px rgba(0,0,0,0.3);
        }
        .layer-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
            padding-bottom: 15px;
            border-bottom: 2px solid #ecf0f1;
        }
        .layer-title {
            font-size: 20px;
            font-weight: bold;
            color: #2c3e50;
        }
        .layer-status {
            padding: 8px 20px;
            border-radius: 20px;
            font-weight: bold;
            font-size: 14px;
        }
        .layer-status.pass { background: #27ae60; color: white; }
        .layer-status.fail { background: #e74c3c; color: white; }
        .layer-status.warn { background: #f39c12; color: white; }
        .layer-status.skip { background: #95a5a6; color: white; }
        .layer-description {
            color: #7f8c8d;
            margin-bottom: 15px;
            font-size: 14px;
        }
        .layer-message {
            padding: 15px;
            border-radius: 8px;
            margin-bottom: 15px;
            font-size: 15px;
        }
        .layer-message.pass { background: #d5f4e6; color: #27ae60; }
        .layer-message.fail { background: #fadbd8; color: #e74c3c; }
        .layer-message.warn { background: #fef5e7; color: #f39c12; }
        .checks-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 10px;
            margin-top: 15px;
        }
        .check-item {
            padding: 10px;
            background: #f8f9fa;
            border-radius: 5px;
            font-size: 13px;
        }
        .check-label {
            font-weight: bold;
            color: #34495e;
            margin-bottom: 5px;
        }
        .check-value {
            color: #7f8c8d;
            word-break: break-all;
        }
        .check-value.true { color: #27ae60; font-weight: bold; }
        .check-value.false { color: #e74c3c; font-weight: bold; }
        .timestamp {
            text-align: center;
            color: white;
            margin-top: 30px;
            font-size: 14px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🔐 SSO Authentication Diagnostics</h1>
        <button class="refresh-btn" onclick="runDiagnostics()">🔄 Run Diagnostics</button>

        <div id="results">
            <div class="loading">Click "Run Diagnostics" to test authentication layers...</div>
        </div>
    </div>

    <script>
        async function runDiagnostics() {
            const resultsDiv = document.getElementById('results');
            resultsDiv.innerHTML = '<div class="loading">⏳ Testing authentication layers...</div>';

            try {
                // Try to fetch sidecar token (optional - may fail if Windows Auth broken)
                let sidecarToken = null;
                let tokenFetchError = null;

                try {
                    console.log('Attempting to fetch token.aspx...');
                    const tokenResp = await fetch('/token.aspx', {
                        credentials: 'include'  // Include Windows credentials
                    });

                    console.log('token.aspx response status:', tokenResp.status);
                    console.log('token.aspx response headers:', tokenResp.headers.get('content-type'));

                    if (tokenResp.ok) {
                        const text = await tokenResp.text();
                        console.log('token.aspx response:', text.substring(0, 200));

                        // Check if response is JSON
                        if (text.trim().startsWith('{')) {
                            sidecarToken = text;
                            console.log('✓ Got sidecar token');
                        } else {
                            tokenFetchError = 'token.aspx returned HTML instead of JSON (likely auth failure)';
                            console.warn('✗ token.aspx returned non-JSON:', text.substring(0, 100));
                        }
                    } else {
                        tokenFetchError = \`token.aspx returned status \${tokenResp.status}\`;
                        console.warn('✗ token.aspx failed with status:', tokenResp.status);
                    }
                } catch (err) {
                    tokenFetchError = err.message;
                    console.warn('✗ Could not fetch token.aspx:', err);
                }

                // Run diagnostics with or without token
                console.log('Calling /diagnostics/auth...');
                const response = await fetch('/diagnostics/auth', {
                    credentials: 'include',
                    headers: sidecarToken ? {
                        'x-sidecar-token': sidecarToken
                    } : {}
                });

                console.log('Diagnostics response status:', response.status);
                console.log('Diagnostics content-type:', response.headers.get('content-type'));

                // Check if response is JSON
                const contentType = response.headers.get('content-type') || '';
                if (!contentType.includes('application/json')) {
                    const text = await response.text();
                    throw new Error(\`Expected JSON but got \${contentType}. Response: \${text.substring(0, 200)}\`);
                }

                const data = await response.json();

                // Add token fetch error to results if present
                if (tokenFetchError) {
                    data.tokenFetchError = tokenFetchError;
                }

                displayResults(data);
            } catch (error) {
                console.error('Diagnostic test error:', error);

                resultsDiv.innerHTML = \`
                    <div class="status-banner fail">
                        ❌ Diagnostic Test Failed
                    </div>
                    <div class="layer-card">
                        <div class="layer-header">
                            <div class="layer-title">Error Details</div>
                            <div class="layer-status fail">ERROR</div>
                        </div>
                        <div class="layer-message fail">
                            <strong>Error Message:</strong><br>
                            \${error.message}
                        </div>
                        <div class="layer-description">
                            <strong>Common Causes:</strong><br>
                            • Windows Authentication is triggering login popup (401 loop)<br>
                            • IIS returning error page instead of JSON<br>
                            • CORS blocking the request<br>
                            • Node.js server not running on expected port<br><br>

                            <strong>How to Fix:</strong><br>
                            1. Check browser console (F12) for detailed errors<br>
                            2. Try accessing directly: <a href="/diagnostics/auth" target="_blank">/diagnostics/auth</a><br>
                            3. Try accessing: <a href="/token.aspx" target="_blank">/token.aspx</a><br>
                            4. Ensure you're using hostname (http://hosppdevsrv:3333) not IP address<br>
                            5. Check if Windows Authentication is enabled in IIS
                        </div>
                    </div>
                \`;
            }
        }

        function displayResults(data) {
            const statusClass = data.overallStatus.toLowerCase();

            let html = \`
                <div class="status-banner \${statusClass}">
                    \${data.summary}
                </div>
            \`;

            // Show token fetch warning if applicable
            if (data.tokenFetchError) {
                html += \`
                    <div class="layer-card">
                        <div class="layer-header">
                            <div class="layer-title">⚠️ Token Fetch Warning</div>
                            <div class="layer-status warn">WARN</div>
                        </div>
                        <div class="layer-message warn">
                            Could not fetch sidecar token from token.aspx: <strong>\${data.tokenFetchError}</strong><br><br>
                            This is expected if Windows Authentication is broken. The diagnostic will continue without token.
                        </div>
                    </div>
                \`;
            }

            // Sort layers by order
            const layerOrder = ['browser', 'iis', 'tokenAspx', 'network', 'nodejs'];
            const orderedLayers = layerOrder
                .map(key => data.layers[key])
                .filter(Boolean);

            orderedLayers.forEach(layer => {
                const statusClass = layer.status.toLowerCase();
                html += \`
                    <div class="layer-card">
                        <div class="layer-header">
                            <div class="layer-title">Layer: \${layer.layer}</div>
                            <div class="layer-status \${statusClass}">\${layer.status}</div>
                        </div>
                        <div class="layer-description">\${layer.description}</div>
                        <div class="layer-message \${statusClass}">\${layer.message}</div>
                        <div class="checks-grid">
                \`;

                Object.entries(layer.checks).forEach(([key, value]) => {
                    const valueClass = typeof value === 'boolean' ? value : '';
                    const displayValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
                    html += \`
                        <div class="check-item">
                            <div class="check-label">\${key}</div>
                            <div class="check-value \${valueClass}">\${displayValue}</div>
                        </div>
                    \`;
                });

                html += \`
                        </div>
                    </div>
                \`;
            });

            html += \`<div class="timestamp">Test completed at: \${new Date(data.timestamp).toLocaleString()}</div>\`;

            document.getElementById('results').innerHTML = html;
        }

        // Auto-run on load
        window.addEventListener('load', () => {
            setTimeout(runDiagnostics, 500);
        });
    </script>
</body>
</html>
    `);
};

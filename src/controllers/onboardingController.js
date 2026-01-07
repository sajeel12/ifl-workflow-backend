import * as onboardingService from '../services/onboardingService.js';
import logger from '../utils/logger.js';

export const handleRequest = async (req, res) => {
    const { token } = req.query;

    try {
        if (req.method === 'GET') {
            return await renderForm(req, res, token);
        } else if (req.method === 'POST') {
            return await handleSubmission(req, res, token);
        }
    } catch (err) {
        logger.error(`[Onboarding] Error: ${err.message}`);
        return res.status(500).send(`Error: ${err.message}`);
    }
};

const handleSubmission = async (req, res, token) => {
    const data = req.body;
    // Normalize checkbox values
    const checkboxFields = [
        'intranetAccess', 'internetAccess', 'specificWebsites', 'emailIncoming',
        'emailOutgoing', 'laserPrinter', 'dotMatrixPrinter'
    ];
    checkboxFields.forEach(field => {
        data[field] = data[field] === 'on';
    });

    try {
        if (!token) {
            // HR Submission
            await onboardingService.createRequest(data);
            return res.send(renderSuccess('Request Submitted', 'The request has been sent to IT Operations for service configuration.'));
        } else {
            const context = await onboardingService.getFormContext(token);
            if (!context) return res.send(renderError('Invalid or Expired Token'));

            const { role, request } = context;

            if (role === 'IT') {
                await onboardingService.updateITDetails(token, data);
                return res.send(renderSuccess('Services Configured', 'The request has been forwarded to the HOD for review.'));
            }
            else if (role === 'HOD') {
                const { action } = data;
                await onboardingService.handleHODApproval(token, action);
                return res.send(renderSuccess(`Request ${action}ed`, `The request has been forwarded to the DCI Team. (Action: ${action})`));
            }
            else if (role === 'DSI') {
                await onboardingService.updateDSIDetails(token, data);
                return res.send(renderSuccess('Configuration Saved', 'The request has been forwarded to the DCI Manager for final approval.'));
            }
            else if (role === 'DSIManager') {
                const { action, dsiRemarks } = data;
                await onboardingService.handleDSIManagerApproval(token, action, dsiRemarks);
                return res.send(renderSuccess(`Decision Recorded`, `The request has been processed. (Action: ${action})`));
            }
            else if (role === 'ITHOD') {
                const { action } = data;
                await onboardingService.handleITHODApproval(token, action);
                return res.send(renderSuccess(`Decision Recorded`, `The request has been finalized. (Action: ${action})`));
            }
            else if (role === 'OPS') {
                const { opsName } = data;
                // Parse checklist from body keys starting with "check_"
                const checklistData = [];
                Object.keys(data).forEach(key => {
                    if (key.startsWith('check_')) {
                        checklistData.push({ item: key.replace('check_', ''), checked: data[key] === 'on' });
                    }
                });
                await onboardingService.handleOPSAction(token, checklistData, opsName);
                return res.send(renderSuccess('Setup Completed', 'The workstation setup has been verified and recorded.'));
            }
            else {
                return res.send(renderError('Action not permitted.'));
            }
        }
    } catch (err) {
        return res.send(renderError(err.message));
    }
};

export const handleProofUpload = async (req, res) => {
    try {
        const { token, implementerName } = req.body;
        if (!req.files || req.files.length === 0) {
            return res.send(renderError('No files uploaded.'));
        }

        const filePaths = req.files.map(f => f.path);
        await onboardingService.handleDCIImplementation(token, filePaths, implementerName);

        return res.send(renderSuccess('Proofs Uploaded', 'Implementation proofs have been submitted. Request forwarded to OPS.'));
    } catch (err) {
        return res.send(renderError(err.message));
    }
};

const renderForm = async (req, res, token) => {
    let request = {};
    let role = 'HR';

    if (token) {
        const context = await onboardingService.getFormContext(token);
        if (!context) return res.send(renderError('Invalid or Expired Token'));
        request = context.request;
        role = context.role;
    }

    // Role-based Config
    const hrDisabled = role !== 'HR' ? 'disabled' : '';
    const isServiceEditable = (role === 'IT' || role === 'DSI');
    const servicesDisabled = !isServiceEditable ? 'disabled' : '';
    const configDisabled = role !== 'DSI' ? 'disabled' : '';
    const dsiRemarksDisabled = role !== 'DSIManager' ? 'disabled' : '';

    const val = (field) => request[field] || '';
    const chk = (field) => request[field] ? 'checked' : '';

    // Form Attributes
    let formAction = `?token=${token || ''}`;
    let formEnctype = '';
    if (role === 'DCIImplementer') {
        formAction = '/api/onboarding/upload-proof';
        formEnctype = 'enctype="multipart/form-data"';
    }

    // OPS Checklist Generation
    let opsChecklistHTML = '';
    if (role === 'OPS') {
        const items = [];
        if (request.intranetAccess) items.push('Configure Intranet Access');
        if (request.emailIncoming || request.emailOutgoing) items.push('Configure Outlook Email');
        if (request.deptSharePath) items.push(`Map Department Share (S:): ${request.deptSharePath}`);
        if (request.homeFolderPath) items.push(`Map Home Folder (Z:): ${request.homeFolderPath}`);
        if (request.laserPrinter) items.push(`Setup Laser Printer (${request.laserPrinterLocation || 'Default'})`);
        if (request.dotMatrixPrinter) items.push(`Setup Dot Matrix Printer (${request.dotMatrixPrinterLocation || 'Default'})`);
        if (request.iflPortalLink) items.push('Add IFL Portal Shortcut');
        items.push('Verify Domain Login');

        opsChecklistHTML = `
            <div class="section" style="background: #fff4ce; color: #333; border-bottom: 2px solid #fbc02d;">OPS Verification Checklist</div>
            <div class="form-grid" style="grid-template-columns: 1fr;">
                <div class="form-group"><label>Verifier Name</label><input type="text" name="opsName" required></div>
                <div class="checkbox-group">
                    ${items.map(item => `
                        <div class="checkbox-item" style="padding: 10px; border-bottom: 1px solid #eee;">
                            <input type="checkbox" name="check_${item}" required>
                            <label style="margin:0; font-weight: normal;">${item}</label>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Onboarding - ${role}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="stylesheet" href="https://static2.sharepointonline.com/files/fabric/office-ui-fabric-core/11.0.0/css/fabric.min.css">
        <style>
             /* Reusing previous styles exactly */
            body { font-family: 'Segoe UI', 'Segoe UI Web (West European)', 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, 'Helvetica Neue', sans-serif; background-color: #faf9f8; margin: 0; padding: 0; }
            .container { max-width: 900px; margin: 20px auto; background: white; box-shadow: 0 1.6px 3.6px 0 rgba(0,0,0,0.132), 0 0.3px 0.9px 0 rgba(0,0,0,0.108); }
            .header { background-color: #0078D4; padding: 16px 24px; display: flex; align-items: center; gap: 16px; color: white; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
            .header-content { flex-grow: 1; display: flex; justify-content: space-between; align-items: center; }
            .logo { height: 48px; padding: 6px; }
            .brand { font-weight: 600; font-size: 20px; }
            .form-title { font-size: 18px; font-weight: 400; opacity: 0.9; }
            
            .section { 
                padding: 10px 24px; 
                background-color: #f8f9fa; 
                border-bottom: 2px solid #0078D4; 
                border-top: 1px solid #e1dfdd;
                color: #0078D4; 
                font-weight: 600; 
                font-size: 14px; 
                text-transform: uppercase; 
                letter-spacing: 0.5px; 
                margin-top: 20px; 
                display: flex; 
                align-items: center; 
            }
            .section:first-of-type { border-top: none; margin-top: 0; }
            
            .form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 24px; padding: 24px; }
            .full-width { grid-column: 1 / -1; }
            .form-group { margin-bottom: 5px; }
            label { display: block; margin-bottom: 6px; font-weight: 600; font-size: 13px; color: #323130; }
            
            input[type="text"], input[type="date"], input[type="email"], select, textarea {
                width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #8a8886; font-family: inherit; font-size: 14px; border-radius: 0; transition: all 0.2s;
            }
            input:focus, select:focus, textarea:focus { outline: 2px solid #0078D4; border-color: transparent; }
            input:disabled, select:disabled, textarea:disabled { background-color: #f3f2f1; color: #605e5c; border-color: #e1dfdd; cursor: not-allowed; }
            
            .checkbox-group { display: flex; flex-direction: column; gap: 12px; margin-top: 10px; }
            .checkbox-item { display: flex; align-items: center; gap: 10px; font-size: 14px; color: #201f1e; }
            .checkbox-item input { width: 18px; height: 18px; margin: 0; cursor: pointer; }
            .checkbox-item input:disabled { cursor: not-allowed; }

            .btn-bar { padding: 24px; background-color: #f3f2f1; text-align: right; border-top: 1px solid #e1dfdd; }
            button { padding: 12px 32px; border: none; font-size: 15px; font-weight: 600; cursor: pointer; border-radius: 0; min-width: 120px; color: white; transition: background-color 0.2s; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
            .btn-primary { background-color: #0078D4; } .btn-primary:hover { background-color: #005a9e; }
            .btn-success { background-color: #107C10; } .btn-success:hover { background-color: #0c5d0c; }
            .btn-danger { background-color: #D13438; } .btn-danger:hover { background-color: #a4262c; }
            button:disabled { background-color: #c8c6c4; cursor: not-allowed; box-shadow: none; }

            .request-id-badge { font-size: 12px; background: rgba(255,255,255,0.2); padding: 4px 10px; border-radius: 4px; font-weight: 600; }
            .file-upload-box { border: 2px dashed #0078D4; padding: 20px; text-align: center; background: #eff6fc; }
        </style>
    </head>
    <body class="ms-Fabric">
        <form method="POST" action="${formAction}" ${formEnctype}>
             ${role === 'DCIImplementer' ? `<input type="hidden" name="token" value="${token}">` : ''}
            <div class="header">
                 <img src="/logo.png" alt="IFL Logo" class="logo">
                 <div class="header-content">
                    <div>
                        <div class="brand">Ibrahim Fibres Limited</div>
                        <div class="form-title">Intranet & Internet Proxy Form</div>
                    </div>
                    <div style="text-align:right">
                         ${token ? `<div className="request-id-badge">REQ #${request.id || 'NEW'}</div>` : ''}
                         <div style="font-size: 12px; opacity: 0.8; margin-top:5px;">Viewing as: <strong>${role}</strong></div>
                    </div>
                 </div>
            </div>
            
            <div class="container">
                <!-- Section 1: Requestor Information (HR Only) -->
                <div class="section">Requestor Information</div>
                <div class="form-grid">
                    <div class="form-group">
                        <label>Employee Number</label>
                        <input type="text" name="employeeId" value="${val('employeeId')}" ${hrDisabled} required>
                    </div>
                    <div class="form-group">
                        <label>Request Initiated On</label>
                        <input type="text" value="${new Date().toLocaleString()}" disabled>
                    </div>
                    <div class="form-group">
                        <label>Request Mode</label>
                        <select name="requestMode" ${hrDisabled}>
                            <option value="New" ${val('requestMode') === 'New' ? 'selected' : ''}>New</option>
                            <option value="Change" ${val('requestMode') === 'Change' ? 'selected' : ''}>Change</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label>Full Name</label>
                        <input type="text" name="fullName" value="${val('fullName')}" ${hrDisabled} required>
                    </div>
                    <div class="form-group">
                        <label>Joining Date</label>
                        <input type="date" name="joiningDate" value="${val('joiningDate') ? new Date(val('joiningDate')).toISOString().split('T')[0] : ''}" ${hrDisabled}>
                    </div>
                    <div class="form-group">
                        <label>Head Of Department</label>
                        <input type="text" name="hod" value="${val('hod')}" ${hrDisabled}>
                    </div>
                    <div class="form-group">
                        <label>Department</label>
                        <input type="text" name="department" value="${val('department')}" ${hrDisabled}>
                    </div>
                    <div class="form-group">
                        <label>Designation</label>
                        <input type="text" name="designation" value="${val('designation')}" ${hrDisabled}>
                    </div>
                    <div class="form-group">
                        <label>Project / Unit</label>
                        <input type="text" name="projectUnit" value="${val('projectUnit')}" ${hrDisabled}>
                    </div>
                    <div class="form-group">
                        <label>Office Extension</label>
                        <input type="text" name="officeExtension" value="${val('officeExtension')}" ${hrDisabled}>
                    </div>
                     <div class="form-group">
                        <label>Home Phone No.</label>
                        <input type="text" name="homePhone" value="${val('homePhone')}" ${hrDisabled}>
                    </div>
                     <div class="form-group">
                        <label>Mobile No.</label>
                        <input type="text" name="mobilePhone" value="${val('mobilePhone')}" ${hrDisabled}>
                    </div>
                </div>

                <!-- Section 2: Request Services (IT Only + DSI Editable) -->
                <div class="section">Intranet & Internet Services (IT Operations)</div>
                <div class="form-grid" style="grid-template-columns: 1fr;">
                    <div class="checkbox-group">
                        <div class="checkbox-item">
                            <input type="checkbox" name="intranetAccess" ${request.intranetAccess !== false ? 'checked' : ''} ${servicesDisabled}>
                            <label style="margin:0">Intranet Access</label>
                        </div>
                    </div>

                    <!-- Internet Services Section REMOVED -->

                    <div class="checkbox-group" style="margin-top:20px;">
                         <label style="text-decoration: underline;">External Email Services</label>
                         <div style="display: flex; gap: 40px;">
                            <div class="checkbox-item">
                                <input type="checkbox" name="emailIncoming" ${chk('emailIncoming')} ${servicesDisabled}>
                                <label style="margin:0">Incoming</label>
                            </div>
                            <div class="checkbox-item">
                                <input type="checkbox" name="emailOutgoing" ${chk('emailOutgoing')} ${servicesDisabled}>
                                <label style="margin:0">Outgoing</label>
                            </div>
                         </div>
                    </div>

                    <div class="form-group full-width" style="margin-top: 15px;">
                        <label>Purpose of Use of External Email Services</label>
                        <textarea name="emailPurpose" rows="3" ${servicesDisabled}>${val('emailPurpose')}</textarea>
                    </div>

                    <div class="checkbox-group" style="margin-top:20px;">
                         <label style="text-decoration: underline;">Print Services</label>
                         <div style="display: grid; grid-template-columns: 150px 1fr; gap: 20px; align-items: center; margin-bottom: 10px;">
                            <div class="checkbox-item">
                                <input type="checkbox" name="laserPrinter" ${chk('laserPrinter')} ${servicesDisabled}>
                                <label style="margin:0">Laser Printer</label>
                            </div>
                            <input type="text" name="laserPrinterLocation" placeholder="Location..." value="${val('laserPrinterLocation')}" ${servicesDisabled}>
                         </div>
                         <div style="display: grid; grid-template-columns: 150px 1fr; gap: 20px; align-items: center;">
                            <div class="checkbox-item">
                                <input type="checkbox" name="dotMatrixPrinter" ${chk('dotMatrixPrinter')} ${servicesDisabled}>
                                <label style="margin:0">Dot Matrix Printer</label>
                            </div>
                            <input type="text" name="dotMatrixPrinterLocation" placeholder="Location..." value="${val('dotMatrixPrinterLocation')}" ${servicesDisabled}>
                         </div>
                    </div>

                     <!-- File Share Services [Moved to END] -->
                    <div style="background: #eff6fc; padding: 15px; margin-top: 25px; border-left: 4px solid #0078D4;">
                        <label style="font-weight: 700; color: #0078D4; margin-bottom: 15px;">FILE SHARE SERVICES</label>
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 15px;">
                            <div class="form-group">
                                <label>Dept. Share (S:)</label>
                                <input type="text" name="deptSharePath" value="${val('deptSharePath')}" placeholder="e.g. \\PPFS8ER2\DeptShare..." ${servicesDisabled}>
                            </div>
                             <div class="form-group">
                                <label>Home Folder (Z:)</label>
                                <input type="text" name="homeFolderPath" value="${val('homeFolderPath')}" placeholder="e.g. \\PPFS8ER2\UserData..." ${servicesDisabled}>
                            </div>
                        </div>
                        <div class="form-group">
                             <label>IFL-Portal Site Link</label>
                             <input type="text" name="iflPortalLink" value="${val('iflPortalLink')}" placeholder="http://iflportal..." ${servicesDisabled}>
                        </div>
                    </div>
                </div>

                <!-- Section 3: DCI Configuration (DCI Only) -->
                <div class="section">DCI Approval & Configuration</div>
                <div class="form-grid">
                    <div class="form-group"><label>NT User Name</label><input type="text" name="ntUserName" value="${val('ntUserName')}" ${configDisabled}></div>
                    <div class="form-group"><label>Exchange Display Name</label><input type="text" name="exchangeDisplayName" value="${val('exchangeDisplayName')}" ${configDisabled}></div>
                    <div class="form-group"><label>SMTP Address</label><input type="text" name="smtpAddress" value="${val('smtpAddress')}" ${configDisabled}></div>
                    
                    <div class="form-group"><label>Member Of</label><input type="text" name="memberOf" value="${val('memberOf')}" ${configDisabled}></div>
                    <div class="form-group"><label>DG Members</label><input type="text" name="dgMembers" value="${val('dgMembers')}" ${configDisabled}></div>
                    
                    <div class="form-group"><label>Mail Size Limit</label><input type="text" name="mailSizeLimit" value="${val('mailSizeLimit')}" ${configDisabled}></div>
                    <div class="form-group"><label>Recipient Limit</label><input type="text" name="recipientLimit" value="${val('recipientLimit')}" ${configDisabled}></div>
                    <div class="form-group"><label>Mailbox Storage Limit</label><input type="text" name="mailboxStorageLimit" value="${val('mailboxStorageLimit')}" ${configDisabled}></div>
                    
                    <div class="form-group full-width">
                        <label>Extra Facility</label>
                        <textarea name="extraFacility" rows="2" ${configDisabled}>${val('extraFacility')}</textarea>
                    </div>

                    <div class="form-group"><label>Group Policy Level</label>
                         <select name="groupPolicyLevel" ${configDisabled} style="padding: 10px;">
                            <option value="">Select Level...</option>
                            <option value="Highly Managed" ${val('groupPolicyLevel') === 'Highly Managed' ? 'selected' : ''}>Highly Managed</option>
                            <option value="Lightly Managed" ${val('groupPolicyLevel') === 'Lightly Managed' ? 'selected' : ''}>Lightly Managed</option>
                            <option value="IT User" ${val('groupPolicyLevel') === 'IT User' ? 'selected' : ''}>IT User</option>
                        </select>
                    </div>
                </div>

                <!-- Approvals Section (DSI Manager / IT HOD) -->
                 ${(role === 'DSIManager' || role === 'ITHOD' || role !== 'HR') ? `
                    <div class="section">Approval Decision</div>
                    <div class="form-grid" style="grid-template-columns: 1fr;">
                        <div class="form-group">
                            <label>Remarks / Comments</label>
                            <textarea name="dsiRemarks" rows="3" ${dsiRemarksDisabled}>${val('dsiRemarks')}</textarea>
                        </div>
                    </div>
                ` : ''}

                <!-- OPS Checklist Section -->
                ${opsChecklistHTML}

                <!-- DCI Implementation Upload Section -->
                ${role === 'DCIImplementer' ? `
                    <div class="section" style="background: #e1f5fe; border-bottom: 2px solid #0078D4;">Implementation Proof</div>
                    <div class="form-grid" style="grid-template-columns: 1fr;">
                         <div class="form-group">
                            <label>Implementer Name</label>
                            <input type="text" name="implementerName" required>
                        </div>
                        <div class="form-group file-upload-box">
                            <label style="margin-bottom:15px; display:block; font-size:16px;">Upload AD & Exchange Screenshots</label>
                            <input type="file" name="dciProof" multiple accept="image/*" required>
                            <p style="margin-top:5px; font-size:12px; color:#666;">Supported formats: PNG, JPG (Max 5MB)</p>
                        </div>
                    </div>
                ` : ''}


                <div class="btn-bar">
                    ${role === 'HR' ? `<button type="submit" class="btn-primary">Submit Request</button>` : ''}
                    ${role === 'IT' ? `<button type="submit" class="btn-primary">Save & Forward to HOD</button>` : ''}
                    
                    ${role === 'HOD' ? `
                        <button type="submit" name="action" value="Approve" class="btn-success">Approve</button>
                        <button type="submit" name="action" value="Reject" class="btn-danger" style="margin-left: 10px;">Reject</button>
                    ` : ''}

                    ${role === 'DSI' ? `<button type="submit" class="btn-primary">Save & Forward to DCI Manager</button>` : ''}

                    ${(role === 'DSIManager' || role === 'ITHOD') ? `
                        <button type="submit" name="action" value="Approve" class="btn-success">Approve Request</button>
                        <button type="submit" name="action" value="Reject" class="btn-danger" style="margin-left: 10px;">Reject Request</button>
                    ` : ''}

                    ${role === 'DCIImplementer' ? `<button type="submit" class="btn-primary">Upload Proofs & Complete</button>` : ''}
                    ${role === 'OPS' ? `<button type="submit" class="btn-success">Verify & Close Request</button>` : ''}
                </div>
            </div>
        </form>
    </body>
    </html>
    `;
    return res.send(html);
};

const renderSuccess = (title, message) => `
    <!DOCTYPE html>
    <html>
    <head><title>Success</title><style>body{font-family:'Segoe UI';padding:40px;text-align:center;background:#faf9f8;} .box{background:white;padding:40px;max-width:500px;margin:0 auto;box-shadow:0 1.6px 3.6px 0 rgba(0,0,0,0.132);} h2{color:#107C10;}</style></head>
    <body><div class="box"><h2>${title}</h2><p>${message}</p></div></body>
    </html>
`;

const renderError = (message) => `
    <!DOCTYPE html>
    <html>
    <head><title>Error</title><style>body{font-family:'Segoe UI';padding:40px;text-align:center;background:#faf9f8;} .box{background:white;padding:40px;max-width:500px;margin:0 auto;box-shadow:0 1.6px 3.6px 0 rgba(0,0,0,0.132);} h2{color:#D13438;}</style></head>
    <body><div class="box"><h2>Error</h2><p>${message}</p></div></body>
    </html>
`;

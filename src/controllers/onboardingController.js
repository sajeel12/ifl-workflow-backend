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
    } else if (req.query.mock) {
        role = req.query.mock.toUpperCase(); // IT, HOD, DSI, OPS, HR
        request = {
            id: 'MOCK-' + role,
            fullName: 'Test User',
            employeeId: '1001',
            department: 'IT Dept',
            designation: 'Software Engineer',
            projectUnit: 'Head Office',
            joiningDate: '2023-01-01',
            officeExtension: '1234',
            requestMode: 'New',

            // IT Params (Pre-filled for later stages)
            intranetAccess: true,
            emailIncoming: true,
            emailOutgoing: true,
            deptSharePath: '\\\\Server\\Share',
            homeFolderPath: '\\\\Server\\Home',

            // Status params
            status: role === 'OPS' ? 'PendingOPSAction' : 'Pending' + role,
            approvalStatus: role === 'DCI' || role === 'OPS' ? 'Approved' : 'Pending'
        };

        // Adjust status/role for flow logic
        if (role === 'IT') request.status = 'PendingIT';
        if (role === 'HOD') request.status = 'PendingHOD';
        if (role === 'DSI') request.status = 'PendingDSI';
        if (role === 'DCIIMPLEMENTER') {
            role = 'DCIImplementer';
            request.status = 'PendingDCIImplementation';
            request.approvalStatus = 'Approved';
        }
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

    // Stepper Logic
    const getStepClass = (stepRole) => {
        const order = ['HR', 'IT', 'HOD', 'DSI', 'DSIManager', 'ITHOD', 'Approved', 'DCIImplementer', 'OPS', 'Completed'];
        const currentIdx = order.indexOf(role);
        const stepIdx = order.indexOf(stepRole);
        if (currentIdx === stepIdx) return 'active';
        if (currentIdx > stepIdx) return 'completed';
        return '';
    };
    // Simplified Mapping for Visual Stepper
    const steps = [
        { label: 'Initial Request', status: getStepClass('HR') },
        { label: 'IT Services', status: getStepClass('IT') },
        { label: 'Approvals', status: (['HOD', 'DSI', 'DSIManager', 'ITHOD'].includes(role) || request.approvalStatus === 'Approved') ? 'active' : (['DCIImplementer', 'OPS', 'Completed'].includes(request.status) ? 'completed' : '') },
        { label: 'Fulfillment', status: (['DCIImplementer', 'OPS', 'Completed'].includes(role) || request.status === 'Completed') ? 'active' : '' }
    ];


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
            <div class="ops-box">
                <div class="section-title">
                    <span>OPS Verification Checklist</span>
                    <span class="section-tag">Required</span>
                </div>
                <div class="grid-2">
                    <div class="form-group"><label>Verifier Name</label><input type="text" name="opsName" required></div>
                </div>
                <div class="checkbox-card-group" style="grid-template-columns: 1fr;">
                    ${items.map(item => `
                        <label class="checkbox-card">
                            <input type="checkbox" name="check_${item}" required>
                            <span>${item}</span>
                        </label>
                    `).join('')}
                </div>
            </div>
        `;
    }

    const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Onboarding - ${role}</title>
        <link rel="stylesheet" href="/css/modern.css">
    </head>
    <body>
        <div class="app-container">
            <header class="app-header">
                <div class="brand-section">
                    <img src="/logo.png" alt="IFL Logo" class="logo">
                    <div class="app-title">
                        <h1>Ibrahim Fibres Limited</h1>
                        <p>IT Onboarding Workflow</p>
                    </div>
                </div>
                <div class="status-section">
                    ${token ? `<div class="status-badge">REQ #${request.id || 'NEW'} | ${role}</div>` : ''}
                </div>
            </header>

            <div class="steps-container">
                <div class="steps">
                    ${steps.map((s, i) => `
                        <div class="step-item ${s.status}">
                            <div class="step-circle">${i + 1}</div>
                            <div class="step-label">${s.label}</div>
                        </div>
                    `).join('')}
                </div>
            </div>

            <form method="POST" action="${formAction}" ${formEnctype}>
                ${role === 'DCIImplementer' ? `<input type="hidden" name="token" value="${token}">` : ''}
                
                <div class="form-content">
                    
                    <!-- Section 1: Requestor Information -->
                    <div class="section-title">
                        <span>Employee Details</span>
                        <span class="section-tag">HR</span>
                    </div>
                         <div class="form-group full-width" style="background: #f8fafc; padding: 20px; border-radius: 8px; border: 1px solid #e2e8f0; margin-bottom: 24px;">
                            <label style="font-weight: 700; color: #0f172a; font-size: 1rem;">Employee ID <!-- (SAP ID) --></label>
                            <div style="display: flex; gap: 12px; align-items: center;">
                                <input type="text" id="employeeIdInput" name="employeeId" value="${val('employeeId')}" ${hrDisabled} required style="flex: 1; font-size: 1.1rem; padding: 12px; max-width: 300px;">
                                ${role === 'HR' ? '<button type="button" id="btnGetEmployee" class="btn btn-primary" style="height: 48px; display: flex; align-items: center; gap: 8px;"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z"/></svg> Get Employee Data</button>' : ''}
                            </div>
                            ${/* role === 'HR' ? '<p style="margin: 8px 0 0; font-size: 0.85rem; color: #64748b;">Enter the 4-digit Employee ID to auto-fill details from HRMS.</p>' : '' */ ''}
                        </div>
                    <div class="grid-2">
                         <div class="form-group">
                            <label>Full Name</label>
                            <input type="text" name="fullName" value="${val('fullName')}" ${hrDisabled} required>
                        </div>
                         <div class="form-group">
                            <label>Request Mode</label>
                            <select name="requestMode" ${hrDisabled}>
                                <option value="New" ${val('requestMode') === 'New' ? 'selected' : ''}>New Hiring</option>
                                <option value="Change" ${val('requestMode') === 'Change' ? 'selected' : ''}>Change / Modification</option>
                            </select>
                        </div>
                    </div>
                    <div class="grid-3">
                        <div class="form-group"><label>Department</label><input type="text" name="department" value="${val('department')}" ${hrDisabled}></div>
                        <div class="form-group"><label>Designation</label><input type="text" name="designation" value="${val('designation')}" ${hrDisabled}></div>
                        <div class="form-group"><label>Project / Unit</label><input type="text" name="projectUnit" value="${val('projectUnit')}" ${hrDisabled}></div>
                    </div>
                    <div class="grid-3">
                        <div class="form-group"><label>HOD Name</label><input type="text" name="hod" value="${val('hod')}" ${hrDisabled}></div>
                        <div class="form-group"><label>Joining Date</label><input type="date" name="joiningDate" value="${val('joiningDate') ? new Date(val('joiningDate')).toISOString().split('T')[0] : ''}" ${hrDisabled}></div>
                        <div class="form-group"><label>Office Extension</label><input type="text" name="officeExtension" value="${val('officeExtension')}" ${hrDisabled}></div>
                    </div>

                    ${(role !== 'HR' || request.id) ? `
                    <!-- Section 2: IT Services -->
                    <div class="it-services-box">
                        <div class="section-title">
                            <span>IT Services Configuration</span>
                            <span class="section-tag">IT Operations</span>
                        </div>
                        
                        <div class="checkbox-card-group">
                            <label class="checkbox-card">
                                <input type="checkbox" name="intranetAccess" ${request.intranetAccess !== false ? 'checked' : ''} ${servicesDisabled}>
                                <span>Intranet Access</span>
                            </label>
                        </div>

                        <div style="margin-top: 20px;">
                            <label style="margin-bottom: 8px; display:block; font-weight:600;">Email Services</label>
                             <div class="checkbox-card-group">
                                <label class="checkbox-card">
                                    <input type="checkbox" name="emailIncoming" ${chk('emailIncoming')} ${servicesDisabled}>
                                    <span>Incoming Email</span>
                                </label>
                                <label class="checkbox-card">
                                    <input type="checkbox" name="emailOutgoing" ${chk('emailOutgoing')} ${servicesDisabled}>
                                    <span>Outgoing Email</span>
                                </label>
                            </div>
                        </div>
                         <div class="form-group full-width" style="margin-top: 10px;">
                            <input type="text" name="emailPurpose" placeholder="Purpose of External Email..." value="${val('emailPurpose')}" ${servicesDisabled}>
                        </div>

                         <div style="margin-top: 20px;">
                            <label style="margin-bottom: 8px; display:block; font-weight:600;">Printing Services</label>
                            <div class="grid-2">
                                <div style="display:flex; gap:10px; align-items:center;">
                                     <input type="checkbox" name="laserPrinter" ${chk('laserPrinter')} ${servicesDisabled} style="width:20px; height:20px;">
                                     <input type="text" name="laserPrinterLocation" placeholder="Laser Printer Location" value="${val('laserPrinterLocation')}" ${servicesDisabled}>
                                </div>
                                <div style="display:flex; gap:10px; align-items:center;">
                                     <input type="checkbox" name="dotMatrixPrinter" ${chk('dotMatrixPrinter')} ${servicesDisabled} style="width:20px; height:20px;">
                                     <input type="text" name="dotMatrixPrinterLocation" placeholder="Dot Matrix Location" value="${val('dotMatrixPrinterLocation')}" ${servicesDisabled}>
                                </div>
                            </div>
                        </div>

                         <div style="margin-top: 20px; padding-top:20px; border-top:1px dashed #cbd5e1;">
                            <label style="margin-bottom: 8px; display:block; font-weight:600;">File Share Services</label>
                            <div class="grid-2">
                                <div class="form-group"><label>Dept Share (S:)</label><input type="text" name="deptSharePath" value="${val('deptSharePath')}" ${servicesDisabled}></div>
                                <div class="form-group"><label>Home Folder (Z:)</label><input type="text" name="homeFolderPath" value="${val('homeFolderPath')}" ${servicesDisabled}></div>
                            </div>
                            <div class="form-group"><label>IFL Portal Link</label><input type="text" name="iflPortalLink" value="${val('iflPortalLink')}" ${servicesDisabled}></div>
                        </div>
                    </div>

                    <!-- Section 3: DCI Configuration -->
                    <div class="dci-box">
                        <div class="section-title">
                            <span>DCI Configuration</span>
                            <span class="section-tag">DCI Team</span>
                        </div>
                        <div class="grid-3">
                            <div class="form-group"><label>NT User Name</label><input type="text" name="ntUserName" value="${val('ntUserName')}" ${configDisabled}></div>
                            <div class="form-group"><label>Exchange Name</label><input type="text" name="exchangeDisplayName" value="${val('exchangeDisplayName')}" ${configDisabled}></div>
                            <div class="form-group"><label>SMTP Address</label><input type="text" name="smtpAddress" value="${val('smtpAddress')}" ${configDisabled}></div>
                        </div>
                        <div class="grid-2">
                             <div class="form-group"><label>Member Of</label><input type="text" name="memberOf" value="${val('memberOf')}" ${configDisabled}></div>
                             <div class="form-group"><label>DG Members</label><input type="text" name="dgMembers" value="${val('dgMembers')}" ${configDisabled}></div>
                        </div>
                        <div class="grid-3">
                            <div class="form-group"><label>Mail Size</label><input type="text" name="mailSizeLimit" value="${val('mailSizeLimit')}" ${configDisabled}></div>
                            <div class="form-group"><label>Recipient Limit</label><input type="text" name="recipientLimit" value="${val('recipientLimit')}" ${configDisabled}></div>
                            <div class="form-group"><label>Storage Limit</label><input type="text" name="mailboxStorageLimit" value="${val('mailboxStorageLimit')}" ${configDisabled}></div>
                        </div>
                         <div class="form-group"><label>Group Policy Level</label>
                             <select name="groupPolicyLevel" ${configDisabled}>
                                <option value="">Select Level...</option>
                                <option value="Highly Managed" ${val('groupPolicyLevel') === 'Highly Managed' ? 'selected' : ''}>Highly Managed</option>
                                <option value="Lightly Managed" ${val('groupPolicyLevel') === 'Lightly Managed' ? 'selected' : ''}>Lightly Managed</option>
                                <option value="Kiosk" ${val('groupPolicyLevel') === 'Kiosk' ? 'selected' : ''}>Kiosk</option>
                            </select>
                        </div>
                         <div class="form-group"><label>Extra Facility</label><textarea name="extraFacility" rows="2" ${configDisabled}>${val('extraFacility')}</textarea></div>
                         <div class="form-group full-width">
                            <label>DSI Remarks / Instructions</label>
                            <textarea name="remarks" rows="3" ${dsiRemarksDisabled}>${val('remarks')}</textarea>
                        </div>
                    </div>

                    <!-- Approvals -->
                     ${(role === 'DSIManager' || role === 'ITHOD' || role !== 'HR') ? `
                        <div class="section-title"><span>Approval Remarks</span></div>
                        <div class="form-group">
                            <textarea name="dsiRemarks" rows="3" placeholder="Enter logic or comments here..." ${dsiRemarksDisabled}>${val('dsiRemarks')}</textarea>
                        </div>
                    ` : ''}
                    ` : ''}

                    <!-- OPS Checklist Dynamic -->
                    ${opsChecklistHTML}

                    <!-- DCI Implementation -->
                    ${role === 'DCIImplementer' ? `
                         <div class="dci-box" style="border-color: var(--primary);">
                            <div class="section-title"><span>Proof of Implementation</span></div>
                            <div class="form-group"><label>Implementer Name</label><input type="text" name="implementerName" required></div>
                            <div class="form-group" style="padding: 20px; border: 2px dashed #cbd5e1; text-align: center; border-radius: 8px;">
                                <label style="cursor: pointer; color: var(--primary); font-weight: 600;">Click to Upload Screenshots (AD/Exchange)</label>
                                <input type="file" name="dciProof" multiple accept="image/*" required style="margin-top: 10px;">
                            </div>
                        </div>
                    ` : ''}

                </div>

                <div class="action-bar">
                    ${role === 'HR' ? `<button type="submit" class="btn btn-primary">Submit Request</button>` : ''}
                    ${role === 'IT' ? `<button type="submit" class="btn btn-primary">Save & Forward to HOD</button>` : ''}

                    ${role === 'HOD' ? `
                        <button type="submit" name="action" value="Reject" class="btn btn-danger">Reject</button>
                        <button type="submit" name="action" value="Approve" class="btn btn-success">Approve</button>
                    ` : ''}

                    ${role === 'DSI' ? `<button type="submit" class="btn btn-primary">Save & Forward to Manager</button>` : ''}

                    ${(role === 'DSIManager' || role === 'ITHOD') ? `
                        <button type="submit" name="action" value="Reject" class="btn btn-danger">Reject Request</button>
                        <button type="submit" name="action" value="Approve" class="btn btn-success">Approve Request</button>
                    ` : ''}

                    ${role === 'DCIImplementer' ? `<button type="submit" class="btn btn-primary">Upload Proofs & Complete</button>` : ''}
                    ${role === 'OPS' ? `<button type="submit" class="btn btn-success">Verify & Close Request</button>` : ''}
                </div>
            </form>
        </div>
        <script>
            document.addEventListener('DOMContentLoaded', () => {
                const btn = document.getElementById('btnGetEmployee');
                if (btn) {
                    btn.addEventListener('click', async () => {
                        const empIdInput = document.getElementById('employeeIdInput');
                        const empId = empIdInput.value.trim();

                        if (!empId) {
                            alert('Please enter an Employee ID');
                            empIdInput.focus();
                            return;
                        }

                        const originalText = btn.textContent;
                        btn.textContent = 'Fetching...';
                        btn.disabled = true;

                        try {
                            const res = await fetch('/api/hrms/employee/' + empId);
                            if (!res.ok) throw new Error('Employee not found');
                            const data = await res.json();

                            // Populate fields
                            const setVal = (name, val) => {
                                const el = document.querySelector('input[name="' + name + '"]');
                                if (el && val) el.value = val;
                            };

                            setVal('fullName', data.fullName);
                            setVal('department', data.department);
                            setVal('designation', data.designation);
                            setVal('projectUnit', data.projectUnit);
                            setVal('joiningDate', data.joiningDate);
                            setVal('officeExtension', data.officeExtension);

                        } catch (err) {
                            alert(err.message);
                        } finally {
                            btn.textContent = originalText;
                            btn.disabled = false;
                        }
                    });
                }
            });
        </script>
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

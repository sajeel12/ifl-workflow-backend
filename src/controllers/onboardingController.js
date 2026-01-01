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
            return res.send(renderSuccess('Request Submitted', 'The request has been sent to IT Operations for configuration.'));
        } else {
            // Token-based submission (IT or DSI)
            const context = await onboardingService.getFormContext(token);
            if (!context) return res.send(renderError('Invalid or Expired Token'));

            if (context.role === 'IT') {
                await onboardingService.updateITDetails(token, data);
                return res.send(renderSuccess('Configuration Saved', 'The request has been forwarded to DSI for final approval.'));
            } else if (context.role === 'DSI') {
                const { action, dsiRemarks } = data;
                await onboardingService.finalizeRequest(token, action, dsiRemarks);
                return res.send(renderSuccess(`Request ${action}d`, `The request has been finalized successfully.`));
            } else {
                return res.send(renderError('Action not permitted in this stage.'));
            }
        }
    } catch (err) {
        return res.send(renderError(err.message));
    }
};

const renderForm = async (req, res, token) => {
    let request = {};
    let role = 'HR'; // Default to HR if no token
    let isReadOnly = false;

    if (token) {
        const context = await onboardingService.getFormContext(token);
        if (!context) return res.send(renderError('Invalid or Expired Token'));
        request = context.request;
        role = context.role;
        if (role === 'ReadOnly') isReadOnly = true;
    }

    const hrDisabled = role !== 'HR' ? 'disabled' : '';
    const itDisabled = role !== 'IT' ? 'disabled' : '';
    const dsiDisabled = role !== 'DSI' ? 'disabled' : '';

    // Special logic for Services Section: It is now IT's responsibility, not HR's.
    // So for Services, we disable if NOT IT.
    const servicesDisabled = role !== 'IT' ? 'disabled' : '';

    // Config Section is now DSI's responsibility.
    const configDisabled = role !== 'DSI' ? 'disabled' : '';


    // Helper to render value safe
    const val = (field) => request[field] || '';
    const chk = (field) => request[field] ? 'checked' : '';

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>New User Onboarding Form</title>
        <link rel="stylesheet" href="https://static2.sharepointonline.com/files/fabric/office-ui-fabric-core/11.0.0/css/fabric.min.css">
        <style>
            body { font-family: 'Segoe UI', sans-serif; background-color: #faf9f8; margin: 0; padding: 20px; }
            .container { max-width: 900px; margin: 0 auto; background: white; box-shadow: 0 1.6px 3.6px 0 rgba(0,0,0,0.132); }
            .header { background-color: #0078D4; padding: 20px; color: white; display: flex; align-items: center; justify-content: space-between; }
            .header h1 { margin: 0; font-size: 20px; font-weight: 600; text-transform: uppercase; }
            .section { padding: 5px 20px; border-bottom: 2px solid #f3f2f1; background-color: #f8f8f8; color: #605e5c; font-weight: 600; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 0; display: flex; align-items: center; height: 40px; }
            .form-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 20px; padding: 20px; }
            .full-width { grid-column: 1 / -1; }
            .form-group { margin-bottom: 5px; }
            label { display: block; margin-bottom: 5px; font-weight: 600; font-size: 13px; color: #323130; }
            input[type="text"], input[type="date"], input[type="email"], select, textarea {
                width: 100%; box-sizing: border-box; padding: 8px 12px; border: 1px solid #8a8886; font-family: inherit; font-size: 14px; border-radius: 0;
            }
            input:focus, select:focus, textarea:focus { outline: 2px solid #0078D4; border-color: transparent; }
            input:disabled, select:disabled, textarea:disabled { background-color: #f3f2f1; color: #605e5c; border-color: #e1dfdd; }
            
            .checkbox-group { display: flex; flex-direction: column; gap: 10px; margin-top: 10px; }
            .checkbox-item { display: flex; align-items: center; gap: 10px; font-size: 14px; }
            .checkbox-item input { width: auto; margin: 0; }

            .btn-bar { padding: 20px; background-color: #f3f2f1; text-align: right; border-top: 1px solid #e1dfdd; }
            button { padding: 10px 30px; border: none; font-size: 14px; font-weight: 600; cursor: pointer; border-radius: 0; min-width: 100px; color: white; }
            .btn-primary { background-color: #0078D4; }
            .btn-success { background-color: #107C10; }
            .btn-danger { background-color: #D13438; }
            button:disabled { background-color: #c8c6c4; cursor: not-allowed; }

            .readonly-text { font-size: 12px; color: #a19f9d; margin-top: 4px; }
            /* Hide print locations if unchecked (simplified for now, ideally JS toggle) */
        </style>
    </head>
    <body class="ms-Fabric">
        <form method="POST" action="?token=${token || ''}">
            <div class="container">
                <div class="header">
                    <h1>Intranet & Internet Proxy Form</h1>
                    ${token ? `<span style="font-size: 12px; background: rgba(255,255,255,0.2); padding: 4px 8px;">Request #${request.id || 'NEW'}</span>` : ''}
                </div>

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

                <!-- Section 2: Request Services (IT Only) -->
                <div class="section">Intranet & Internet Services (IT Operations)</div>
                <div class="form-grid" style="grid-template-columns: 1fr;">
                    <div class="checkbox-group">
                        <div class="checkbox-item">
                            <input type="checkbox" name="intranetAccess" ${chk('intranetAccess')} ${servicesDisabled}>
                            <label style="margin:0">Intranet Access</label>
                        </div>
                    </div>

                    <div class="checkbox-group" style="margin-top:20px;">
                         <label style="text-decoration: underline;">Internet Services</label>
                         <div style="display: flex; gap: 40px;">
                            <div class="checkbox-item">
                                <input type="checkbox" name="internetAccess" ${chk('internetAccess')} ${servicesDisabled}>
                                <label style="margin:0">General Browsing</label>
                            </div>
                            <div class="checkbox-item">
                                <input type="checkbox" name="specificWebsites" ${chk('specificWebsites')} ${servicesDisabled}>
                                <label style="margin:0">Specific Websites</label>
                            </div>
                         </div>
                    </div>

                    <div class="form-group full-width" style="margin-top: 15px;">
                        <label>Purpose of Use of Intranet and Internet Services</label>
                        <textarea name="internetPurpose" rows="3" ${servicesDisabled}>${val('internetPurpose')}</textarea>
                    </div>

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
                </div>

                <!-- Section 3: DSI Configuration -->
                <div class="section">DSI Approval & Configuration</div>
                <div class="form-grid">
                    <div class="form-group">
                        <label>NT User Name</label>
                        <input type="text" name="ntUserName" value="${val('ntUserName')}" ${configDisabled}>
                    </div>
                    <div class="form-group">
                        <label>Exchange Display Name</label>
                        <input type="text" name="exchangeDisplayName" value="${val('exchangeDisplayName')}" ${configDisabled}>
                    </div>
                    <div class="form-group">
                        <label>SMTP Address</label>
                        <input type="text" name="smtpAddress" value="${val('smtpAddress')}" ${configDisabled}>
                    </div>
                     <div class="form-group">
                        <label>Member of (if any)</label>
                        <input type="text" name="memberOf" value="${val('memberOf')}" ${configDisabled}>
                    </div>
                    <div class="form-group">
                        <label>DG Members</label>
                        <input type="text" name="dgMembers" value="${val('dgMembers')}" ${configDisabled}>
                    </div>
                    <div class="form-group">
                        <label>Mail Size Limit</label>
                        <input type="text" name="mailSizeLimit" value="${val('mailSizeLimit')}" ${configDisabled}>
                    </div>
                    <div class="form-group">
                        <label>Recipient Limit</label>
                        <input type="text" name="recipientLimit" value="${val('recipientLimit')}" ${configDisabled}>
                    </div>
                    <div class="form-group">
                        <label>Mailbox Storage Limit</label>
                        <input type="text" name="mailboxStorageLimit" value="${val('mailboxStorageLimit')}" ${configDisabled}>
                    </div>
                    <div class="form-group">
                        <label>Extra Facility</label>
                        <input type="text" name="extraFacility" value="${val('extraFacility')}" ${configDisabled}>
                    </div>
                    
                    <div class="form-group full-width">
                        <label>Group Policy Level</label>
                        <div style="display: flex; gap: 20px; margin-top: 5px;">
                            <div class="checkbox-item">
                                <input type="radio" name="groupPolicyLevel" value="Highly Managed" ${val('groupPolicyLevel') === 'Highly Managed' ? 'checked' : ''} ${configDisabled}>
                                <label>Highly Managed User</label>
                            </div>
                            <div class="checkbox-item">
                                <input type="radio" name="groupPolicyLevel" value="Lightly Managed" ${val('groupPolicyLevel') === 'Lightly Managed' ? 'checked' : ''} ${configDisabled}>
                                <label>Lightly Managed User</label>
                            </div>
                             <div class="checkbox-item">
                                <input type="radio" name="groupPolicyLevel" value="IT User" ${val('groupPolicyLevel') === 'IT User' ? 'checked' : ''} ${configDisabled}>
                                <label>IT User</label>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Approvals (DSI) -->
                <div class="form-grid" style="grid-template-columns: 1fr;">
                    <div class="form-group">
                        <label>Deputy Manager Network Remarks</label>
                        <textarea name="dsiRemarks" rows="3" ${dsiDisabled}>${val('dsiRemarks')}</textarea>
                    </div>
                </div>

                <!-- Footer Actions -->
                <div class="btn-bar">
                    ${role === 'HR' && !isReadOnly ? `<button type="submit" class="btn-primary">Submit Request</button>` : ''}
                    
                    ${role === 'IT' ? `<button type="submit" class="btn-primary">Save & Forward to DSI</button>` : ''}
                    
                    ${role === 'DSI' ? `
                        <button type="submit" name="action" value="Approve" class="btn-success">Approve</button>
                        <button type="submit" name="action" value="Reject" class="btn-danger" style="margin-left: 10px;">Reject</button>
                        <button type="submit" name="action" value="Cancel" style="margin-left: 10px; background-color: #ffb900; color: black;">Cancel</button>
                    ` : ''}

                    ${isReadOnly ? `<span class="readonly-text" style="font-size: 14px; font-weight: 600;">Status: ${request.status} (View Only)</span>` : ''}
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

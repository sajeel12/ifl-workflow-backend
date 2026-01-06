import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';

export const generateOnboardingPDF = async (request, outputPath) => {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ margin: 50 });
        const stream = fs.createWriteStream(outputPath);

        doc.pipe(stream);

        // Header
        doc.fontSize(20).text('Ibrahim Fibres Limited', { align: 'center' });
        doc.fontSize(14).text('Intranet & Internet Service Request Form', { align: 'center' });
        doc.moveDown();

        const drawSection = (title) => {
            doc.moveDown(0.5);
            doc.fontSize(12).fillColor('#0078D4').text(title.toUpperCase(), { underline: true });
            doc.fillColor('black').fontSize(10);
            doc.moveDown(0.5);
        };

        const drawField = (label, value) => {
            doc.text(`${label}: ${value || 'N/A'}`);
        };

        const drawBool = (label, value) => {
            doc.text(`[${value ? 'X' : ' '}] ${label}`);
        };

        // --- HR Section ---
        drawSection('Requestor Information');
        drawField('Employee ID', request.employeeId);
        drawField('Full Name', request.fullName);
        drawField('Department', request.department);
        drawField('Designation', request.designation);
        drawField('HOD', request.hod);
        drawField('Project/Unit', request.projectUnit);
        drawField('Extension', request.officeExtension);
        drawField('Mobile', request.mobilePhone);

        // --- IT Services ---
        drawSection('IT Operations Services');

        doc.text('Intranet Access:', { underline: true });
        drawBool('Intranet Access', request.intranetAccess);

        doc.moveDown(0.5);
        doc.text('Email Services:', { underline: true });
        drawBool('Incoming Email', request.emailIncoming);
        drawBool('Outgoing Email', request.emailOutgoing);

        doc.moveDown(0.5);
        doc.text('File Share Services:', { underline: true });
        drawField('Dept Share (S:)', request.deptSharePath);
        drawField('Home Folder (Z:)', request.homeFolderPath);
        drawField('Portal Link', request.iflPortalLink);

        doc.moveDown(0.5);
        doc.text('Printing:', { underline: true });
        if (request.laserPrinter) doc.text(`[X] Laser Printer (${request.laserPrinterLocation || ''})`);
        if (request.dotMatrixPrinter) doc.text(`[X] Dot Matrix Printer (${request.dotMatrixPrinterLocation || ''})`);


        // --- DCI Config ---
        drawSection('DCI Configuration');
        drawField('NT User Name', request.ntUserName);
        drawField('Exchange Name', request.exchangeDisplayName);
        drawField('SMTP Address', request.smtpAddress);
        drawField('Member Of', request.memberOf);
        drawField('DG Members', request.dgMembers);
        drawField('Mail Limit', request.mailSizeLimit);
        drawField('Recipient Limit', request.recipientLimit);
        drawField('Storage Limit', request.mailboxStorageLimit);
        drawField('Group Policy', request.groupPolicyLevel);
        if (request.extraFacility) drawField('Extra Facility', request.extraFacility);

        // --- Approvals ---
        drawSection('Approvals');
        drawField('Status', request.approvalStatus);
        if (request.hodApprovedAt) drawField('HOD Approved At', request.hodApprovedAt.toLocaleString());
        if (request.dsiManagerDecidedAt) drawField('DSI Manager Action At', request.dsiManagerDecidedAt.toLocaleString());
        if (request.itHodDecidedAt) drawField('IT HOD Action At', request.itHodDecidedAt.toLocaleString());

        if (request.dsiRemarks) {
            doc.moveDown();
            doc.text('Remarks:', { underline: true });
            doc.text(request.dsiRemarks);
        }

        doc.end();

        stream.on('finish', () => resolve(outputPath));
        stream.on('error', reject);
    });
};

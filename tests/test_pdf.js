import OnboardingRequest from '../src/models/OnboardingRequest.js';
import * as pdfService from '../src/services/pdfService.js';
import path from 'path';

const testPDF = async () => {
    try {
        // Create a dummy request directly
        const request = await OnboardingRequest.create({
            employeeId: 'PDFUser',
            fullName: 'PDF Test User',
            department: 'IT',
            designation: 'Tester',
            deptSharePath: '\\\\Server\\Share',
            homeFolderPath: '\\\\Server\\Home',
            iflPortalLink: 'http://portal',
            intranetAccess: true,
            internetAccess: true,
            emailIncoming: true,
            emailOutgoing: true,
            status: 'Approved',
            approvalStatus: 'Approved',
            hodApprovedAt: new Date(),
            dsiManagerDecidedAt: new Date(),
            dsiRemarks: 'Approved for testing'
        });

        console.log('Created dummy request:', request.id);
        const outputPath = path.resolve('generated_pdfs', `Manual_Test_${request.id}.pdf`);
        await pdfService.generateOnboardingPDF(request, outputPath);
        console.log('PDF Generated at:', outputPath);
    } catch (error) {
        console.error('Error:', error);
    }
};

testPDF();

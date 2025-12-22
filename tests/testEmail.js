
import dotenv from 'dotenv';
dotenv.config();

const toEmail = process.argv[2];

if (!toEmail) {
    console.error('Please provide an email address as an argument.');
    process.exit(1);
}

const { sendApprovalEmail } = await import('../src/services/emailService.js');

console.log('Using SMTP Host:', process.env.SMTP_HOST);
console.log('Using SMTP Port:', process.env.SMTP_PORT);
console.log('Using SMTP User:', process.env.SMTP_USER || 'Not Set');

console.log('Sending test email to:', toEmail);
try {
    const info = await sendApprovalEmail(toEmail, 'Test Subject', 'This is a test request', 'http://localhost:3000/test-link');
    console.log('Email sent successfully:', info.messageId);
} catch (error) {
    console.error('Failed to send email:', error);
}

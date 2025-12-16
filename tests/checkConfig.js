
import dotenv from 'dotenv';
dotenv.config();

console.log('--- Configuration Check ---');
console.log('APP_URL:', process.env.APP_URL);
console.log('SMTP_HOST:', process.env.SMTP_HOST);
console.log('ACTIONABLE_MESSAGE_PROVIDER_ID:', process.env.ACTIONABLE_MESSAGE_PROVIDER_ID || 'Not Set (Defaulting to placeholder)');
console.log('---------------------------');

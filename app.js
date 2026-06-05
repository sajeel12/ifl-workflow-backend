import express from 'express';
import cors from 'cors';
import apiRoutes from './src/routes/api.js';
import adminRoutes from './src/routes/admin.js';
import portalRoutes from './src/routes/portal.js';
import diagnosticsRoutes from './src/routes/diagnostics.js';
import { ssoMiddleware } from './src/middleware/ssoMiddleware.js';
import { adminMiddleware } from './src/middleware/adminMiddleware.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Configure View Engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'src/views'));


app.use(cors({
    origin: 'http://portal.ifl.local',
    credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
// Serve DCI implementation proof images (UUID-named, so effectively obscure)
app.use('/uploads/proofs', express.static(path.join(__dirname, 'uploads', 'proofs')));


app.use('/api', apiRoutes);
app.use('/admin', adminRoutes);
app.use('/portal', portalRoutes);
app.use('/diagnostics', diagnosticsRoutes);


app.get('/', (req, res) => {
    res.send('IFL Workflow Backend is Running');
});

export default app;

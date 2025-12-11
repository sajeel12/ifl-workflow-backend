import express from 'express';
import cors from 'cors';
import apiRoutes from './src/routes/api.js';

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/api', apiRoutes);

// Root
app.get('/', (req, res) => {
    res.send('IFL Workflow Backend is Running');
});

export default app;

import express from 'express';
import cors from 'cors';
import logger from './src/utils/logger.js';
import dotenv from 'dotenv';
dotenv.config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request Logger
app.use((req, res, next) => {
    logger.info(`${req.method} ${req.url}`);
    next();
});

// Basic Health Check
app.get('/', (req, res) => {
    res.send('IFL Workflow Backend Running');
});

// Configure Routes
import routes from './src/routes/api.js';
app.use('/api', routes);

// Error Handler
app.use((err, req, res, next) => {
    logger.error(err.stack);
    res.status(500).json({ error: 'Something went wrong!' });
});

export default app;

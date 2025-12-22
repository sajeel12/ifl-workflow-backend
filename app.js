import express from 'express';
import cors from 'cors';
import apiRoutes from './src/routes/api.js';

const app = express();


app.use(cors({
    origin: 'http://portal.ifl.local',
    credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));


app.use('/api', apiRoutes);


app.get('/', (req, res) => {
    res.send('IFL Workflow Backend is Running');
});

export default app;

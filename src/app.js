import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import trainRoutes from './routes/trains.js';

const app = express();

app.use(cors());
app.use(morgan('dev'));
app.use(express.json());
app.use(express.static('public'));

// All train-related routes live under /api
app.use('/api', trainRoutes);

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', message: 'Train optimizer is running' });
});

export default app;
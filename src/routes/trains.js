import { Router } from 'express';
import { getRoutes, getStations } from '../controllers/routerController.js';

const router = Router();

router.get('/routes', getRoutes);
router.get('/stations', getStations);

export default router;
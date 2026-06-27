import { findOptimalRoutes, loadStations } from '../services/routerService.js';

export async function getRoutes(req, res) {
    const { from, to, connected } = req.query;

    if (!from || !to) {
        return res.status(400).json({
            error: 'Both from and to stations are required.',
            example: '/api/routes?from=ST&to=MAJN&connected=true'
        });
    }

    if (from.toUpperCase() === to.toUpperCase()) {
        return res.status(400).json({
            error: 'Origin and destination cannot be the same station.'
        });
    }

    const showConnected = connected === 'true';
    const result = await findOptimalRoutes(from, to, showConnected);
    res.json(result);
}

export async function getStations(req, res) {
    const stations = await loadStations();
    res.json(stations);
}
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const SCHEDULES_PATH = join(__dirname, '../../data/schedules.json');
const STATIONS_PATH  = join(__dirname, '../../data/stations.json');

export async function loadSchedules() {
    console.log('Loading schedules.json…');
    const raw  = await readFile(SCHEDULES_PATH, 'utf-8');
    const data = JSON.parse(raw);
    console.log(`Loaded ${data.length} schedule entries`);

    const byTrain = new Map();       // trainNumber → stop[]
    const stationToTrains = new Map(); // stationCode → Set<trainNumber>  ← NEW

    for (const entry of data) {
        const num  = entry.train_number;
        const code = entry.station_code?.toUpperCase();

        // Build byTrain (same as before)
        if (!byTrain.has(num)) byTrain.set(num, []);
        byTrain.get(num).push({
            stationCode: code,
            stationName: entry.station_name,
            arrival:     entry.arrival,
            departure:   entry.departure,
            day:         entry.day ?? 1,
        });

        // Build inverted index: station → which trains stop here
        // This is the key change — O(1) lookup instead of scanning byTrain
        if (code) {
            if (!stationToTrains.has(code)) stationToTrains.set(code, new Set());
            stationToTrains.get(code).add(num);
        }
    }

    // Sort each train's stops by day, then departure time (same as before)
    for (const [, stops] of byTrain) {
        stops.sort((a, b) => {
            if (a.day !== b.day) return a.day - b.day;
            const at = toMins(a.departure) ?? toMins(a.arrival) ?? 0;
            const bt = toMins(b.departure) ?? toMins(b.arrival) ?? 0;
            return at - bt;
        });
    }

    console.log(`Indexed ${byTrain.size} trains across ${stationToTrains.size} stations`);
    return { byTrain, stationToTrains }; // ← now returns both
}

export async function loadStations() {
    const raw  = await readFile(STATIONS_PATH, 'utf-8');
    const data = JSON.parse(raw);
    return data.features.map(f => ({
        code:  f.properties.code?.toUpperCase(),
        name:  f.properties.name,
        state: f.properties.state,
    }));
}

export function toMins(timeStr) {
    if (!timeStr || timeStr === 'None') return null;
    const parts = timeStr.split(':');
    return parseInt(parts[0]) * 60 + parseInt(parts[1]);
}
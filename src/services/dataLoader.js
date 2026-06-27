import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const SCHEDULES_PATH = join(__dirname, '../../data/schedules.json');
const STATIONS_PATH  = join(__dirname, '../../data/stations.json');

// ─── Load and index schedules ─────────────────────────────────────────────────
// Returns a Map: trainNumber → array of stops (sorted by day + departure time)
// We build this index once at startup — expensive to compute, cheap to query

export async function loadSchedules() {
    console.log('Loading schedules.json — this may take a moment...');
    const raw  = await readFile(SCHEDULES_PATH, 'utf-8');
    const data = JSON.parse(raw);
    console.log(`Loaded ${data.length} schedule entries`);

    // Group all stops by train number
    // Python equivalent: defaultdict(list)
    const byTrain = new Map();

    for (const entry of data) {
        const num = entry.train_number;
        if (!byTrain.has(num)) byTrain.set(num, []);
        byTrain.get(num).push({
            stationCode: entry.station_code?.toUpperCase(),
            stationName: entry.station_name,
            arrival:     entry.arrival,     // "18:10:00" or "None"
            departure:   entry.departure,   // "18:15:00" or "None"
            day:         entry.day ?? 1,    // journey day (1, 2, 3...)
        });
    }

    // Sort each train's stops by day first, then departure time
    for (const [, stops] of byTrain) {
        stops.sort((a, b) => {
            if (a.day !== b.day) return a.day - b.day;
            const at = toMins(a.departure) ?? toMins(a.arrival) ?? 0;
            const bt = toMins(b.departure) ?? toMins(b.arrival) ?? 0;
            return at - bt;
        });
    }

    console.log(`Indexed ${byTrain.size} unique trains`);
    return byTrain;
}

// ─── Load stations ────────────────────────────────────────────────────────────
// Returns array of { code, name } — used for dropdown / search
export async function loadStations() {
    const raw  = await readFile(STATIONS_PATH, 'utf-8');
    const data = JSON.parse(raw);
    // stations.json is GeoJSON — properties are nested
    return data.features.map(f => ({
        code: f.properties.code?.toUpperCase(),
        name: f.properties.name,
        state: f.properties.state,
    }));
}

// ─── Helper ───────────────────────────────────────────────────────────────────
// Converts "18:15:00" to minutes from midnight. Returns null for "None".
export function toMins(timeStr) {
    if (!timeStr || timeStr === 'None') return null;
    const parts = timeStr.split(':');
    return parseInt(parts[0]) * 60 + parseInt(parts[1]);
}
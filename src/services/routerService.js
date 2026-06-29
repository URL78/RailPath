import { loadSchedules, loadStations, toMins } from './dataLoader.js';

// ─── Constants ────────────────────────────────────────────────────────────────
const MAX_WAIT_MINS    = 120; // max interchange wait shown (2 hours)
const MAX_RESULTS      = 20;  // cap on connected routes returned

// ─── Module-level cache ───────────────────────────────────────────────────────
// Both structures built once at startup, never rebuilt per request
let byTrain        = null; // Map: trainNumber → stop[]
let stationToTrains = null; // Map: stationCode → Set<trainNumber>

async function ensureLoaded() {
    if (!byTrain) {
        const loaded = await loadSchedules();
        byTrain         = loaded.byTrain;
        stationToTrains = loaded.stationToTrains;
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Build a per-train position index: stationCode → stop object
// Called once per train per request, result is a plain object for O(1) access
// Why not do this at startup? Stops are per-train, so the map structure is
// Map<trainNo, Map<stationCode, stop>> — that's fine but the per-train Map
// is cheap to build on demand for only the trains we actually touch
function buildStopIndex(stops) {
    const idx = new Map();
    for (const stop of stops) idx.set(stop.stationCode, stop);
    return idx;
}

function absoluteMins(stop, useArrival = false) {
    const time = useArrival
        ? (toMins(stop.arrival)   ?? toMins(stop.departure))
        : (toMins(stop.departure) ?? toMins(stop.arrival));
    return ((stop.day - 1) * 24 * 60) + time;
}

function formatDuration(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

// Set intersection utility — returns a new Set of elements in both a and b
// Why: the inner loop is replaced entirely by this; |result| is tiny
function intersect(setA, setB) {
    // Always iterate the smaller set for efficiency
    const [small, large] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
    const result = new Set();
    for (const item of small) {
        if (large.has(item)) result.add(item);
    }
    return result;
}

// ─── Main routing function ────────────────────────────────────────────────────
export async function findOptimalRoutes(origin, destination, showConnected) {
    origin      = origin.toUpperCase().trim();
    destination = destination.toUpperCase().trim();

    await ensureLoaded();

    // --- Step 1: O(1) lookups — which trains serve each station? ---
    // If a station code doesn't exist in our index, it has no trains at all
    const trainsAtOrigin = stationToTrains.get(origin);
    const trainsAtDest   = stationToTrains.get(destination);

    if (!trainsAtOrigin || !trainsAtDest) {
        // One of the stations has no trains — return early
        return { origin, destination, directTrains: [], connectedRoutes: [] };
    }

    // --- Step 2: Direct trains — set intersection, no loop needed ---
    // A direct train is any train that appears in BOTH sets
    // Then we just verify ordering (origin before destination)
    const directCandidates = intersect(trainsAtOrigin, trainsAtDest);

    const directTrains = [];

    for (const trainNo of directCandidates) {
        const stops    = byTrain.get(trainNo);
        const stopIdx  = buildStopIndex(stops); // O(stops) — only for matched trains
        const originStop = stopIdx.get(origin);
        const destStop   = stopIdx.get(destination);

        if (!originStop || !destStop) continue;

        const depAbs = absoluteMins(originStop, false);
        const arrAbs = absoluteMins(destStop,   true);

        if (arrAbs > depAbs) {
            directTrains.push({
                trainNo,
                from:            origin,
                to:              destination,
                departure:       originStop.departure,
                arrival:         destStop.arrival,
                durationMins:    arrAbs - depAbs,
                durationDisplay: formatDuration(arrAbs - depAbs),
            });
        }
    }

    directTrains.sort((a, b) =>
        (toMins(a.departure) ?? 0) - (toMins(b.departure) ?? 0)
    );

    if (!showConnected) {
        return { origin, destination, directTrains, connectedRoutes: [] };
    }

    // --- Step 3: Connected routes — the core improvement ---
    //
    // Old approach: for each train from origin, for each stop, for each train → O(T×S×T)
    //
    // New approach:
    //   For each train A that stops at origin:
    //     For each stop X on train A after origin:
    //       candidates = stationToTrains.get(X) ∩ trainsAtDest   ← O(1) lookup + tiny intersect
    //       For each train B in candidates:
    //         Check timing (leg B departs after leg A arrives)
    //
    // The inner "for each train B" is now bounded by |candidates|, which is the
    // number of trains that serve BOTH the interchange AND the destination.
    // In practice this is 1–10 trains, not 9,000.
    //
    // Deduplication: we only keep the BEST route (shortest total time) per
    // interchange station — stops the API returning 40 variants of "change at Mumbai"

    const bestPerInterchange = new Map(); // interchange → best route object

    for (const trainNo of trainsAtOrigin) {
    const stops    = byTrain.get(trainNo);
    const stopIdx  = buildStopIndex(stops);

    const originStop = stopIdx.get(origin);
    if (!originStop) continue;

    // GUARD 1: train A must NOT reach destination directly
    if (stopIdx.get(destination)) continue;

    const originAbsDep = absoluteMins(originStop, false);

    let pastOrigin = false;
    for (const interchangeStop of stops) {
        if (interchangeStop.stationCode === origin) { pastOrigin = true; continue; }
        if (!pastOrigin) continue;
        if (interchangeStop.stationCode === destination) continue;

        const interchange       = interchangeStop.stationCode;
        const interchangeAbsArr = absoluteMins(interchangeStop, true);
        if (interchangeAbsArr <= originAbsDep) continue;

        const trainsAtInterchange = stationToTrains.get(interchange);
        if (!trainsAtInterchange) continue;

        const legBCandidates = intersect(trainsAtInterchange, trainsAtDest);

        for (const trainNoB of legBCandidates) {
            if (trainNoB === trainNo) continue;

            // GUARD 2: train B must NOT serve origin — if it does, it's a direct
            // train being boarded mid-route, which is not a real connection
            if (stationToTrains.get(origin)?.has(trainNoB)) continue;

            const stopsB   = byTrain.get(trainNoB);
            const stopIdxB = buildStopIndex(stopsB);

            const intStopB  = stopIdxB.get(interchange);
            const destStopB = stopIdxB.get(destination);
            if (!intStopB || !destStopB) continue;

            const legBAbsDep = absoluteMins(intStopB,  false);
            const legBAbsArr = absoluteMins(destStopB, true);
            if (legBAbsArr <= legBAbsDep) continue;

            const legAArrClock = toMins(interchangeStop.arrival)  ?? toMins(interchangeStop.departure);
            const legBDepClock = toMins(intStopB.departure)       ?? toMins(intStopB.arrival);

            let waitMins = legBDepClock - legAArrClock;
            if (waitMins < 0) waitMins += 24 * 60;
            if (waitMins > MAX_WAIT_MINS) continue;

            const legADuration = interchangeAbsArr - originAbsDep;
            const legBDuration = legBAbsArr - legBAbsDep;
            const totalMins    = legADuration + waitMins + legBDuration;

            const route = {
                legA: {
                    trainNo,
                    from:            origin,
                    to:              interchange,
                    departure:       originStop.departure,
                    arrival:         interchangeStop.arrival ?? interchangeStop.departure,
                    durationMins:    legADuration,
                    durationDisplay: formatDuration(legADuration),
                },
                interchange,
                waitMins,
                waitDisplay: formatDuration(waitMins),
                legB: {
                    trainNo:         trainNoB,
                    from:            interchange,
                    to:              destination,
                    departure:       intStopB.departure  ?? intStopB.arrival,
                    arrival:         destStopB.arrival   ?? destStopB.departure,
                    durationMins:    legBDuration,
                    durationDisplay: formatDuration(legBDuration),
                },
                totalJourneyMins:    totalMins,
                totalJourneyDisplay: formatDuration(totalMins),
            };

            const existing = bestPerInterchange.get(interchange);
            if (!existing || totalMins < existing.totalJourneyMins) {
                bestPerInterchange.set(interchange, route);
            }
        }
    }
}

    // Convert map to array, sort by total journey time, cap results
    const connectedRoutes = [...bestPerInterchange.values()]
        .sort((a, b) => a.totalJourneyMins - b.totalJourneyMins)
        .slice(0, MAX_RESULTS);

    return { origin, destination, directTrains, connectedRoutes };
}

export { loadStations };
import { loadSchedules, loadStations, toMins } from './dataLoader.js';

// ─── Module-level cache ───────────────────────────────────────────────────────
// Load once when server starts, reuse on every request
// This is important — schedules.json is large, don't reload per request
let schedulesCache = null;

async function getSchedules() {
    if (!schedulesCache) schedulesCache = await loadSchedules();
    return schedulesCache;
}

// ─── Core helper ─────────────────────────────────────────────────────────────
// Given a train's stops and a station code,
// returns the stop object if the train calls at that station, else null
function findStop(stops, stationCode) {
    return stops.find(s => s.stationCode === stationCode) ?? null;
}

// Calculate total minutes accounting for journey day
// e.g. day 2 departure at 06:00 = 1 * 24 * 60 + 360 = 1800 mins from origin
function absoluteMins(stop, useArrival = false) {
    const time = useArrival
        ? (toMins(stop.arrival) ?? toMins(stop.departure))
        : (toMins(stop.departure) ?? toMins(stop.arrival));
    return ((stop.day - 1) * 24 * 60) + time;
}

function formatDuration(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

// ─── Main routing function ────────────────────────────────────────────────────
export async function findOptimalRoutes(origin, destination, showConnected) {
    origin      = origin.toUpperCase().trim();
    destination = destination.toUpperCase().trim();

    const byTrain = await getSchedules();

    const directTrains    = [];
    const connectedRoutes = [];

    // Loop through every train in the dataset
    for (const [trainNo, stops] of byTrain) {
        const originStop = findStop(stops, origin);
        const destStop   = findStop(stops, destination);

        // ── Direct trains ─────────────────────────────────────────────────────
        // Train must stop at BOTH stations, and origin must come before destination
        if (originStop && destStop) {
            const depAbs = absoluteMins(originStop, false);
            const arrAbs = absoluteMins(destStop, true);

            if (arrAbs > depAbs) {
                const durationMins = arrAbs - depAbs;
                directTrains.push({
                    trainNo,
                    trainName:       stops[0]?.stationName ?? trainNo,
                    from:            origin,
                    to:              destination,
                    departure:       originStop.departure,
                    arrival:         destStop.arrival,
                    durationMins,
                    durationDisplay: formatDuration(durationMins),
                });
            }
        }

        // ── Connected trains — Leg A ──────────────────────────────────────────
        if (!showConnected) continue;

        // This train could be Leg A if it stops at origin
        // but does NOT stop at destination (otherwise it's already a direct train)
        if (!originStop) continue;

        // Find all stations this train passes AFTER origin
        // Those are potential interchange stations
        const originAbsDep = absoluteMins(originStop, false);

        for (const interchangeStop of stops) {
            // Interchange must come after origin on this train
            if (interchangeStop.stationCode === origin) continue;
            if (interchangeStop.stationCode === destination) continue;

            const interchangeAbsArr = absoluteMins(interchangeStop, true);
            if (interchangeAbsArr <= originAbsDep) continue;

            const interchange = interchangeStop.stationCode;
            const legADuration = interchangeAbsArr - originAbsDep;

            // Now find all Leg B trains: depart from interchange → reach destination
            for (const [trainNoB, stopsB] of byTrain) {
                if (trainNoB === trainNo) continue; // can't be same train

                const intStopB  = findStop(stopsB, interchange);
                const destStopB = findStop(stopsB, destination);

                if (!intStopB || !destStopB) continue;

                const legBAbsDep = absoluteMins(intStopB, false);
                const legBAbsArr = absoluteMins(destStopB, true);

                if (legBAbsArr <= legBAbsDep) continue; // dest before interchange

                // Timing rule: Leg B must depart AFTER Leg A arrives
                // We compare within-day times since day fields reset per train
                // Use clock times: legB departure must be after legA arrival
                const legAArrMins  = toMins(interchangeStop.arrival) 
                                  ?? toMins(interchangeStop.departure);
                const legBDepMins  = toMins(intStopB.departure)
                                  ?? toMins(intStopB.arrival);

                let waitMins = legBDepMins - legAArrMins;
                // If wait is negative, legB departs next calendar day
                if (waitMins < 0) waitMins += 24 * 60;

                // Skip impossibly long waits (over 24 hours — likely data issue)
                if (waitMins > 24 * 60) continue;

                const legBDuration = legBAbsArr - legBAbsDep;
                const totalMins    = legADuration + waitMins + legBDuration;

                connectedRoutes.push({
                    legA: {
                        trainNo,
                        from:            origin,
                        to:              interchange,
                        departure:       originStop.departure,
                        arrival:         interchangeStop.arrival 
                                      ?? interchangeStop.departure,
                        durationMins:    legADuration,
                        durationDisplay: formatDuration(legADuration),
                    },
                    interchange,
                    waitMins,
                    waitDisplay:         formatDuration(waitMins),
                    legB: {
                        trainNo:         trainNoB,
                        from:            interchange,
                        to:              destination,
                        departure:       intStopB.departure ?? intStopB.arrival,
                        arrival:         destStopB.arrival ?? destStopB.departure,
                        durationMins:    legBDuration,
                        durationDisplay: formatDuration(legBDuration),
                    },
                    totalJourneyMins:    totalMins,
                    totalJourneyDisplay: formatDuration(totalMins),
                });
            }
        }
    }

    // Sort direct trains by departure time
    directTrains.sort((a, b) =>
        (toMins(a.departure) ?? 0) - (toMins(b.departure) ?? 0)
    );

    // Sort connected routes by total journey time ascending
    connectedRoutes.sort((a, b) => a.totalJourneyMins - b.totalJourneyMins);

    return { origin, destination, directTrains, connectedRoutes };
}

// ─── Stations list (for dropdown) ────────────────────────────────────────────
export { loadStations };
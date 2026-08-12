// Ported 1:1 from _source/ADSBBeaconReader/ADSBBeaconReaderService.cs
// namespace DGScope.ADSBBeaconReader
// WebClient -> fetch; JsonConvert.DeserializeObject<T> -> JSON.parse + map [JsonProperty] wire
// names; Timer -> setInterval; Thread.Sleep -> await sleep(); Dictionary/HashSet -> Map/Set
// (OrdinalIgnoreCase hex keys lowercased); ObservableCollection -> Array; Func<T> -> function;
// file logging (LocalApplicationData) -> no-op (no browser filesystem).
import { GeoPoint } from "../GeoPoint.js";
import { ADSBv2Response, ADSBv2Aircraft } from "./ADSBv2Response.js";

const sleep = (ms) => new Promise(r => setTimeout(r, ms)); // Thread.Sleep

// JsonConvert.DeserializeObject<ADSBv2Response>(json)  (maps [JsonProperty] wire names)
function deserializeADSBv2Response(json) {
    const o = JSON.parse(json);
    if (o == null) return null;
    const r = new ADSBv2Response();
    r.Message = o.msg ?? null;
    r.Now = o.now ?? 0;
    r.Total = o.total ?? 0;
    r.Aircraft = Array.isArray(o.ac) ? o.ac.map(a => {
        const x = new ADSBv2Aircraft();
        x.Hex = a.hex ?? null; x.Flight = a.flight ?? null; x.Squawk = a.squawk ?? null;
        x.Registration = a.r ?? null; x.AircraftType = a.t ?? null;
        x.Latitude = a.lat ?? null; x.Longitude = a.lon ?? null;
        x.AltitudeBaro = a.alt_baro ?? null; x.GroundSpeed = a.gs ?? null;
        x.Track = a.track ?? null; x.DbFlags = a.dbFlags ?? null;
        return x;
    }) : [];
    return r;
}

export class ADSBBeaconReaderService {
    #aircraft;    // readonly ObservableCollection<Aircraft>
    #getLocation; // Func<GeoPoint>
    #getRange;    // Func<int>
    #settings;    // ADSBBeaconReaderSettings
    #pollTimer;   // Timer
    #running = false;
    static #PositionMatchThresholdNM = 1.5;
    static #PositionMatchWithSquawkThresholdNM = 5.0;
    static #RevalidateThresholdNM = 5.0;
    static #AltitudeMatchThresholdFt = 500;
    static #AltitudeMatchWithSquawkThresholdFt = 1000;

    /// Non-discrete squawk codes per FAA JO 7110.66H (NBCAP) and JO 7110.65.
    static #NonDiscreteSquawks = ADSBBeaconReaderService.#BuildNonDiscreteSet();

    static #BuildNonDiscreteSet() {
        let set = new Set(); // HashSet<string>
        // 64 non-discrete codes: all codes ending in 00 (octal). xx00 = first two digits vary.
        for (let d1 = 0; d1 <= 7; d1++)
            for (let d2 = 0; d2 <= 7; d2++)
                set.add(`${d1}${d2}00`);
        // Conspicuity / special-use codes (FAA JO 7110.65 Ch5 S2)
        set.add("1200"); set.add("1202"); set.add("1203"); set.add("1255"); set.add("1277");
        set.add("2000"); set.add("4000"); set.add("7400"); set.add("7500"); set.add("7600");
        set.add("7700"); set.add("7777");
        // DC SFRA / FRZ codes (PCT allocation)
        set.add("1226"); set.add("5100"); set.add("5200");
        return set;
    }

    static #IsDiscreteSquawk(squawk) {
        return !(squawk == null || squawk === "") && !ADSBBeaconReaderService.#NonDiscreteSquawks.has(squawk);
    }
    static #RevalidateIntervalPolls = 3;
    // LogPath uses LocalApplicationData — no browser filesystem.
    static #Log(msg) { /* File.AppendAllText(LogPath, ...) -> no-op in the browser */ }

    // Track position-correlated assignments for re-validation
    #positionMatches = new Map(); // Dictionary<Aircraft, PositionMatch>
    #pollCount = 0;

    // SWIM-proof cache: stores ADSB-discovered callsigns so the render loop re-applies them.
    #laddCallsignCache = new Map(); // Dictionary<Aircraft, string>

    GetCachedCallsign(ac) {
        // lock (laddCallsignCache)
        return this.#laddCallsignCache.has(ac) ? this.#laddCallsignCache.get(ac) : null;
    }
    ClearCallsignCache() {
        // lock (laddCallsignCache)
        this.#laddCallsignCache.clear();
    }

    constructor(aircraft, getLocation, getRange, settings) {
        this.#aircraft = aircraft;
        this.#getLocation = getLocation;
        this.#getRange = getRange;
        this.#settings = settings;
    }

    Start() {
        if (this.#running) return;
        this.#running = true;
        this.#pollCount = 0;
        let interval = Math.max(3, this.#settings.PollIntervalSeconds) * 1000;
        this.#PollCallback(null); // dueTime 0 -> immediate
        this.#pollTimer = (typeof setInterval !== "undefined") ? setInterval(() => this.#PollCallback(null), interval) : 0;
        if (this.#pollTimer && this.#pollTimer.unref) this.#pollTimer.unref();
    }

    Stop() {
        this.#running = false;
        if (this.#pollTimer && typeof clearInterval !== "undefined") clearInterval(this.#pollTimer); // pollTimer?.Dispose()
        this.#pollTimer = null;
        // lock (positionMatches)
        this.#positionMatches.clear();
        this.ClearCallsignCache();
    }

    async #PollCallback(state) {
        if (!this.#running) return;
        try {
            let location = this.#getLocation();
            let range = this.#getRange();
            if (location == null || (location.Latitude === 0 && location.Longitude === 0))
                return;

            let enabledSources = this.#settings.Sources.filter(s => s.Enabled); // Where(...).ToList()
            ADSBBeaconReaderService.#Log(`Poll - ${enabledSources.length} sources, HideLADD=${this.#settings.HideLADDCallsigns}`);
            let allResults = []; // List<ADSBv2Aircraft>

            for (const source of enabledSources) {
                if (!this.#running) return;
                try {
                    let results = await this.#QuerySource(source, location, range);
                    if (results != null)
                        allResults.push(...results); // AddRange
                }
                catch (ex) {
                    console.log(`ADSB Beacon Reader: Error querying ${source.Name}: ${ex.message}`);
                }
                // Rate limit: 1 request per second per API
                if (enabledSources.indexOf(source) < enabledSources.length - 1)
                    await sleep(1100); // Thread.Sleep(1100)
            }

            if (allResults.length > 0)
                this.#MatchAndEnrich(allResults);

            // Re-validate position matches at a slower rate
            this.#pollCount++;
            if (this.#pollCount >= ADSBBeaconReaderService.#RevalidateIntervalPolls) {
                this.#pollCount = 0;
                if (allResults.length > 0)
                    this.#RevalidatePositionMatches(allResults);
            }
        }
        catch (ex) {
            console.log(`ADSB Beacon Reader: Poll error: ${ex.message}`);
        }
    }

    async #QuerySource(source, location, range) { // List<ADSBv2Aircraft>
        let url = `${source.BaseUrl.replace(/\/+$/, "")}/lat/${location.Latitude.toFixed(6)}/lon/${location.Longitude.toFixed(6)}/dist/${range}`;
        {
            // WebClient with Accept/User-Agent headers -> fetch
            let json = await (await fetch(url, { headers: { "Accept": "application/json", "User-Agent": "DGScope-BeaconReader" } })).text();
            let response = deserializeADSBv2Response(json);
            return response?.Aircraft;
        }
    }

    static #ParseAltitude(altBaro) { // int?
        if (altBaro == null) return null;
        if (typeof altBaro === "number") return Math.trunc(altBaro); // long/int/double
        let parsed = parseInt(altBaro.toString(), 10);
        if (!Number.isNaN(parsed)) return parsed;
        return null;
    }

    #RevalidatePositionMatches(latestResults) {
        // Build hex lookup (OrdinalIgnoreCase -> lowercased key)
        let adsbByHex = new Map(); // Dictionary<string, ADSBv2Aircraft>
        for (const ac of latestResults) {
            if (!(ac.Hex == null || ac.Hex === ""))
                adsbByHex.set(ac.Hex.toLowerCase(), ac);
        }

        let toRemove = null; // List<Aircraft>

        // lock (positionMatches)
        {
            for (const [radarAc, pm] of this.#positionMatches) {
                // If aircraft no longer has the callsign we assigned, someone else cleared it
                if (radarAc.Callsign !== pm.Callsign) {
                    if (toRemove == null) toRemove = [];
                    toRemove.push(radarAc);
                    continue;
                }
                // Find the ADSB target we matched against
                let adsbAc = adsbByHex.get(pm.AdsbHex.toLowerCase());
                if (adsbAc === undefined) {
                    // ADSB target no longer in range — clear the callsign
                    radarAc.Callsign = null;
                    if (toRemove == null) toRemove = [];
                    toRemove.push(radarAc);
                    continue;
                }
                // Check if the ADSB target has drifted away from the radar track
                if (adsbAc.Latitude != null && adsbAc.Longitude != null
                    && radarAc.Location != null && (radarAc.Latitude !== 0 || radarAc.Longitude !== 0)) {
                    let adsbPos = new GeoPoint(adsbAc.Latitude, adsbAc.Longitude);
                    let dist = adsbPos.DistanceTo(radarAc.Location);
                    if (dist > ADSBBeaconReaderService.#RevalidateThresholdNM) {
                        radarAc.Callsign = null;
                        if (toRemove == null) toRemove = [];
                        toRemove.push(radarAc);
                    }
                }
            }
            if (toRemove != null) {
                for (const ac of toRemove)
                    this.#positionMatches.delete(ac);
            }
        }
    }

    #MatchAndEnrich(results) {
        // Deduplicate ADSB results by hex (OrdinalIgnoreCase)
        let byHex = new Map(); // Dictionary<string, ADSBv2Aircraft>
        for (const ac of results) {
            if (!(ac.Hex == null || ac.Hex === ""))
                byHex.set(ac.Hex.toLowerCase(), ac);
        }

        // Snapshot the aircraft list
        let snapshot; // List<Aircraft>
        // lock (aircraft)
        snapshot = [...this.#aircraft]; // aircraft.ToList()

        let byModeS = new Map();          // Dictionary<int, Aircraft>
        let bySquawk = new Map();         // Dictionary<string, Aircraft>
        let duplicateSquawks = new Set(); // HashSet<string>
        let unmatched = [];               // List<Aircraft>

        for (const ac of snapshot) {
            if (ac.ModeSCode !== 0 && !byModeS.has(ac.ModeSCode))
                byModeS.set(ac.ModeSCode, ac);

            if (!(ac.Squawk == null || ac.Squawk === "")) {
                if (duplicateSquawks.has(ac.Squawk)) {
                    // Already known duplicate
                }
                else if (bySquawk.has(ac.Squawk)) {
                    bySquawk.delete(ac.Squawk);
                    duplicateSquawks.add(ac.Squawk);
                }
                else {
                    bySquawk.set(ac.Squawk, ac);
                }
            }

            let needsCallsign = (ac.Callsign == null || ac.Callsign === "")
                || (!(ac.Squawk == null || ac.Squawk === "") && ac.Callsign === ac.Squawk);
            if (needsCallsign && ac.Location != null
                && (ac.Latitude !== 0 || ac.Longitude !== 0)) {
                unmatched.push(ac);
            }
        }

        ADSBBeaconReaderService.#Log(`Radar: ${snapshot.length} aircraft, ${unmatched.length} need callsign, ${byModeS.size} in ModeS index, ${bySquawk.size} unique squawks`);

        let updates = [];            // List<KeyValuePair<Aircraft, string>>
        let newPositionMatches = []; // List<KeyValuePair<Aircraft, PositionMatch>>

        for (const adsbAc of byHex.values()) {
            let callsign = adsbAc.Flight?.trim();
            if (callsign == null || callsign === "")
                continue;

            // LADD filtering
            if (this.#settings.HideLADDCallsigns && adsbAc.IsLADD)
                continue;

            let matched = null;
            let matchedByPosition = false;
            let matchMethod = null;

            // Primary match: by Mode S hex code
            if (!(adsbAc.Hex == null || adsbAc.Hex === "")) {
                try {
                    let modeS = parseInt(adsbAc.Hex, 16); // Convert.ToInt32(Hex, 16)
                    if (Number.isNaN(modeS)) throw new Error("bad hex");
                    if (modeS !== 0 && byModeS.has(modeS)) { matched = byModeS.get(modeS); matchMethod = "hex"; }
                }
                catch (e) { }
            }

            // Secondary match: by unique discrete squawk
            if (matched == null && ADSBBeaconReaderService.#IsDiscreteSquawk(adsbAc.Squawk)) {
                if (bySquawk.has(adsbAc.Squawk)) { matched = bySquawk.get(adsbAc.Squawk); matchMethod = "squawk"; }
            }

            // Tertiary match: discrete squawk + relaxed position (for duplicate squawks)
            if (matched == null && ADSBBeaconReaderService.#IsDiscreteSquawk(adsbAc.Squawk)
                && duplicateSquawks.has(adsbAc.Squawk)
                && adsbAc.Latitude != null && adsbAc.Longitude != null) {
                let adsbPos = new GeoPoint(adsbAc.Latitude, adsbAc.Longitude);
                let adsbAlt = ADSBBeaconReaderService.#ParseAltitude(adsbAc.AltitudeBaro);
                let closest = null;
                let closestDist = ADSBBeaconReaderService.#PositionMatchWithSquawkThresholdNM;
                for (const ac of unmatched) {
                    if (ac.Squawk !== adsbAc.Squawk) continue;
                    if (adsbAlt != null && ac.PressureAltitude !== 0) {
                        if (Math.abs(adsbAlt - ac.PressureAltitude) > ADSBBeaconReaderService.#AltitudeMatchWithSquawkThresholdFt)
                            continue;
                    }
                    let dist = adsbPos.DistanceTo(ac.Location);
                    if (dist < closestDist) { closestDist = dist; closest = ac; }
                }
                matched = closest;
                matchedByPosition = matched != null;
                if (matched != null) matchMethod = `squawk+position(${closestDist.toFixed(2)}nm)`;
            }

            // Quaternary match: position-only with tight threshold
            if (matched == null && adsbAc.Latitude != null && adsbAc.Longitude != null) {
                let adsbPos = new GeoPoint(adsbAc.Latitude, adsbAc.Longitude);
                let adsbAlt = ADSBBeaconReaderService.#ParseAltitude(adsbAc.AltitudeBaro);
                let closest = null;
                let closestDist = ADSBBeaconReaderService.#PositionMatchThresholdNM;
                for (const ac of unmatched) {
                    if (adsbAlt != null && ac.PressureAltitude !== 0) {
                        if (Math.abs(adsbAlt - ac.PressureAltitude) > ADSBBeaconReaderService.#AltitudeMatchThresholdFt)
                            continue;
                    }
                    let dist = adsbPos.DistanceTo(ac.Location);
                    if (dist < closestDist) { closestDist = dist; closest = ac; }
                }
                matched = closest;
                matchedByPosition = matched != null;
                if (matched != null) matchMethod = `position(${closestDist.toFixed(2)}nm)`;
            }

            let callsignIsSquawk = matched != null && !(matched.Squawk == null || matched.Squawk === "")
                && matched.Callsign === matched.Squawk;
            let emptyCallsign = matched != null && (matched.Callsign == null || matched.Callsign === "");

            if (matched != null) {
                ADSBBeaconReaderService.#Log(`  ADSB ${adsbAc.Hex}/${adsbAc.Squawk}/${callsign} -> matched via ${matchMethod}, radar CS="${matched.Callsign}" SQ="${matched.Squawk}" FPC="${matched.FlightPlanCallsign}" emptyCS=${emptyCallsign} csIsSq=${callsignIsSquawk} enrich=${emptyCallsign || callsignIsSquawk}`);
            }

            if (matched != null && (emptyCallsign || callsignIsSquawk)) {
                updates.push({ Key: matched, Value: callsign });
                let idx = unmatched.indexOf(matched); if (idx >= 0) unmatched.splice(idx, 1); // unmatched.Remove(matched)

                if (matchedByPosition && !(adsbAc.Hex == null || adsbAc.Hex === "")) {
                    newPositionMatches.push({ Key: matched, Value: { Callsign: callsign, AdsbHex: adsbAc.Hex } });
                }
                // Cache LADD targets (callsign==squawk) for per-frame re-apply
                if (callsignIsSquawk) {
                    // lock (laddCallsignCache)
                    this.#laddCallsignCache.set(matched, callsign);
                }
            }
        }

        // Apply updates
        let laddCached = 0;
        laddCached = this.#laddCallsignCache.size; // lock (laddCallsignCache)
        ADSBBeaconReaderService.#Log(`Applying ${updates.length} updates (${laddCached} in LADD cache)`);
        for (const update of updates) {
            let ac = update.Key;
            let cs = update.Value;
            ADSBBeaconReaderService.#Log(`  SET ${ac.Squawk} -> CS="${cs}" (FPC was "${ac.FlightPlanCallsign}")`);
            ac.Callsign = cs;
            // Also set FlightPlanCallsign if empty or equal to squawk — FDB displays FPC.
            if ((ac.FlightPlanCallsign == null || ac.FlightPlanCallsign === "") || ac.FlightPlanCallsign === ac.Squawk)
                ac.FlightPlanCallsign = cs;
        }

        // Record position matches for future re-validation
        if (newPositionMatches.length > 0) {
            // lock (positionMatches)
            for (const pm of newPositionMatches)
                this.#positionMatches.set(pm.Key, pm.Value);
        }
    }
}

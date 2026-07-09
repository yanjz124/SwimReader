using Newtonsoft.Json;
using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Threading;

namespace DGScope.ADSBBeaconReader
{
    public class ADSBBeaconReaderService
    {
        private readonly ObservableCollection<Aircraft> aircraft;
        private readonly Func<GeoPoint> getLocation;
        private readonly Func<int> getRange;
        private readonly ADSBBeaconReaderSettings settings;
        private Timer pollTimer;
        private bool running;
        private const double PositionMatchThresholdNM = 1.5;
        private const double PositionMatchWithSquawkThresholdNM = 5.0;
        private const double RevalidateThresholdNM = 5.0;
        private const int AltitudeMatchThresholdFt = 500;
        private const int AltitudeMatchWithSquawkThresholdFt = 1000;

        /// <summary>
        /// Non-discrete squawk codes per FAA JO 7110.66H (NBCAP) and JO 7110.65.
        /// These are shared by multiple aircraft and unreliable for correlation.
        /// Includes: 64 non-discrete codes (xx00 octal pattern) plus
        /// conspicuity/special-use codes from 7110.65 Ch5 S2.
        /// </summary>
        private static readonly HashSet<string> NonDiscreteSquawks = BuildNonDiscreteSet();

        private static HashSet<string> BuildNonDiscreteSet()
        {
            var set = new HashSet<string>();
            // 64 non-discrete codes: all codes ending in 00 (octal).
            // Format is 4 octal digits (0-7 each). xx00 = first two digits vary.
            for (int d1 = 0; d1 <= 7; d1++)
                for (int d2 = 0; d2 <= 7; d2++)
                    set.Add($"{d1}{d2}00");

            // Conspicuity / special-use codes (FAA JO 7110.65 Ch5 S2)
            set.Add("1200"); // VFR
            set.Add("1202"); // SAR (USAF/USCG)
            set.Add("1203"); // VFR formation lead
            set.Add("1255"); // Firefighting
            set.Add("1277"); // SAR/glider
            set.Add("2000"); // IFR without discrete assignment
            set.Add("4000"); // Military VFR / special ops
            set.Add("7400"); // UAS lost link
            set.Add("7500"); // Hijack
            set.Add("7600"); // Radio failure
            set.Add("7700"); // Emergency
            set.Add("7777"); // Military intercept

            // DC SFRA / FRZ codes (PCT allocation)
            set.Add("1226"); // VFR direct to/from Leesburg JYO within SFRA
            set.Add("5100"); // PCT SFRA allocation
            set.Add("5200"); // PCT FRZ allocation
            return set;
        }

        private static bool IsDiscreteSquawk(string squawk)
        {
            return !string.IsNullOrEmpty(squawk) && !NonDiscreteSquawks.Contains(squawk);
        }
        private const int RevalidateIntervalPolls = 3;
        private static readonly string LogPath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "DGScope Profile Manager", "adsb_beacon_reader.log");

        private static void Log(string msg)
        {
            try { File.AppendAllText(LogPath, $"{DateTime.Now:HH:mm:ss} {msg}\r\n"); } catch { }
        }

        // Track position-correlated assignments for re-validation
        private readonly Dictionary<Aircraft, PositionMatch> positionMatches =
            new Dictionary<Aircraft, PositionMatch>();
        private int pollCount;

        // SWIM-proof cache: SWIM overwrites Callsign/FlightPlanCallsign for LADD aircraft.
        // This stores ADSB-discovered callsigns so the render loop can re-apply every frame.
        private readonly Dictionary<Aircraft, string> laddCallsignCache =
            new Dictionary<Aircraft, string>();

        public string GetCachedCallsign(Aircraft ac)
        {
            lock (laddCallsignCache)
                return laddCallsignCache.TryGetValue(ac, out var cs) ? cs : null;
        }

        public void ClearCallsignCache()
        {
            lock (laddCallsignCache)
                laddCallsignCache.Clear();
        }

        private class PositionMatch
        {
            public string Callsign;
            public string AdsbHex;
        }

        public ADSBBeaconReaderService(
            ObservableCollection<Aircraft> aircraft,
            Func<GeoPoint> getLocation,
            Func<int> getRange,
            ADSBBeaconReaderSettings settings)
        {
            this.aircraft = aircraft;
            this.getLocation = getLocation;
            this.getRange = getRange;
            this.settings = settings;
        }

        public void Start()
        {
            if (running) return;
            running = true;
            pollCount = 0;
            var interval = Math.Max(3, settings.PollIntervalSeconds) * 1000;
            pollTimer = new Timer(PollCallback, null, 0, interval);
        }

        public void Stop()
        {
            running = false;
            pollTimer?.Dispose();
            pollTimer = null;
            lock (positionMatches)
                positionMatches.Clear();
            ClearCallsignCache();
        }

        private void PollCallback(object state)
        {
            if (!running) return;

            try
            {
                var location = getLocation();
                var range = getRange();
                if (location == null || (location.Latitude == 0 && location.Longitude == 0))
                    return;

                var enabledSources = settings.Sources.Where(s => s.Enabled).ToList();
                Log($"Poll - {enabledSources.Count} sources, HideLADD={settings.HideLADDCallsigns}");
                var allResults = new List<ADSBv2Aircraft>();

                foreach (var source in enabledSources)
                {
                    if (!running) return;
                    try
                    {
                        var results = QuerySource(source, location, range);
                        if (results != null)
                            allResults.AddRange(results);
                    }
                    catch (Exception ex)
                    {
                        Debug.WriteLine($"ADSB Beacon Reader: Error querying {source.Name}: {ex.Message}");
                    }

                    // Rate limit: 1 request per second per API
                    if (enabledSources.IndexOf(source) < enabledSources.Count - 1)
                        Thread.Sleep(1100);
                }

                if (allResults.Count > 0)
                    MatchAndEnrich(allResults);

                // Re-validate position matches at a slower rate
                pollCount++;
                if (pollCount >= RevalidateIntervalPolls)
                {
                    pollCount = 0;
                    if (allResults.Count > 0)
                        RevalidatePositionMatches(allResults);
                }
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"ADSB Beacon Reader: Poll error: {ex.Message}");
            }
        }

        private List<ADSBv2Aircraft> QuerySource(ADSBSource source, GeoPoint location, int range)
        {
            var url = $"{source.BaseUrl.TrimEnd('/')}/lat/{location.Latitude:F6}/lon/{location.Longitude:F6}/dist/{range}";

            using (var client = new WebClient())
            {
                client.Headers.Add("Accept", "application/json");
                client.Headers.Add("User-Agent", "DGScope-BeaconReader");
                var json = client.DownloadString(url);
                var response = JsonConvert.DeserializeObject<ADSBv2Response>(json);
                return response?.Aircraft;
            }
        }

        private static int? ParseAltitude(object altBaro)
        {
            if (altBaro == null) return null;
            if (altBaro is long l) return (int)l;
            if (altBaro is int i) return i;
            if (altBaro is double d) return (int)d;
            if (int.TryParse(altBaro.ToString(), out int parsed)) return parsed;
            return null;
        }

        private void RevalidatePositionMatches(List<ADSBv2Aircraft> latestResults)
        {
            // Build hex lookup from latest ADSB data
            var adsbByHex = new Dictionary<string, ADSBv2Aircraft>(StringComparer.OrdinalIgnoreCase);
            foreach (var ac in latestResults)
            {
                if (!string.IsNullOrEmpty(ac.Hex))
                    adsbByHex[ac.Hex] = ac;
            }

            List<Aircraft> toRemove = null;

            lock (positionMatches)
            {
                foreach (var kvp in positionMatches)
                {
                    var radarAc = kvp.Key;
                    var pm = kvp.Value;

                    // If aircraft no longer has the callsign we assigned, someone else cleared it
                    if (radarAc.Callsign != pm.Callsign)
                    {
                        if (toRemove == null) toRemove = new List<Aircraft>();
                        toRemove.Add(radarAc);
                        continue;
                    }

                    // Find the ADSB target we matched against
                    if (!adsbByHex.TryGetValue(pm.AdsbHex, out var adsbAc))
                    {
                        // ADSB target no longer in range — clear the callsign
                        radarAc.Callsign = null;
                        if (toRemove == null) toRemove = new List<Aircraft>();
                        toRemove.Add(radarAc);
                        continue;
                    }

                    // Check if the ADSB target has drifted away from the radar track
                    if (adsbAc.Latitude.HasValue && adsbAc.Longitude.HasValue
                        && radarAc.Location != null && (radarAc.Latitude != 0 || radarAc.Longitude != 0))
                    {
                        var adsbPos = new GeoPoint(adsbAc.Latitude.Value, adsbAc.Longitude.Value);
                        var dist = adsbPos.DistanceTo(radarAc.Location);
                        if (dist > RevalidateThresholdNM)
                        {
                            // Positions have diverged — mismatch, clear callsign
                            radarAc.Callsign = null;
                            if (toRemove == null) toRemove = new List<Aircraft>();
                            toRemove.Add(radarAc);
                        }
                    }
                }

                if (toRemove != null)
                {
                    foreach (var ac in toRemove)
                        positionMatches.Remove(ac);
                }
            }
        }

        private void MatchAndEnrich(List<ADSBv2Aircraft> results)
        {
            // Deduplicate ADSB results by hex
            var byHex = new Dictionary<string, ADSBv2Aircraft>(StringComparer.OrdinalIgnoreCase);
            foreach (var ac in results)
            {
                if (!string.IsNullOrEmpty(ac.Hex))
                    byHex[ac.Hex] = ac;
            }

            // Snapshot the aircraft list and build lookup indices outside the lock
            List<Aircraft> snapshot;
            lock (aircraft)
            {
                snapshot = aircraft.ToList();
            }

            // Build O(1) lookup by ModeSCode
            var byModeS = new Dictionary<int, Aircraft>();
            // Build squawk lookup (only store if unique)
            var bySquawk = new Dictionary<string, Aircraft>(StringComparer.OrdinalIgnoreCase);
            var duplicateSquawks = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            // Collect unmatched aircraft with positions for position correlation
            var unmatched = new List<Aircraft>();

            foreach (var ac in snapshot)
            {
                if (ac.ModeSCode != 0 && !byModeS.ContainsKey(ac.ModeSCode))
                    byModeS[ac.ModeSCode] = ac;

                if (!string.IsNullOrEmpty(ac.Squawk))
                {
                    if (duplicateSquawks.Contains(ac.Squawk))
                    {
                        // Already known duplicate
                    }
                    else if (bySquawk.ContainsKey(ac.Squawk))
                    {
                        bySquawk.Remove(ac.Squawk);
                        duplicateSquawks.Add(ac.Squawk);
                    }
                    else
                    {
                        bySquawk[ac.Squawk] = ac;
                    }
                }

                bool needsCallsign = string.IsNullOrEmpty(ac.Callsign)
                    || (!string.IsNullOrEmpty(ac.Squawk) && ac.Callsign == ac.Squawk);
                if (needsCallsign && ac.Location != null
                    && (ac.Latitude != 0 || ac.Longitude != 0))
                {
                    unmatched.Add(ac);
                }
            }

            Log($"Radar: {snapshot.Count} aircraft, {unmatched.Count} need callsign, {byModeS.Count} in ModeS index, {bySquawk.Count} unique squawks");

            // Match and collect updates
            var updates = new List<KeyValuePair<Aircraft, string>>();
            var newPositionMatches = new List<KeyValuePair<Aircraft, PositionMatch>>();

            foreach (var adsbAc in byHex.Values)
            {
                var callsign = adsbAc.Flight?.Trim();
                if (string.IsNullOrEmpty(callsign))
                    continue;

                // LADD filtering
                if (settings.HideLADDCallsigns && adsbAc.IsLADD)
                    continue;

                Aircraft matched = null;
                bool matchedByPosition = false;
                string matchMethod = null;

                // Primary match: by Mode S hex code (O(1) dictionary lookup)
                if (!string.IsNullOrEmpty(adsbAc.Hex))
                {
                    try
                    {
                        int modeS = Convert.ToInt32(adsbAc.Hex, 16);
                        if (modeS != 0 && byModeS.TryGetValue(modeS, out matched))
                            matchMethod = "hex";
                    }
                    catch { }
                }

                // Secondary match: by unique discrete squawk (O(1) dictionary lookup)
                if (matched == null && IsDiscreteSquawk(adsbAc.Squawk))
                {
                    if (bySquawk.TryGetValue(adsbAc.Squawk, out matched))
                        matchMethod = "squawk";
                }

                // Tertiary match: discrete squawk + relaxed position (for duplicate squawks)
                // Squawk narrows candidates, position disambiguates with wider threshold
                if (matched == null && IsDiscreteSquawk(adsbAc.Squawk)
                    && duplicateSquawks.Contains(adsbAc.Squawk)
                    && adsbAc.Latitude.HasValue && adsbAc.Longitude.HasValue)
                {
                    var adsbPos = new GeoPoint(adsbAc.Latitude.Value, adsbAc.Longitude.Value);
                    int? adsbAlt = ParseAltitude(adsbAc.AltitudeBaro);
                    Aircraft closest = null;
                    double closestDist = PositionMatchWithSquawkThresholdNM;
                    foreach (var ac in unmatched)
                    {
                        if (ac.Squawk != adsbAc.Squawk) continue;
                        if (adsbAlt.HasValue && ac.PressureAltitude != 0)
                        {
                            if (Math.Abs(adsbAlt.Value - ac.PressureAltitude) > AltitudeMatchWithSquawkThresholdFt)
                                continue;
                        }
                        var dist = adsbPos.DistanceTo(ac.Location);
                        if (dist < closestDist)
                        {
                            closestDist = dist;
                            closest = ac;
                        }
                    }
                    matched = closest;
                    matchedByPosition = matched != null;
                    if (matched != null)
                        matchMethod = $"squawk+position({closestDist:F2}nm)";
                }

                // Quaternary match: position-only with tight threshold (no squawk info)
                if (matched == null && adsbAc.Latitude.HasValue && adsbAc.Longitude.HasValue)
                {
                    var adsbPos = new GeoPoint(adsbAc.Latitude.Value, adsbAc.Longitude.Value);
                    int? adsbAlt = ParseAltitude(adsbAc.AltitudeBaro);
                    Aircraft closest = null;
                    double closestDist = PositionMatchThresholdNM;
                    foreach (var ac in unmatched)
                    {
                        if (adsbAlt.HasValue && ac.PressureAltitude != 0)
                        {
                            if (Math.Abs(adsbAlt.Value - ac.PressureAltitude) > AltitudeMatchThresholdFt)
                                continue;
                        }
                        var dist = adsbPos.DistanceTo(ac.Location);
                        if (dist < closestDist)
                        {
                            closestDist = dist;
                            closest = ac;
                        }
                    }
                    matched = closest;
                    matchedByPosition = matched != null;
                    if (matched != null)
                        matchMethod = $"position({closestDist:F2}nm)";
                }

                bool callsignIsSquawk = matched != null && !string.IsNullOrEmpty(matched.Squawk)
                    && matched.Callsign == matched.Squawk;
                bool emptyCallsign = matched != null && string.IsNullOrEmpty(matched.Callsign);

                if (matched != null)
                {
                    Log($"  ADSB {adsbAc.Hex}/{adsbAc.Squawk}/{callsign} -> matched via {matchMethod}, " +
                        $"radar CS=\"{matched.Callsign}\" SQ=\"{matched.Squawk}\" FPC=\"{matched.FlightPlanCallsign}\" " +
                        $"emptyCS={emptyCallsign} csIsSq={callsignIsSquawk} enrich={emptyCallsign || callsignIsSquawk}");
                }

                if (matched != null && (emptyCallsign || callsignIsSquawk))
                {
                    updates.Add(new KeyValuePair<Aircraft, string>(matched, callsign));
                    unmatched.Remove(matched);

                    // Track position-correlated matches for re-validation
                    if (matchedByPosition && !string.IsNullOrEmpty(adsbAc.Hex))
                    {
                        newPositionMatches.Add(new KeyValuePair<Aircraft, PositionMatch>(
                            matched, new PositionMatch { Callsign = callsign, AdsbHex = adsbAc.Hex }));
                    }

                    // Cache LADD targets (callsign==squawk) for per-frame re-apply
                    if (callsignIsSquawk)
                    {
                        lock (laddCallsignCache)
                            laddCallsignCache[matched] = callsign;
                    }
                }
            }

            // Apply updates
            int laddCached = 0;
            lock (laddCallsignCache) laddCached = laddCallsignCache.Count;
            Log($"Applying {updates.Count} updates ({laddCached} in LADD cache)");
            foreach (var update in updates)
            {
                var ac = update.Key;
                var cs = update.Value;
                Log($"  SET {ac.Squawk} -> CS=\"{cs}\" (FPC was \"{ac.FlightPlanCallsign}\")");
                ac.Callsign = cs;
                // Also set FlightPlanCallsign if empty or equal to squawk —
                // FDB displays FlightPlanCallsign for correlated tracks.
                if (string.IsNullOrEmpty(ac.FlightPlanCallsign) || ac.FlightPlanCallsign == ac.Squawk)
                    ac.FlightPlanCallsign = cs;
            }

            // Record position matches for future re-validation
            if (newPositionMatches.Count > 0)
            {
                lock (positionMatches)
                {
                    foreach (var pm in newPositionMatches)
                        positionMatches[pm.Key] = pm.Value;
                }
            }
        }
    }
}

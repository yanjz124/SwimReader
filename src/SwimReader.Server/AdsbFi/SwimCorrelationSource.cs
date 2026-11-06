using System.Collections.Concurrent;
using System.Net.Http.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Logging;
using SwimReader.Core.Events;

namespace SwimReader.Server.AdsbFi;

/// <summary>
/// Correlation candidates drawn from SWIM itself, to name uncorrelated TRACON targets that ADS-B
/// coverage cannot.
///
/// <para><b>Why this exists.</b> The enrichment service only ever had one source of truth, a set
/// of public ADS-B APIs, and a target it could not find there stayed untagged. But we already hold
/// two sets of aircraft that are positively identified: every en-route SFDPS flight, and every
/// TRACON track that another facility has already correlated to a flight plan. Measured across 142
/// facilities and 14,148 untagged targets: a discrete beacon code plus a 5 NM / 1,000 ft gate names
/// <b>31.0%</b> from SFDPS and <b>24.6%</b> from another facility's tagged tracks, 10.9% match a
/// tagged track by Mode S outright, and the union is <b>38.6%</b>.</para>
///
/// <para><b>Two sources, acquired very differently.</b> The tagged-track half is free: the
/// enrichment service already receives every <see cref="TrackPositionEvent"/> and throws the
/// correlated ones away, so keeping them costs an index. The SFDPS half has to come over HTTP from
/// the SwimServer process, because a Solace queue is competing-consumers and a second subscriber
/// would <i>split</i> the feed rather than duplicate it (CLAUDE.md, SWIM_FEED_HOST). Subscribing
/// here would therefore take messages away from the scope that needs them.</para>
///
/// <para><b>Everything is a candidate, not an answer.</b> These entries are handed to the same
/// index and the same tiers as the ADS-B ones, so they inherit the gates, the
/// decline-on-ambiguity rule and the non-discrete beacon rule unchanged. That is the whole point of
/// shaping them as <see cref="AdsbFiAircraft"/>: no second matching path to keep in step.</para>
/// </summary>
public sealed class SwimCorrelationSource
{
    private readonly HttpClient _http;
    private readonly ILogger _logger;
    private readonly string _sfdpsUrl;

    /// <summary>Correlated TRACON tracks, keyed facility:trackNumber. Fed from the event stream.</summary>
    private readonly ConcurrentDictionary<string, FacilityTrack> _tagged = new();
    private long _namedTracks;

    private volatile IReadOnlyList<AdsbFiAircraft> _sfdps = Array.Empty<AdsbFiAircraft>();
    private DateTime _sfdpsAt;
    private string? _lastError;
    private long _sfdpsFetches, _sfdpsFailures;

    /// <summary>
    /// How long a tagged track stays a candidate after its last position. Deliberately short: a
    /// stale entry keeps a position that has stopped being true, and the squawk tier's whole job
    /// is to decide whether two positions are the same aircraft.
    /// </summary>
    private static readonly TimeSpan TaggedTtl = TimeSpan.FromMinutes(2);

    /// <summary>
    /// How old an SFDPS record may be and still be offered for a POSITION-gated match. SFDPS keeps
    /// a flight for 60 minutes after its last update, and at 450 kt a 2-minute-old position is
    /// 15 NM out — three times the squawk tier's gate — so an unfiltered list would hand the gate
    /// positions that are simply wrong. Mode S matching ignores this (see below).
    /// </summary>
    private const int SfdpsPositionMaxAgeSec = 60;

    public SwimCorrelationSource(HttpClient http, ILogger logger, string sfdpsBaseUrl)
    {
        _http = http;
        _logger = logger;
        _sfdpsUrl = sfdpsBaseUrl.TrimEnd('/') + "/api/enrich/aircraft";
    }

    /// <summary>
    /// One facility's view of one track. Position and identity arrive in SEPARATE events and are
    /// joined here on (facility, track number).
    ///
    /// <para>This is the whole reason the first version of this source held exactly one entry.
    /// <c>TrackPositionEvent.Callsign</c> looks like the obvious place to read a correlated
    /// callsign from and is almost always null — TAIS puts the callsign on the flight plan, and a
    /// live capture measured 14 of 1,237 track records carrying one. CLAUDE.md documents the same
    /// trap from the other direction, where the adapter published a callsign nothing read.</para>
    /// </summary>
    private sealed class FacilityTrack
    {
        public string? Callsign;
        public string? Facility;
        public int? ModeSCode;
        public string? Squawk;
        public double Lat, Lon;
        public int? AltFt;
        public bool HasPosition;
        public DateTime At;
    }

    private static string Key(string? facility, string? trackNumber)
        => (facility ?? "?") + ":" + (trackNumber ?? "?");

    /// <summary>Record where a track is. Called for every track, correlated or not: whether it is
    /// usable as evidence depends on a flight plan that may not have arrived yet.</summary>
    public void NotePosition(TrackPositionEvent track)
    {
        if (track.IsPseudo) return;      // military injection and friends are not evidence
        // GeoPosition is a struct, so "no position" arrives as 0,0 rather than null. An entry at
        // the origin sits in a cell no real traffic occupies and could only produce a false
        // match, so it is not evidence of anything.
        if (track.Position.Latitude == 0 && track.Position.Longitude == 0) return;
        var e = _tagged.GetOrAdd(Key(track.Facility, track.TrackNumber), _ => new FacilityTrack());
        lock (e)
        {
            e.Facility = track.Facility;
            e.ModeSCode = track.ModeSCode ?? e.ModeSCode;
            e.Squawk = track.Squawk ?? e.Squawk;
            e.Lat = track.Position.Latitude;
            e.Lon = track.Position.Longitude;
            e.AltFt = track.AltitudeFeet ?? e.AltFt;
            e.HasPosition = true;
            e.At = DateTime.UtcNow;
            if (!string.IsNullOrWhiteSpace(track.Callsign)) e.Callsign = track.Callsign.Trim();
        }
    }

    /// <summary>
    /// Record the callsign a facility has correlated to a track. This is where a tagged target's
    /// identity actually comes from.
    /// </summary>
    public void NoteFlightPlan(FlightPlanDataEvent fp)
    {
        // NEVER let our own output back in as evidence. An ADSB_ENRICH event carries a callsign
        // this service guessed; treating it as a correlated flight plan would let one guess
        // justify the next, and a wrong one would spread across facilities with no way back.
        if (fp.Source == "ADSB_ENRICH") return;
        if (string.IsNullOrWhiteSpace(fp.Callsign)) return;
        var e = _tagged.GetOrAdd(Key(fp.Facility, fp.TrackNumber), _ => new FacilityTrack());
        lock (e)
        {
            e.Callsign = fp.Callsign.Trim();
            e.Facility ??= fp.Facility;
            e.ModeSCode ??= fp.ModeSCode;
            e.At = DateTime.UtcNow;
        }
    }

    private sealed class EnrichRow
    {
        [JsonPropertyName("cs")] public string? Callsign { get; set; }
        [JsonPropertyName("hex")] public string? Hex { get; set; }
        [JsonPropertyName("sq")] public string? Squawk { get; set; }
        [JsonPropertyName("lat")] public double? Lat { get; set; }
        [JsonPropertyName("lon")] public double? Lon { get; set; }
        [JsonPropertyName("alt")] public int? Alt { get; set; }
        [JsonPropertyName("age")] public int Age { get; set; }
    }

    private sealed class EnrichPayload
    {
        [JsonPropertyName("aircraft")] public List<EnrichRow>? Aircraft { get; set; }
    }

    /// <summary>
    /// Pull the en-route picture from SwimServer. Fail-soft on purpose: that process restarts on
    /// every backend deploy, and enrichment losing one of three sources for a minute is not worth
    /// a log line per attempt, let alone an exception out of the worker loop.
    /// </summary>
    public async Task RefreshSfdpsAsync(CancellationToken ct)
    {
        try
        {
            var payload = await _http.GetFromJsonAsync<EnrichPayload>(_sfdpsUrl, ct);
            var rows = payload?.Aircraft;
            if (rows is null) return;
            var outp = new List<AdsbFiAircraft>(rows.Count);
            foreach (var r in rows)
            {
                if (string.IsNullOrWhiteSpace(r.Callsign)) continue;
                var hasHex = !string.IsNullOrWhiteSpace(r.Hex);
                // A record too old to trust for position is still perfectly good for a Mode S
                // match, which has no distance term at all — so it is kept, with its position
                // stripped so no gate can use it. Dropping it outright would throw away the one
                // tier that works best.
                var fresh = r.Age <= SfdpsPositionMaxAgeSec;
                if (!fresh && !hasHex) continue;
                outp.Add(new AdsbFiAircraft
                {
                    Hex = hasHex ? r.Hex!.Trim().ToUpperInvariant() : null,
                    Flight = r.Callsign!.Trim(),
                    Squawk = r.Squawk,
                    Lat = fresh ? r.Lat : null,
                    Lon = fresh ? r.Lon : null,
                    AltitudeOverrideFeet = fresh ? r.Alt : null,
                    SyntheticSource = "sfdps",
                });
            }
            _sfdps = outp;
            _sfdpsAt = DateTime.UtcNow;
            _lastError = null;
            Interlocked.Increment(ref _sfdpsFetches);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex)
        {
            Interlocked.Increment(ref _sfdpsFailures);
            if (_lastError != ex.Message)
            {
                _lastError = ex.Message;
                _logger.LogDebug("SFDPS correlation source unavailable: {Message}", ex.Message);
            }
        }
    }

    /// <summary>Everything SWIM can offer as a correlation candidate right now.</summary>
    public List<AdsbFiAircraft> Candidates()
    {
        var cutoff = DateTime.UtcNow - TaggedTtl;
        var outp = new List<AdsbFiAircraft>(_sfdps.Count + _tagged.Count);
        outp.AddRange(_sfdps);
        var named = 0;
        foreach (var kv in _tagged)
        {
            var e = kv.Value;
            string? cs; string? fac; int? ms; string? sq; double lat, lon; int? alt; bool pos; DateTime at;
            lock (e)
            {
                cs = e.Callsign; fac = e.Facility; ms = e.ModeSCode; sq = e.Squawk;
                lat = e.Lat; lon = e.Lon; alt = e.AltFt; pos = e.HasPosition; at = e.At;
            }
            if (at < cutoff) { _tagged.TryRemove(kv.Key, out _); continue; }
            // Only a track that is BOTH identified and located is evidence.
            if (string.IsNullOrEmpty(cs) || !pos) continue;
            named++;
            outp.Add(new AdsbFiAircraft
            {
                Hex = ms.HasValue ? ModeSCodeHelper.ToHexString(ms.Value) : null,
                Flight = cs,
                Squawk = sq,
                Lat = lat,
                Lon = lon,
                AltitudeOverrideFeet = alt,
                SyntheticSource = "tais",
                SyntheticFacility = fac,
            });
        }
        Interlocked.Exchange(ref _namedTracks, named);
        return outp;
    }

    public object Stats() => new
    {
        sfdpsAircraft = _sfdps.Count,
        sfdpsAgeSec = _sfdpsAt == default ? (int?)null : (int)(DateTime.UtcNow - _sfdpsAt).TotalSeconds,
        sfdpsFetches = Interlocked.Read(ref _sfdpsFetches),
        sfdpsFailures = Interlocked.Read(ref _sfdpsFailures),
        sfdpsLastError = _lastError,
        // Tracks held, versus the subset that is actually usable: identified AND located.
        // The gap between the two is the diagnostic — a large held count with a tiny named count
        // is the flight-plan join failing, which is exactly how this source first shipped broken.
        trackedFacilityTracks = _tagged.Count,
        namedFacilityTracks = Interlocked.Read(ref _namedTracks),
    };
}

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
    private readonly ConcurrentDictionary<string, TaggedTrack> _tagged = new();

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

    private sealed record TaggedTrack(
        string Callsign, string? Facility, int? ModeSCode, string? Squawk,
        double Lat, double Lon, int? AltFt, DateTime At);

    /// <summary>
    /// Remember a track that is already correlated, so it can name the same aircraft when a
    /// neighbouring facility sees it untagged. Called for every track the enrichment service
    /// decides it does not need to enrich.
    /// </summary>
    public void NoteTagged(TrackPositionEvent track)
    {
        if (string.IsNullOrWhiteSpace(track.Callsign)) return;
        if (track.IsPseudo) return;      // military injection and friends are not evidence
        // GeoPosition is a struct, so "no position" arrives as 0,0 rather than null. An entry at
        // the origin would sit in a cell no real traffic occupies and could only ever produce a
        // false match, so it is not evidence of anything.
        if (track.Position.Latitude == 0 && track.Position.Longitude == 0) return;
        var key = (track.Facility ?? "?") + ":" + track.TrackNumber;
        _tagged[key] = new TaggedTrack(
            track.Callsign.Trim(), track.Facility, track.ModeSCode, track.Squawk,
            track.Position.Latitude, track.Position.Longitude, track.AltitudeFeet,
            DateTime.UtcNow);
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
        foreach (var kv in _tagged)
        {
            var t = kv.Value;
            if (t.At < cutoff) { _tagged.TryRemove(kv.Key, out _); continue; }
            outp.Add(new AdsbFiAircraft
            {
                Hex = t.ModeSCode.HasValue ? ModeSCodeHelper.ToHexString(t.ModeSCode.Value) : null,
                Flight = t.Callsign,
                Squawk = t.Squawk,
                Lat = t.Lat,
                Lon = t.Lon,
                AltitudeOverrideFeet = t.AltFt,
                SyntheticSource = "tais",
                SyntheticFacility = t.Facility,
            });
        }
        return outp;
    }

    public object Stats() => new
    {
        sfdpsAircraft = _sfdps.Count,
        sfdpsAgeSec = _sfdpsAt == default ? (int?)null : (int)(DateTime.UtcNow - _sfdpsAt).TotalSeconds,
        sfdpsFetches = Interlocked.Read(ref _sfdpsFetches),
        sfdpsFailures = Interlocked.Read(ref _sfdpsFailures),
        sfdpsLastError = _lastError,
        taggedTracks = _tagged.Count,
    };
}

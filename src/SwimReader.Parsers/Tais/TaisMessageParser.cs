using System.Globalization;
using System.Xml.Linq;
using Microsoft.Extensions.Logging;
using SwimReader.Core.Events;
using SwimReader.Core.Models;

namespace SwimReader.Parsers.Tais;

/// <summary>
/// Parses TAIS TATrackAndFlightPlan messages into domain events.
/// Each message contains multiple record elements, each with track data
/// and optional flightPlan + enhancedData sections.
///
/// XML namespace: urn:us:gov:dot:faa:atm:terminal:entities:v4-0:tais:terminalautomationinformation
/// Root element: TATrackAndFlightPlan
/// </summary>
public sealed class TaisMessageParser : IStddsMessageParser
{
    private readonly ILogger<TaisMessageParser> _logger;

    public TaisMessageParser(ILogger<TaisMessageParser> logger)
    {
        _logger = logger;
    }

    public bool CanParse(string serviceType, XDocument doc)
    {
        if (!serviceType.Equals("TAIS", StringComparison.OrdinalIgnoreCase))
            return false;

        // Only handle TATrackAndFlightPlan messages, not TAStatus
        var rootName = doc.Root?.Name.LocalName;
        return rootName == "TATrackAndFlightPlan";
    }

    public IEnumerable<ISwimEvent> Parse(string serviceType, XDocument doc, DateTime receivedAt)
    {
        var root = doc.Root;
        if (root is null) yield break;

        var facility = root.Element("src")?.Value;

        foreach (var record in root.Elements("record"))
        {
            var track = record.Element("track");
            if (track is null) continue;
            // Skip records with no track number (match SwimServer's TaisBridge):
            // these are untracked/raw returns, not stable tracks. Emitting them
            // produced Mode-S- or "TN:fac:0"-keyed extras with no flight plan that
            // rendered as callsign-less duplicate targets.
            if (string.IsNullOrEmpty(track.Element("trackNum")?.Value)) continue;

            // Parse track position
            var trackEvent = ParseTrackPosition(track, facility, receivedAt);
            if (trackEvent is not null)
                yield return trackEvent;

            // Parse flight plan if present
            var flightPlan = record.Element("flightPlan");
            var enhanced = record.Element("enhancedData");
            if (flightPlan is not null)
            {
                var fpEvent = ParseFlightPlan(track, flightPlan, enhanced, facility, receivedAt);
                if (fpEvent is not null)
                    yield return fpEvent;
            }
        }
    }

    private TrackPositionEvent? ParseTrackPosition(XElement track, string? facility, DateTime receivedAt)
    {
        try
        {
            var latStr = track.Element("lat")?.Value;
            var lonStr = track.Element("lon")?.Value;

            if (latStr is null || lonStr is null)
                return null;

            if (!double.TryParse(latStr, CultureInfo.InvariantCulture, out var lat) ||
                !double.TryParse(lonStr, CultureInfo.InvariantCulture, out var lon))
                return null;

            var acAddress = track.Element("acAddress")?.Value;
            int? modeSCode = ParseModeSHex(acAddress);

            var status = track.Element("status")?.Value;

            // Compute ground speed from vx/vy components (in knots)
            int? groundSpeed = null;
            int? groundTrack = null;
            if (int.TryParse(track.Element("vx")?.Value, out var vx) &&
                int.TryParse(track.Element("vy")?.Value, out var vy))
            {
                var speedRaw = Math.Sqrt(vx * vx + vy * vy);
                groundSpeed = (int)Math.Round(speedRaw);
                if (speedRaw > 0)
                {
                    var heading = Math.Atan2(vx, vy) * 180.0 / Math.PI;
                    if (heading < 0) heading += 360;
                    groundTrack = (int)Math.Round(heading);
                }
            }

            var isFrozen = track.Element("frozen")?.Value == "1";
            var isPseudo = track.Element("pseudo")?.Value == "1";
            var adsbStr = track.Element("adsb")?.Value;
            bool? isAdsb = adsbStr is not null ? adsbStr == "1" : null;

            return new TrackPositionEvent
            {
                Timestamp = receivedAt,
                Source = "TAIS",
                Position = new GeoPosition(lat, lon),
                TrackNumber = track.Element("trackNum")?.Value,
                ModeSCode = modeSCode,
                Squawk = track.Element("reportedBeaconCode")?.Value,
                Callsign = null, // Callsign is in flightPlan, not track
                AltitudeFeet = ParseInt(track.Element("reportedAltitude")?.Value),
                AltitudeType = AltitudeType.True,
                GroundSpeedKnots = groundSpeed,
                GroundTrackDegrees = groundTrack,
                VerticalRateFpm = ParseInt(track.Element("vVert")?.Value),
                IsOnGround = null, // TAIS has no on-ground indicator
                IsFrozen = isFrozen,
                IsPseudo = isPseudo,
                IsAdsb = isAdsb,
                Facility = facility
            };
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Error parsing TAIS track position");
            return null;
        }
    }

    private FlightPlanDataEvent? ParseFlightPlan(
        XElement track, XElement fp, XElement? enhanced,
        string? facility, DateTime receivedAt)
    {
        try
        {
            var callsign = fp.Element("acid")?.Value;

            var acAddress = track.Element("acAddress")?.Value;
            int? modeSCode = ParseModeSHex(acAddress);

            return new FlightPlanDataEvent
            {
                Timestamp = receivedAt,
                Source = "TAIS",
                Callsign = callsign,
                TrackNumber = track.Element("trackNum")?.Value,
                ModeSCode = modeSCode,
                AircraftType = fp.Element("acType")?.Value,
                EquipmentSuffix = fp.Element("eqptSuffix")?.Value,
                FlightRules = fp.Element("flightRules")?.Value,
                Origin = enhanced?.Element("departureAirport")?.Value,
                Destination = enhanced?.Element("destinationAirport")?.Value,
                EntryFix = fp.Element("entryFix")?.Value,
                ExitFix = fp.Element("exitFix")?.Value,
                AssignedSquawk = fp.Element("assignedBeaconCode")?.Value,
                RequestedAltitude = ParseInt(fp.Element("requestedAltitude")?.Value),
                Runway = fp.Element("runway")?.Value,
                Scratchpad1 = fp.Element("scratchPad1")?.Value,
                Scratchpad2 = fp.Element("scratchPad2")?.Value,
                Owner = NullIfUnassigned(fp.Element("cps")?.Value),
                // TAIS does NOT publish <pendingHandoff>. The handoff state lives
                // in <ocr> (Operational Control Required), values observed in
                // captured XML: "no change", "pending", "normal handoff",
                // "intrafacility handoff". The RECEIVING sector is never
                // published in this feed — we can only signal "a handoff is
                // happening" and (downstream) infer direction from cps == me.
                //
                // For client-side compat with handoff.js which keys off
                // PendingHandoff being non-empty: set it to "?" placeholder
                // when a handoff is in progress so the data-block flash +
                // FDB promotion fire. When DGScope's verbatim
                // `PendingHandoff == ThisPositionIndicator` predicate runs
                // it returns false — we cannot detect INBOUND without the
                // receiver TCP, so the flash is a generic "something is
                // happening on this track" signal until we find a TAIS
                // extension or alt feed that carries the receiver field.
                HandoffOcr = NullIfEmpty(fp.Element("ocr")?.Value),
                IsHandoffInProgress = IsHandoffOcr(fp.Element("ocr")?.Value),
                PendingHandoff = IsHandoffOcr(fp.Element("ocr")?.Value) ? "?" : null,
                WakeCategory = NullIfEmpty(fp.Element("category")?.Value),
                LdrDirection = ParseLdrDirection(fp.Element("lld")?.Value),
                Facility = facility
            };
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Error parsing TAIS flight plan");
            return null;
        }
    }

    private static int? ParseModeSHex(string? hex)
    {
        if (string.IsNullOrEmpty(hex) || hex == "000000")
            return null;

        return int.TryParse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var code) && code > 0
            ? code
            : null;
    }

    private static int? ParseInt(string? value)
    {
        if (string.IsNullOrEmpty(value)) return null;
        return int.TryParse(value, out var i) ? i : null;
    }

    private static string? NullIfEmpty(string? value)
        => string.IsNullOrWhiteSpace(value) ? null : value;

    private static string? NullIfUnassigned(string? value)
        => value is null or "unassigned" ? null : value;

    /// <summary>
    /// TAIS &lt;ocr&gt; (Operational Control Required) → handoff-in-progress.
    /// "no change" is the idle / no-handoff state; everything else indicates
    /// a handoff is happening (pending, normal handoff, intrafacility
    /// handoff). The receiving sector is NOT published in this feed.
    /// </summary>
    private static bool IsHandoffOcr(string? ocr)
    {
        if (string.IsNullOrWhiteSpace(ocr)) return false;
        var v = ocr.Trim().ToLowerInvariant();
        // Empirically derived from tracking JIA5085 (DCA → BNA departure)
        // from 2300ft to FL259 — full 12-minute climb captured on 2026-06-24:
        //
        //   alt  2300ft  ocr="pending"          (handoff initiated)
        //   alt 13000ft  ocr="normal handoff"   ← TRANSITION (receiver accepted)
        //   alt 13000ft → FL259: stays "normal handoff" forever
        //
        // Interpretation:
        //   "pending"          — handoff REQUEST sent, receiver not yet accepted.
        //                        Controller's ACTION ITEM (flash + line-2 char).
        //   "normal handoff"   — receiver has ACCEPTED. Handoff executing /
        //                        track has been transferred. NOT an action item.
        //   "intrafacility handoff" — same post-acceptance state for intra.
        //   "no change"        — idle, no coordination event.
        //
        // Treating "normal handoff" as an in-progress action item kept the
        // handoff char visible from acceptance to coverage-exit (often 10+
        // minutes), making it look like the handoff "never went through".
        // Now only PENDING fires the in-progress display.
        //
        // "directed handoff" and "manual" retained as in-progress: they
        // indicate active forced/manual coordination events that controllers
        // do want to see.
        return v is "pending" or "directed handoff" or "manual";
    }

    /// <summary>
    /// Maps TAIS leader line direction string to DGScope LDRDirection enum value.
    /// NW=1, N=2, NE=3, W=4, E=6, SW=7, S=8, SE=9
    /// </summary>
    private static int? ParseLdrDirection(string? lld) => lld?.ToUpperInvariant() switch
    {
        "NW" => 1,
        "N" => 2,
        "NE" => 3,
        "W" => 4,
        "E" => 6,
        "SW" => 7,
        "S" => 8,
        "SE" => 9,
        _ => null
    };
}

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
                AltitudeType = AltitudeType.Pressure,
                GroundSpeedKnots = groundSpeed,
                GroundTrackDegrees = groundTrack,
                VerticalRateFpm = ParseInt(track.Element("vVert")?.Value),
                IsOnGround = status == "drop" ? null : (ParseInt(track.Element("reportedAltitude")?.Value) == 0),
                IsFrozen = isFrozen,
                IsPseudo = isPseudo,
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
                EquipmentSuffix = NullIfUnavailable(fp.Element("eqptSuffix")?.Value),
                FlightRules = fp.Element("flightRules")?.Value,
                Origin = enhanced?.Element("departureAirport")?.Value,
                Destination = enhanced?.Element("destinationAirport")?.Value,
                EntryFix = fp.Element("entryFix")?.Value,
                ExitFix = fp.Element("exitFix")?.Value,
                AssignedSquawk = fp.Element("assignedBeaconCode")?.Value,
                RequestedAltitude = ParseInt(fp.Element("requestedAltitude")?.Value),
                Runway = NullIfEmpty(fp.Element("runway")?.Value),
                Scratchpad1 = NullIfEmpty(fp.Element("scratchPad1")?.Value),
                Scratchpad2 = NullIfEmpty(fp.Element("scratchPad2")?.Value),
                Owner = fp.Element("cps")?.Value,
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

    private static string? NullIfUnavailable(string? value)
        => value is null or "unavailable" ? null : value;

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

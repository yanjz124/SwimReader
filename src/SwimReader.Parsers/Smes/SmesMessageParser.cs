using System.Globalization;
using System.Xml.Linq;
using Microsoft.Extensions.Logging;
using SwimReader.Core.Events;
using SwimReader.Core.Models;

namespace SwimReader.Parsers.Smes;

/// <summary>
/// Parses SMES (Surface Movement Event Service / ASDE-X) messages into SurfaceMovementEvents.
///
/// XML namespace: urn:us:gov:dot:faa:atm:terminal:entities:v4-0:smes:surfacemovementevent
///
/// Two root element types are published on the SMES topic:
///
///   asdexMsg — position reports for airport surface / terminal targets.
///     Contains one or more <positionReport> or <adsbReport> children.
///     Full reports (full="true") carry complete identity + state.
///     Partial reports (full="false") carry only changed fields.
///
///   SafetyLogicHoldBar — runway incursion hold bar status bitmap.
///     Not actionable for display; silently ignored.
///
/// Topic structure: SMES/all/false/{type}/{airport}/{tracon}
///   AT = all-targets batch (positionReport)
///   AD = ADS-B delta (adsbReport)
///   SE = surface event (positionReport subset)
///   SH = SafetyLogicHoldBar
/// </summary>
public sealed class SmesMessageParser : IStddsMessageParser
{
    private readonly ILogger<SmesMessageParser> _logger;

    public SmesMessageParser(ILogger<SmesMessageParser> logger)
    {
        _logger = logger;
    }

    public bool CanParse(string serviceType, XDocument doc)
    {
        if (!serviceType.Equals("SMES", StringComparison.OrdinalIgnoreCase))
            return false;

        var rootName = doc.Root?.Name.LocalName;
        return rootName == "asdexMsg"; // skip SafetyLogicHoldBar
    }

    public IEnumerable<ISwimEvent> Parse(string serviceType, XDocument doc, DateTime receivedAt)
    {
        var root = doc.Root;
        if (root is null) yield break;

        var airport = root.Element("airport")?.Value ?? "UNKN";

        // AT/SE messages: <positionReport full="true|false"> elements
        foreach (var report in root.Elements("positionReport"))
        {
            var evt = ParsePositionReport(report, airport, receivedAt);
            if (evt is not null) yield return evt;
        }

        // AD messages: <adsbReport full="true|false"> elements
        foreach (var report in root.Elements("adsbReport"))
        {
            var evt = ParseAdsbReport(report, airport, receivedAt);
            if (evt is not null) yield return evt;
        }
    }

    /// <summary>
    /// Parses <positionReport> elements (AT/SE topic type).
    /// Full reports have flightId, flightInfo, position, movement.
    /// Partial reports carry only updated fields.
    /// </summary>
    private SurfaceMovementEvent? ParsePositionReport(XElement report, string airport, DateTime receivedAt)
    {
        var isFull = report.Attribute("full")?.Value == "true";
        var trackId = report.Element("track")?.Value;
        if (trackId is null) return null;

        var timeStr = report.Element("time")?.Value;
        var timestamp = timeStr is not null && DateTime.TryParse(timeStr, null,
            DateTimeStyles.RoundtripKind, out var t) ? t : receivedAt;

        var pos = report.Element("position");
        if (!TryParseLatLon(pos, "latitude", "longitude", out var lat, out var lon))
            return null;

        var flightId = report.Element("flightId");
        var flightInfo = report.Element("flightInfo");
        var movement = report.Element("movement");
        var enhanced = report.Element("enhancedData");

        return new SurfaceMovementEvent
        {
            Timestamp = timestamp,
            Source = "SMES",
            Airport = airport,
            TrackId = trackId,
            IsFull = isFull,

            Callsign = flightId?.Element("aircraftId")?.Value,
            Squawk = flightId?.Element("mode3ACode")?.Value,
            AircraftType = flightInfo?.Element("acType")?.Value,
            TargetType = flightInfo?.Element("tgtType")?.Value,

            Position = new GeoPosition(lat, lon),
            AltitudeFeet = ParseDouble(pos?.Element("altitude")?.Value),

            GroundSpeedKnots = ParseInt(movement?.Element("speed")?.Value),
            HeadingDegrees = ParseDouble(movement?.Element("heading")?.Value),

            EramGufi = enhanced?.Element("eramGufi")?.Value,
        };
    }

    /// <summary>
    /// Parses <adsbReport> elements (AD topic type).
    /// Lighter-weight ADS-B delta updates; lat/lon use "lat"/"lon" element names.
    /// </summary>
    private SurfaceMovementEvent? ParseAdsbReport(XElement report, string airport, DateTime receivedAt)
    {
        var isFull = report.Attribute("full")?.Value == "true";
        var basicReport = report.Element("report")?.Element("basicReport");
        if (basicReport is null) return null;

        var trackId = basicReport.Element("track")?.Value;
        if (trackId is null) return null;

        var timeStr = basicReport.Element("time")?.Value;
        var timestamp = timeStr is not null && DateTime.TryParse(timeStr, null,
            DateTimeStyles.RoundtripKind, out var t) ? t : receivedAt;

        var pos = basicReport.Element("position");
        if (!TryParseLatLon(pos, "lat", "lon", out var lat, out var lon))
            return null;

        var velocity = basicReport.Element("velocity");
        var enhanced = report.Element("enhancedData");

        // adsbReports don't carry identity fields — those come from the paired positionReport
        return new SurfaceMovementEvent
        {
            Timestamp = timestamp,
            Source = "SMES",
            Airport = airport,
            TrackId = trackId,
            IsFull = isFull,

            Position = new GeoPosition(lat, lon),

            EramGufi = enhanced?.Element("eramGufi")?.Value,
        };
    }

    private static bool TryParseLatLon(XElement? pos, string latName, string lonName,
        out double lat, out double lon)
    {
        lat = lon = 0;
        if (pos is null) return false;
        return double.TryParse(pos.Element(latName)?.Value, NumberStyles.Float,
                   CultureInfo.InvariantCulture, out lat)
               && double.TryParse(pos.Element(lonName)?.Value, NumberStyles.Float,
                   CultureInfo.InvariantCulture, out lon);
    }

    private static int? ParseInt(string? value) =>
        int.TryParse(value, out var i) ? i : null;

    private static double? ParseDouble(string? value) =>
        double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out var d) ? d : null;
}

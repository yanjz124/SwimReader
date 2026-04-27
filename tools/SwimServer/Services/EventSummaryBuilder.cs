using System.Xml.Linq;

namespace SwimServer;

/// <summary>
/// Pure helpers that turn a SFDPS &lt;flight&gt; XML element into a short, human-readable
/// summary string for use in event logs. Also exposes formatting helpers used by
/// ProcessFlight (FormatUnit, WalkElements).
/// </summary>
static class EventSummaryBuilder
{
    public static string FormatUnit(XElement unit)
    {
        var id = unit.Attribute("unitIdentifier")?.Value ?? "";
        var sec = unit.Attribute("sectorIdentifier")?.Value ?? "";
        return string.IsNullOrEmpty(sec) ? id : $"{id}/{sec}";
    }

    public static void WalkElements(
        XElement el,
        string path,
        string source,
        System.Collections.Concurrent.ConcurrentDictionary<string, long> xmlElements)
    {
        var key = $"{path}";
        xmlElements.AddOrUpdate(key, 1, (_, v) => v + 1);

        // Also record attributes at this path
        foreach (var attr in el.Attributes())
        {
            var attrKey = $"{path}/@{attr.Name.LocalName}";
            xmlElements.AddOrUpdate(attrKey, 1, (_, v) => v + 1);
        }

        foreach (var child in el.Elements())
        {
            var childName = child.Name.LocalName;
            WalkElements(child, $"{path}/{childName}", source, xmlElements);
        }
    }

    public static string BuildEventSummary(string source, XElement flight)
    {
        return source switch
        {
            "TH" => "Track history update",
            "HZ" => BuildHzSummary(flight),
            "OH" => BuildOhSummary(flight),
            "FH" => BuildFhSummary(flight),
            "HP" => "Handoff proposal",
            "HU" => "Handoff update",
            "AH" => "Assumed/amended handoff",
            "HX" => "Handoff execution (route transfer)",
            "CL" => "Flight plan cancellation/clearance",
            "LH" => BuildLhSummary(flight),
            "NP" => "New flight plan",
            "PT" => BuildPtSummary(flight),
            "HT" => BuildPtSummary(flight),
            "DH" => "Departure handoff",
            "BA" => "Beacon code assignment",
            "RE" => "Beacon code reassignment",
            "RH" => "Radar handoff (drop)",
            "HV" => "Handoff void/complete",
            "HF" => "Handoff failure",
            _ => $"Message type: {source}"
        };
    }

    static string BuildHzSummary(XElement flight)
    {
        var pos = flight.Descendants().FirstOrDefault(e => e.Name.LocalName == "pos");
        var alt = flight.Elements().FirstOrDefault(e => e.Name.LocalName == "assignedAltitude");
        var altVal = alt?.Descendants().FirstOrDefault(e => e.Name.LocalName == "simple")?.Value;
        if (altVal is not null && double.TryParse(altVal, out var a))
            return $"Position update — assigned FL{a / 100:F0}";
        return "Position update";
    }

    static string BuildOhSummary(XElement flight)
    {
        var ho = flight.Descendants().FirstOrDefault(e => e.Name.LocalName == "handoff");
        if (ho is null) return "Handoff";
        var evt = ho.Attribute("event")?.Value ?? "";
        var recv = ho.Elements().FirstOrDefault(e => e.Name.LocalName == "receivingUnit");
        var xfer = ho.Elements().FirstOrDefault(e => e.Name.LocalName == "transferringUnit");
        return $"Handoff {evt}: {FormatUnit(xfer!)} → {FormatUnit(recv!)}";
    }

    static string BuildLhSummary(XElement flight)
    {
        var ia = flight.Elements().FirstOrDefault(e => e.Name.LocalName == "interimAltitude");
        XNamespace xsiNs2 = "http://www.w3.org/2001/XMLSchema-instance";
        if (ia is not null)
        {
            var isNil = string.Equals(ia.Attribute(xsiNs2 + "nil")?.Value, "true", StringComparison.OrdinalIgnoreCase)
                     || string.Equals(ia.Attribute("nil")?.Value, "true", StringComparison.OrdinalIgnoreCase);
            if (isNil) return "Interim altitude cleared (nil)";
            if (double.TryParse(ia.Value, out var alt))
                return $"Interim altitude set: {alt:F0} ft";
        }
        return "Local handoff / interim altitude cleared";
    }

    static string BuildFhSummary(XElement flight)
    {
        var parts = new List<string>();
        var ft = flight.Attribute("flightType")?.Value;
        if (ft is not null) parts.Add($"[{ft}]");

        var acType = flight.Descendants()
            .FirstOrDefault(e => e.Name.LocalName == "icaoModelIdentifier")?.Value;
        if (acType is not null) parts.Add(acType);

        var dep = flight.Elements().FirstOrDefault(e => e.Name.LocalName == "departure")
            ?.Attribute("departurePoint")?.Value;
        var arr = flight.Elements().FirstOrDefault(e => e.Name.LocalName == "arrival")
            ?.Attribute("arrivalPoint")?.Value;
        if (dep is not null || arr is not null)
            parts.Add($"{dep ?? "?"}-{arr ?? "?"}");

        var simple = flight.Descendants()
            .FirstOrDefault(e => e.Name.LocalName == "assignedAltitude")
            ?.Descendants().FirstOrDefault(e => e.Name.LocalName == "simple")?.Value;
        if (simple is not null && double.TryParse(simple, out var alt))
            parts.Add(alt >= 18000 ? $"FL{alt / 100:F0}" : $"{alt:F0}ft");

        var star = flight.Descendants()
            .FirstOrDefault(e => e.Name.LocalName == "nasadaptedArrivalRoute")
            ?.Attribute("nasRouteIdentifier")?.Value;
        if (star is not null) parts.Add(star);

        return parts.Count > 0 ? $"FP: {string.Join(" ", parts)}" : "Flight plan update";
    }

    static string BuildPtSummary(XElement flight)
    {
        var po = flight.Descendants().FirstOrDefault(e => e.Name.LocalName == "pointout");
        if (po is null) return "Point-out";
        var orig = po.Elements().FirstOrDefault(e => e.Name.LocalName == "originatingUnit");
        var recv = po.Elements().FirstOrDefault(e => e.Name.LocalName == "receivingUnit");
        if (orig is not null && recv is not null)
            return $"Point-out: {FormatUnit(orig)} → {FormatUnit(recv)}";
        return "Point-out";
    }
}

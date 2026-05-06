// Local test: parse a flightPlanInformation XML sample with our TfmsBridge
// Run: dotnet script parse-fpi.csx
// Reads /tmp/fpi.xml (downloaded from Pi)
// Uses System.Xml.Linq directly to verify field extraction matches the new parser logic.

using System.Xml.Linq;
using System.Globalization;

var xml = File.ReadAllText("/tmp/fpi.xml");
var msg = XElement.Parse(xml);
Console.WriteLine($"msgType: {msg.Attribute("msgType")?.Value}");
Console.WriteLine($"acid:    {msg.Attribute("acid")?.Value}");

var planInfo = msg.Elements().FirstOrDefault(e => e.Name.LocalName == "flightPlanInformation");
if (planInfo is null) { Console.WriteLine("No flightPlanInformation"); return; }

// Simulate the new parser logic
string? AltText(XElement block, string name)
{
    var el = block.Descendants().FirstOrDefault(e => e.Name.LocalName == name);
    if (el is null) return null;
    var simple = el.Descendants().FirstOrDefault(e => e.Name.LocalName == "simpleAltitude")?.Value;
    return !string.IsNullOrEmpty(simple) ? simple : el.Value;
}
int? AltFeet(XElement block, string name)
{
    var v = AltText(block, name);
    if (string.IsNullOrEmpty(v)) return null;
    var clean = new string(v.TrimEnd().TakeWhile(char.IsDigit).ToArray());
    return int.TryParse(clean, out var n) ? n * 100 : null;
}

Console.WriteLine($"\n— flightPlanInformation —");
Console.WriteLine($"requestedAltitude: {AltFeet(planInfo, "requestedAltitude")}");
Console.WriteLine($"assignedAltitude:  {AltFeet(planInfo, "assignedAltitude")}");

var tasStr = planInfo.Descendants().FirstOrDefault(e => e.Name.LocalName == "filedTrueAirSpeed")?.Value;
Console.WriteLine($"filedTAS:          {tasStr}");

var machStr = planInfo.Descendants().FirstOrDefault(e => e.Name.LocalName == "filedMach")?.Value;
Console.WriteLine($"filedMach:         {machStr}");

var specsEl = planInfo.Descendants().FirstOrDefault(e => e.Name.LocalName == "flightAircraftSpecs");
Console.WriteLine($"acType:            {specsEl?.Value}");
Console.WriteLine($"equipQualifier:    {specsEl?.Attribute("equipmentQualifier")?.Value}");

var routeEl = planInfo.Descendants().FirstOrDefault(e => e.Name.LocalName == "routeOfFlight");
Console.WriteLine($"routeOfFlight:     {routeEl?.Attribute("legacyFormat")?.Value}");

var coordPt = planInfo.Descendants().FirstOrDefault(e => e.Name.LocalName == "coordinationPoint");
var coordFix = coordPt?.Descendants().FirstOrDefault(e => e.Name.LocalName == "namedFix" || e.Name.LocalName == "fixRadialDistance" || e.Name.LocalName == "fix")?.Value
              ?? coordPt?.Value;
Console.WriteLine($"coordinationFix:   {coordFix}");

var coordTime = planInfo.Descendants().FirstOrDefault(e => e.Name.LocalName == "coordinationTime");
Console.WriteLine($"coordinationTime:  {coordTime?.Attribute("timeValue")?.Value ?? coordTime?.Value}");

// DP/STAR are inside ncsmRouteData
var ncsmRoute = planInfo.Elements().FirstOrDefault(e => e.Name.LocalName == "ncsmRouteData");
if (ncsmRoute is not null)
{
    var dp = ncsmRoute.Elements().FirstOrDefault(e => e.Name.LocalName == "dp");
    Console.WriteLine($"\n— ncsmRouteData —");
    Console.WriteLine($"dpName:            {dp?.Attribute("routeName")?.Value}");
    Console.WriteLine($"dpType:            {dp?.Attribute("routeType")?.Value}");
    Console.WriteLine($"dpTransitionFix:   {ncsmRoute.Elements().FirstOrDefault(e => e.Name.LocalName == "dpTransitionFix")?.Value}");
    var star = ncsmRoute.Elements().FirstOrDefault(e => e.Name.LocalName == "star");
    Console.WriteLine($"star:              {star?.Attribute("routeName")?.Value}");
    Console.WriteLine($"starTransitionFix: {ncsmRoute.Elements().FirstOrDefault(e => e.Name.LocalName == "starTransitionFix")?.Value}");
    var depFix = ncsmRoute.Elements().FirstOrDefault(e => e.Name.LocalName == "departureFixAndTime");
    Console.WriteLine($"departureFix:      {depFix?.Attribute("fixName")?.Value} @ {depFix?.Attribute("arrTime")?.Value}");
}

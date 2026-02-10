namespace SwimReader.Core.Models;

/// <summary>
/// Geographic position (WGS-84).
/// </summary>
public readonly record struct GeoPosition(double Latitude, double Longitude);

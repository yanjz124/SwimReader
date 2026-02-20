using SwimReader.Core.Models;

namespace SwimReader.Core.Events;

/// <summary>
/// Surface movement data from SMES (ASDE-X).
/// Tracks aircraft and vehicles on airport surface and in terminal airspace.
///
/// Emitted once per positionReport or adsbReport element in an asdexMsg.
/// Full reports (IsFull=true) carry complete identity and state; partial reports
/// carry only changed fields (callsign/type may be null).
/// </summary>
public sealed class SurfaceMovementEvent : ISwimEvent
{
    public required DateTime Timestamp { get; init; }
    public required string Source { get; init; }

    public required string Airport { get; init; }   // ICAO, e.g. KORD
    public required string TrackId { get; init; }   // ASDE-X track number

    // Identity — present on full reports, null on partial updates
    public string? Callsign { get; init; }
    public string? Squawk { get; init; }
    public string? AircraftType { get; init; }
    public string? TargetType { get; init; }        // "aircraft", "vehicle", "unknown"

    // Position — always present (events without lat/lon are not emitted)
    public required GeoPosition Position { get; init; }
    public double? AltitudeFeet { get; init; }

    // Movement
    public int? GroundSpeedKnots { get; init; }
    public double? HeadingDegrees { get; init; }

    // Cross-reference to SFDPS
    public string? EramGufi { get; init; }

    public bool IsFull { get; init; }
}

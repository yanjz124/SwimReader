using SwimReader.Core.Models;

namespace SwimReader.Core.Events;

/// <summary>
/// Surface movement data from SMES (ASDE-X).
/// Tracks aircraft and vehicles on airport surface.
/// </summary>
public sealed class SurfaceMovementEvent : ISwimEvent
{
    public required DateTime Timestamp { get; init; }
    public required string Source { get; init; }

    public string? TrackId { get; init; }
    public string? Callsign { get; init; }
    public string? Airport { get; init; }

    public required GeoPosition Position { get; init; }
    public int? GroundSpeedKnots { get; init; }
    public int? HeadingDegrees { get; init; }

    public string? TargetType { get; init; } // aircraft, vehicle, unknown
}

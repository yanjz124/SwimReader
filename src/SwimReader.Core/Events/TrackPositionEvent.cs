using SwimReader.Core.Models;

namespace SwimReader.Core.Events;

/// <summary>
/// Track position update from TAIS AIG200 or SMES data.
/// Maps to DGScope TrackUpdate (UpdateType 0).
/// </summary>
public sealed class TrackPositionEvent : ISwimEvent
{
    public required DateTime Timestamp { get; init; }
    public required string Source { get; init; }

    // Track identification
    public string? TrackNumber { get; init; }
    public int? ModeSCode { get; init; }
    public string? Squawk { get; init; }
    public string? Callsign { get; init; }

    // Position
    public required GeoPosition Position { get; init; }
    public int? AltitudeFeet { get; init; }
    public AltitudeType AltitudeType { get; init; } = AltitudeType.Unknown;

    // Kinematics
    public int? GroundSpeedKnots { get; init; }
    public int? GroundTrackDegrees { get; init; }
    public int? VerticalRateFpm { get; init; }

    // Status
    public bool? IsOnGround { get; init; }
    public bool? Ident { get; init; }
    public bool IsFrozen { get; init; }
    public bool IsPseudo { get; init; }

    // Source facility
    public string? Facility { get; init; }
}

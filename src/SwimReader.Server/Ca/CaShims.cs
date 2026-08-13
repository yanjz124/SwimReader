using System;
using System.Collections.Generic;

namespace SwimReader.Server.Ca;

// Minimal stand-ins for the DGScope types that ConflictAlertSystem references, so the engine
// itself can be a near-verbatim copy of DGScope's ConflictAlertSystem.cs. These are backed by
// the live STDDS/DGScope track stream (updated in DgScopeAdapter), not WPF/OpenGL objects.

public enum AltitudeType { Pressure, True, Unknown }

public class Altitude
{
    public int TrueAltitude { get; set; }
    public AltitudeType AltitudeType { get; set; } = AltitudeType.Unknown;
}

/// <summary>Unused for our feed (no rotating radar) — kept only so the engine's method
/// signatures stay identical to DGScope. SweptLocation just returns the current position.</summary>
public class Radar { }

/// <summary>Stand-in for DGScope's Aircraft, exposing only the members ConflictAlertSystem
/// touches. One instance per live DGScope-feed track; DgScopeAdapter keeps its fields current.</summary>
public class Aircraft
{
    public Guid Guid { get; set; }
    public bool Deleted { get; set; }
    public bool PrimaryOnly { get; set; }
    public Altitude Altitude { get; set; } = new();
    public int TrueAltitude => Altitude.TrueAltitude;
    public GeoPoint? Location { get; set; }
    public int GroundSpeed { get; set; }
    public int GroundTrack { get; set; }
    public bool Owned { get; set; }
    public bool Associated { get; set; }

    public bool ConflictAlert { get; set; }
    public bool ConflictAlertAcknowledged { get; set; }
    public List<Aircraft> ConflictingTracks { get; } = new();

    // MSAW state (mirrors DGScope Aircraft). LowAltitude drives the JS "LA" line-0 annotation.
    public bool IsOnGround { get; set; }
    public bool IsMSAWInhibited { get; set; }
    public bool LowAltitude { get; set; }
    public bool LowAltitudeAcknowledged { get; set; }

    public DateTime LastSeen { get; set; }

    // Our feed has no radar sweep, so the current position IS the swept position.
    public GeoPoint? SweptLocation(Radar radar) => Location;
    // We don't turn-project; the reported ground track is the extrapolation heading.
    public double ExtrapolateTrack() => GroundTrack;
}

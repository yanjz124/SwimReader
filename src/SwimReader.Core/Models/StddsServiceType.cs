namespace SwimReader.Core.Models;

/// <summary>
/// STDDS service types available through the SWIM SCDS subscription.
/// </summary>
public enum StddsServiceType
{
    Unknown = 0,
    TAIS,   // Terminal Automation Information Service (STARS track/FP data)
    TDES,   // Terminal Data Exchange Service (departure events)
    SMES,   // Surface Movement Event Service (ASDE-X)
    APDS,   // Aeronautical Product Distribution Service
    ISMC    // Information Service Management Center
}

/// <summary>
/// Altitude type classification matching DGScope's AltitudeType enum.
/// </summary>
public enum AltitudeType
{
    Pressure = 0,
    True = 1,
    Unknown = 2
}

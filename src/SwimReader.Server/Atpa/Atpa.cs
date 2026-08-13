using SwimReader.Server.Ca;

namespace SwimReader.Server.Atpa;

/// <summary>
/// Ported from DGScope's ATPA.cs. Holds the 7110.126B CWT required-separation table (leader category
/// → follower category → miles) and the facility's ATPA volumes, and runs each volume's in-trail
/// calculation. The Active setter's WPF reset is dropped (Calculate resets per pass); volumes are run
/// sequentially rather than via Task.WaitAll (the per-facility loop is already off the request path).
/// </summary>
public class Atpa
{
    // follower-category → (leader-category → required miles)
    public Dictionary<string, Dictionary<string, double>> RequiredSeparation { get; } = new();
    public List<ATPAVolume> Volumes { get; set; } = new();
    public bool Active { get; set; }

    public Atpa()
    {
        // 7110.126B CWT table (follower following leader → miles).
        RequiredSeparation["B"] = new() { { "A", 5 }, { "B", 3 }, { "D", 3 } };
        RequiredSeparation["C"] = new() { { "A", 6 }, { "B", 4 }, { "D", 4 } };
        RequiredSeparation["D"] = new() { { "A", 6 }, { "B", 4 }, { "D", 4 } };
        RequiredSeparation["E"] = new() { { "A", 7 }, { "B", 5 }, { "C", 3.5 }, { "D", 5 } };
        RequiredSeparation["F"] = new() { { "A", 7 }, { "B", 5 }, { "C", 3.5 }, { "D", 5 } };
        RequiredSeparation["G"] = new() { { "A", 7 }, { "B", 5 }, { "C", 3.5 }, { "D", 5 } };
        RequiredSeparation["H"] = new() { { "A", 8 }, { "B", 5 }, { "C", 5 }, { "D", 5 } };
        RequiredSeparation["I"] = new() { { "A", 8 }, { "B", 5 }, { "C", 5 }, { "D", 5 }, { "E", 4 } };
    }

    public void Calculate(ICollection<Aircraft> aircraftList, Radar radar)
    {
        List<Aircraft> aircraft;
        lock (aircraftList)
            aircraft = aircraftList.ToList();
        ATPAVolume[] vols;
        lock (Volumes)
            vols = Volumes.ToArray();
        foreach (var volume in vols)
            volume.CalculateATPA(aircraft, this, radar);
    }
}

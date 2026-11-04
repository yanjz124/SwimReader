namespace SwimReader.Server.AdsbFi;

/// <summary>
/// Which beacon codes may be used to correlate a radar track with an ADS-B target.
///
/// <para><b>Why this has to exist.</b> Callsign enrichment matched on <i>any</i> squawk that agreed
/// within a position and altitude gate. A non-discrete code is shared by many aircraft at once, so
/// in busy VFR airspace there are routinely several <c>1200</c> targets inside a 5 NM / 1,000 ft
/// box and "nearest one wins" assigns a callsign from whichever happened to be closest. That is
/// not a weak match, it is a wrong one — and the aircraft it mislabels are the ones a controller is
/// least able to identify by other means.</para>
///
/// <para>The emergency codes make it worse. <c>7700</c>, <c>7600</c> and <c>7500</c> are
/// non-discrete too, so an emergency aircraft could be given a bystander's callsign.</para>
///
/// <para>Ported from the <c>ADSBBeaconReader</c> receiver in the DGScope branch, which gets this
/// right. Sources: FAA JO 7110.66 (National Beacon Code Allocation Plan) for the reserved blocks,
/// JO 7110.65 Ch.5 S.2 for the conspicuity and special-purpose codes.</para>
/// </summary>
public static class BeaconCodes
{
    private static readonly HashSet<string> NonDiscrete = Build();

    private static HashSet<string> Build()
    {
        var set = new HashSet<string>(StringComparer.Ordinal);

        // Every code ending in 00 — 64 of them. Beacon codes are octal, so the last two digits
        // run 0-7 and "x x 0 0" is the block-boundary code of each of the 64 blocks. These are
        // handed out as non-discrete by design.
        for (int d1 = 0; d1 <= 7; d1++)
            for (int d2 = 0; d2 <= 7; d2++)
                set.Add($"{d1}{d2}00");

        // Conspicuity / special-purpose (JO 7110.65 Ch.5 S.2).
        set.Add("1200"); // VFR
        set.Add("1202"); // SAR (USAF/USCG)
        set.Add("1203"); // VFR formation lead
        set.Add("1255"); // Firefighting
        set.Add("1277"); // SAR / glider
        set.Add("2000"); // IFR with no discrete assignment
        set.Add("4000"); // Military VFR / special operations
        set.Add("7400"); // UAS lost link
        set.Add("7500"); // Hijack
        set.Add("7600"); // Radio failure
        set.Add("7700"); // Emergency
        set.Add("7777"); // Military intercept

        // DC SFRA / FRZ allocations (PCT). Shared within the SFRA, so same problem.
        set.Add("1226"); // VFR direct to/from Leesburg (JYO) inside the SFRA
        set.Add("5100"); // PCT SFRA allocation
        set.Add("5200"); // PCT FRZ allocation

        return set;
    }

    /// <summary>
    /// True when this code identifies ONE aircraft and may therefore be correlated on. A null,
    /// empty or non-discrete code returns false — and the caller must then fall back to a tighter
    /// position/altitude gate rather than simply matching anyway.
    /// </summary>
    public static bool IsDiscrete(string? squawk) =>
        !string.IsNullOrEmpty(squawk) && !NonDiscrete.Contains(squawk);

    /// <summary>Exposed for tests, which pin the block-boundary and conspicuity sets.</summary>
    public static int NonDiscreteCount => NonDiscrete.Count;
}

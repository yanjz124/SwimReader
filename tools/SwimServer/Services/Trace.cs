namespace SwimServer;

/// <summary>
/// Opt-in tracing for the per-message investigation output ([CLR], [INTERIM], [HOLDBAR]) that was
/// added while working out how SFDPS signals clearance and interim-altitude changes.
///
/// Left always-on it writes a line per event — on the deployed Pi that was a meaningful share of a
/// journal filling 500 MB every ~33 minutes, which left no history to diagnose anything after the
/// fact (and is constant SD-card wear on a machine that reboots occasionally).
///
/// Enable per category with SWIM_TRACE, e.g. SWIM_TRACE=CLR,INTERIM or SWIM_TRACE=all.
/// </summary>
static class Trace
{
    private static readonly HashSet<string> _on =
        new((Environment.GetEnvironmentVariable("SWIM_TRACE") ?? "")
                .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries),
            StringComparer.OrdinalIgnoreCase);

    private static readonly bool _all = _on.Contains("all");

    public static bool On(string category) => _all || _on.Contains(category);

    /// <summary>Writes "[CATEGORY] message" only when that category is enabled.</summary>
    public static void Write(string category, string message)
    {
        if (On(category)) Console.WriteLine($"[{category}] {message}");
    }
}

using System.Text.Json;

namespace SwimServer;

/// <summary>
/// SimBrief's shared "Variant or Airframe" list (Fenix A321 CFM, FSLabs A321-211 CFM, iFly 737 MAX 8,
/// …) for the Route Finder, so a variant can be chosen on our page and passed to SimBrief as its
/// <c>type</c> — SimBrief accepts an airframe's internal ID (e.g. "80_1722529640343") there. Choosing
/// the variant up front matters because switching variants inside SimBrief reloads that airframe's
/// defaults and wipes the registration / SELCAL / Mode-S the Route Finder pre-filled.
///
/// Source: SimBrief's public https://www.simbrief.com/api/inputs.airframes.json (~1 MB, every type).
/// Fetched server-side and cached, so browsers only ever download the few variants for one type.
/// </summary>
static class SimbriefRoutes
{
    private const string Url = "https://www.simbrief.com/api/inputs.airframes.json";
    private static readonly TimeSpan Ttl = TimeSpan.FromHours(12);
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(40) };
    private static readonly SemaphoreSlim Gate = new(1, 1);
    private static Dictionary<string, List<object>>? _byType;
    private static DateTime _fetchedUtc = DateTime.MinValue;

    public static void Register(WebApplication app, ServerContext ctx)
    {
        // GET /api/simbrief/airframes/{type} → [{ id, label, name, engines, isDefault }]
        //   id is what SimBrief's `type` parameter takes: the plain ICAO for the default variant,
        //   the airframe internal ID ("pilot_airframe") for a shared one. Unknown type → [].
        app.MapGet("/api/simbrief/airframes/{type}", async (string type) =>
        {
            var map = await GetMap();
            if (map is null) return Results.Problem("SimBrief airframe list unavailable", statusCode: 502);
            var list = map.TryGetValue(type.Trim().ToUpperInvariant(), out var v) ? v : new List<object>();
            return Results.Json(list, ctx.JsonOpts);
        });
    }

    private static async Task<Dictionary<string, List<object>>?> GetMap()
    {
        if (_byType is not null && DateTime.UtcNow - _fetchedUtc < Ttl) return _byType;
        await Gate.WaitAsync();
        try
        {
            if (_byType is not null && DateTime.UtcNow - _fetchedUtc < Ttl) return _byType;
            try
            {
                using var req = new HttpRequestMessage(HttpMethod.Get, Url);
                req.Headers.UserAgent.ParseAdd("SwimReader-RouteFinder/1.0");
                using var resp = await Http.SendAsync(req);
                resp.EnsureSuccessStatusCode();
                await using var s = await resp.Content.ReadAsStreamAsync();
                using var doc = await JsonDocument.ParseAsync(s);
                _byType = Parse(doc.RootElement);
                _fetchedUtc = DateTime.UtcNow;
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[SIMBRIEF] airframe list fetch failed: {ex.Message}");
                // Keep serving a stale copy rather than nothing; retry in 10 min instead of hammering.
                if (_byType is not null) _fetchedUtc = DateTime.UtcNow - Ttl + TimeSpan.FromMinutes(10);
            }
            return _byType;
        }
        finally { Gate.Release(); }
    }

    private static Dictionary<string, List<object>> Parse(JsonElement root)
    {
        static string S(JsonElement e, string k) =>
            e.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";

        var map = new Dictionary<string, List<object>>(StringComparer.OrdinalIgnoreCase);
        foreach (var t in root.EnumerateObject())
        {
            if (!t.Value.TryGetProperty("airframes", out var afs) || afs.ValueKind != JsonValueKind.Array) continue;
            var list = new List<object>();
            foreach (var a in afs.EnumerateArray())
            {
                var id = S(a, "airframe_internal_id");
                if (id.Length == 0) continue;
                bool isDefault = !id.Contains('_');                  // default variant's id is the bare ICAO
                var comments = S(a, "airframe_comments");
                var name = S(a, "airframe_name");
                list.Add(new
                {
                    id,
                    label = isDefault ? $"Default — {name}" : (comments.Length > 0 ? comments : name),
                    name,
                    engines = S(a, "airframe_engines"),
                    isDefault,
                });
            }
            if (list.Count > 0) map[t.Name] = list;
        }
        Console.WriteLine($"[SIMBRIEF] airframe list: {map.Count} types, {map.Values.Sum(l => l.Count)} variants");
        return map;
    }
}

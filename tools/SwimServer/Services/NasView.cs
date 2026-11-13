using System.Text.Json;

namespace SwimServer;

/// <summary>
/// One client's view of the fused picture: the viewport and filters it asked for, plus a record
/// of what it has already been told.
///
/// <para>Separated from <see cref="NasStream"/>'s socket plumbing because <b>every rule in here
/// is invisible from a browser</b>. A viewport that silently matches nothing across the
/// antimeridian, a truncation that returns a different subset each tick, an identity update that
/// never reaches the client — each of those renders as a map that is merely a bit odd, and none
/// of them throws or moves a counter. The socket layer around this is trivial by comparison.</para>
/// </summary>
class NasView
{
    /// <summary>Default per-client target cap. ~3,000 canvas triangles is comfortable; the
    /// payload at that size is ~120 kB raw, ~17 kB deflated.</summary>
    public const int DefaultCap = 3000;
    public const int MaxCap = 10000;

    // Viewport. Defaults to the whole world, so a client that never sends a view still sees
    // something rather than nothing.
    public double South = -90, West = -180, North = 90, East = 180;
    public int Cap = DefaultCap;
    public HashSet<NasClass>? Classes;
    public string? Text;

    /// <summary>First payload is a labeled snapshot rather than an "add everything" delta.</summary>
    public bool First = true;

    // Per entity: a hash of the volatile fields and a hash of the identity, kept apart so an
    // ordinary position update costs seven numbers while a target that gains a callsign is
    // re-sent in full.
    private readonly Dictionary<long, (int Vol, int Ident)> _sent = new();

    public int Tracked => _sent.Count;

    /// <summary>
    /// Apply a <c>{cmd:"view", ...}</c> message. Returns false for anything it cannot use, which
    /// the caller ignores — a malformed command must never kill the socket, because a socket that
    /// dies on bad input looks exactly like a server that stopped responding.
    /// </summary>
    public bool Apply(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return false;
            if (!root.TryGetProperty("cmd", out var cmd) || cmd.GetString() != "view") return false;

            if (root.TryGetProperty("bbox", out var bb) && bb.ValueKind == JsonValueKind.Array
                && bb.GetArrayLength() == 4
                && bb[0].TryGetDouble(out var s) && bb[1].TryGetDouble(out var w)
                && bb[2].TryGetDouble(out var n) && bb[3].TryGetDouble(out var e)
                // A nonsense box leaves the previous one in place rather than blanking the map.
                && double.IsFinite(s) && double.IsFinite(w) && double.IsFinite(n) && double.IsFinite(e)
                && n > s)
            {
                South = Math.Max(-90, s); North = Math.Min(90, n);
                West = Math.Max(-180, w); East = Math.Min(180, e);
            }

            if (root.TryGetProperty("cap", out var cap) && cap.TryGetInt32(out var capv))
                Cap = Math.Clamp(capv, 100, MaxCap);

            // An absent or empty class list means "no class filter". An explicit empty array is
            // treated the same way on purpose: a client that unchecks everything gets the
            // unfiltered picture rather than a blank screen it cannot explain.
            Classes = null;
            if (root.TryGetProperty("cls", out var cls) && cls.ValueKind == JsonValueKind.Array)
            {
                var set = new HashSet<NasClass>();
                foreach (var el in cls.EnumerateArray())
                    if (Enum.TryParse<NasClass>(el.GetString(), true, out var k)) set.Add(k);
                if (set.Count > 0) Classes = set;
            }

            Text = root.TryGetProperty("q", out var q) ? q.GetString()?.Trim() : null;
            if (string.IsNullOrEmpty(Text)) Text = null;
            return true;
        }
        catch (JsonException) { return false; }
        catch (InvalidOperationException) { return false; }
    }

    /// <summary>
    /// Work out what to send this client for the given snapshot, and record it. Returns null when
    /// there is nothing to say — which is most ticks for a still viewport, and is the whole
    /// reason this is a delta stream rather than a snapshot one.
    /// </summary>
    public NasPayload? Compute(NasSnapshot snap)
    {
        var inView = new List<NasEntity>(Math.Min(Cap * 2, 4096));
        var matched = 0;
        foreach (var e in snap.Entities.Values)
        {
            if (!e.Positioned) continue;
            if (e.Lat < South || e.Lat > North) continue;
            if (!LonInRange(e.Lon, West, East)) continue;
            if (Classes is not null && !Classes.Contains(e.Cls)) continue;
            if (Text is not null && !Matches(e, Text)) continue;
            matched++;
            inView.Add(e);
        }

        // Truncate deterministically: identified traffic first, then by id. Sorting by id rather
        // than taking whatever the dictionary yielded is what keeps the SAME targets from tick to
        // tick — an arbitrary subset would make a third of the screen blink at 0.5 Hz, which
        // reads as a broken renderer rather than as a limit being applied.
        if (inView.Count > Cap)
        {
            inView.Sort(static (a, b) =>
            {
                var pa = Priority(a.Cls); var pb = Priority(b.Cls);
                return pa != pb ? pa - pb : a.Id.CompareTo(b.Id);
            });
            inView.RemoveRange(Cap, inView.Count - Cap);
        }

        var adds = new List<object[]>();
        var upds = new List<object[]>();
        var keep = new HashSet<long>(inView.Count);
        foreach (var e in inView)
        {
            keep.Add(e.Id);
            var vol = VolatileHash(e);
            var ident = e.IdentityHash();
            if (!_sent.TryGetValue(e.Id, out var prev)) adds.Add(e.ToAdd());
            else if (prev.Ident != ident) adds.Add(e.ToAdd());   // upsert: who it is changed
            else if (prev.Vol != vol) upds.Add(e.ToDelta());
            _sent[e.Id] = (vol, ident);
        }

        List<long>? dels = null;
        foreach (var id in _sent.Keys)
            if (!keep.Contains(id)) (dels ??= new()).Add(id);
        if (dels is not null) foreach (var id in dels) _sent.Remove(id);

        var first = First;
        First = false;
        if (!first && adds.Count == 0 && upds.Count == 0 && dels is null) return null;

        return new NasPayload
        {
            Type = first ? "snapshot" : "delta",
            Ts = snap.Built.ToString("o"),
            Add = adds.Count > 0 ? adds : null,
            Upd = upds.Count > 0 ? upds : null,
            Del = dels,
            // The honest count, so the UI can say "showing 3,000 of 17,500" instead of
            // presenting a capped view as the whole sky.
            Shown = inView.Count,
            Matched = matched,
            Truncated = matched > inView.Count,
            Total = snap.Stats.Total,
            Classes = ClassCounts(snap.Stats),
        };
    }

    /// <summary>
    /// Longitude ranges wrap. A viewport straddling the antimeridian arrives with west &gt; east
    /// (Leaflet reports e.g. 170 → −170), and a plain <c>lon &gt;= w &amp;&amp; lon &lt;= e</c>
    /// then matches <b>nothing at all</b> — over the one stretch of the map where a NAS view
    /// legitimately spans the date line, which is the Pacific, which is where Anchorage and
    /// Honolulu traffic lives. An empty Pacific looks exactly like a quiet Pacific.
    /// </summary>
    internal static bool LonInRange(double lon, double w, double e) =>
        w <= e ? lon >= w && lon <= e : lon >= w || lon <= e;

    /// <summary>
    /// Which targets survive the cap first. Identified traffic beats uncorrelated, and the
    /// primary-only noise floor goes last — at continental zoom it is ~20% of everything and the
    /// least useful thing on the screen.
    /// </summary>
    internal static int Priority(NasClass c) => c switch
    {
        NasClass.EnRoute => 0,
        NasClass.Terminal => 1,
        NasClass.Surface => 2,
        NasClass.Untagged => 3,
        NasClass.Vehicle => 4,
        NasClass.Primary => 5,
        _ => 6,
    };

    /// <summary>
    /// The volatile fields, hashed, so an unchanged target costs nothing.
    ///
    /// <para>Position is rounded to the same five decimal places the wire form sends. Hashing the
    /// raw double instead would mark every target changed on every tick from movement below the
    /// precision actually transmitted — a delta stream that sends everything, every time, while
    /// looking like it is working.</para>
    /// </summary>
    internal static int VolatileHash(NasEntity e)
    {
        var h = new HashCode();
        h.Add((long)Math.Round(e.Lat * 100000));
        h.Add((long)Math.Round(e.Lon * 100000));
        h.Add(e.AltFt ?? 0);
        h.Add(e.Trk ?? 0);
        h.Add(e.Gs ?? 0);
        h.Add((int)e.Cls);
        return h.ToHashCode();
    }

    /// <summary>
    /// Free-text match over the fields someone actually searches a map by. <c>KJFK</c> finds both
    /// arrivals and departures; <c>KJFK-KLAX</c> or <c>KJFK&gt;KLAX</c> finds one city pair,
    /// which is a different question and needs its own syntax rather than matching any flight
    /// that merely touches either airport.
    /// </summary>
    internal static bool Matches(NasEntity e, string q)
    {
        var sep = q.IndexOfAny(new[] { '-', '>' });
        if (sep > 0)
        {
            var a = q[..sep].Trim();
            var b = q[(sep + 1)..].Trim();
            if (a.Length > 0 && b.Length > 0) return Has(e.Origin, a) && Has(e.Dest, b);
            // A half-typed pair - "KJFK-" on the way to "KJFK-KLAX" - must not blank the map
            // for a keystroke. Match the part that IS typed, plainly; the pair rule takes over
            // as soon as the second airport has a character in it.
            if (a.Length > 0) q = a;
        }
        return Has(e.Callsign, q) || Has(e.Type, q) || Has(e.Origin, q) || Has(e.Dest, q)
            || Has(e.Registration, q) || Has(e.Owner, q) || Has(e.Airport, q)
            || Has(e.Facility, q) || Has(e.Squawk, q) || Has(e.ModeS, q);
    }

    private static bool Has(string? field, string q) =>
        field is not null && field.Contains(q, StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// National per-class counts, so the legend can report how much traffic exists and not only
    /// how much fits in the viewport. Free: the pass already counted them.
    /// </summary>
    private static Dictionary<string, int> ClassCounts(NasFusionStats st) => new()
    {
        ["EnRoute"] = st.Of(NasClass.EnRoute),
        ["Terminal"] = st.Of(NasClass.Terminal),
        ["Surface"] = st.Of(NasClass.Surface),
        ["Vehicle"] = st.Of(NasClass.Vehicle),
        ["Untagged"] = st.Of(NasClass.Untagged),
        ["Primary"] = st.Of(NasClass.Primary),
    };
}

/// <summary>One tick's message to one client. Property names are the wire names.</summary>
class NasPayload
{
    public string Type { get; init; } = "delta";
    public string Ts { get; init; } = "";
    public List<object[]>? Add { get; init; }
    public List<object[]>? Upd { get; init; }
    public List<long>? Del { get; init; }
    public int Shown { get; init; }
    public int Matched { get; init; }
    public bool Truncated { get; init; }
    public int Total { get; init; }
    public Dictionary<string, int>? Classes { get; init; }
}

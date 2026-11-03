using System.Collections.Concurrent;
using System.Globalization;
using System.Xml.Linq;
using SolaceSystems.Solclient.Messaging;
using SwimServer;

/// <summary>
/// TBFM (Time Based Flow Management) metering ingestion, for the ERAM scope's STA and DELAY RDBs.
///
/// Source is the TBFM Metering Information Service (TBFM MIS) on its own SCDS subscription — NOT one
/// of the five feeds the rest of the server consumes; none of those carry TBFM schedules. Disabled
/// (silently) until <c>TBFM_USER</c> is set.
///
/// Message shape (TBFM MIS, namespace urn:us:gov:dot:faa:atm:tfm:tbfmmeteringpublication):
/// <code>
///   &lt;env envSrce="TMA.ZOB.FAA.GOV" envTime="..."&gt;
///     &lt;tma msgId="..." msgTime="..."&gt;
///       &lt;air airType="AMD" aid="DAL1900" dap="SAN" apt="DTW" tmaId="C01213" gufi="KL737432HU"&gt;
///         &lt;sta&gt;&lt;mfx&gt;HAYLL&lt;/mfx&gt;&lt;sta_sfx&gt;..&lt;/sta_sfx&gt;&lt;sta_dfx&gt;..&lt;/sta_dfx&gt;&lt;sta_rwy&gt;..&lt;/sta_rwy&gt;&lt;/sta&gt;
///         &lt;eta&gt;&lt;eta_sfx&gt;..&lt;/eta_sfx&gt;&lt;eta_dfx&gt;..&lt;/eta_dfx&gt;&lt;eta_mfx&gt;..&lt;/eta_mfx&gt;&lt;eta_rwy&gt;..&lt;/eta_rwy&gt;&lt;/eta&gt;
/// </code>
/// Verified against the live feed (2026-11-02). ETA and STA usually arrive in SEPARATE messages,
/// so the merge across messages matters. gufi is ERAM's short form (KK756252Wv), which SFDPS does
/// NOT carry (its GUFIs are UUID / us.fdps.*), so the scope matches by callsign + destination.
/// Airports come without the K. Other meter points (oma/ooa/o3a/o4a arcs) are published too but unused.
/// <see cref="DebugSnapshot"/> keeps raw samples plus every element name seen (<c>GET /api/tbfm/debug</c>).
///
/// Messages are partial updates, so every field merges (non-null overwrite) onto the record.
/// </summary>
class TbfmBridge
{
    private readonly string _user, _pass, _queue, _host, _vpn;

    // key (envSrce/tmaId, or aid/apt) → flight
    private readonly ConcurrentDictionary<string, TbfmFlight> _flights = new();

    // Verification aids — the field mapping is partly unconfirmed (see class summary).
    private readonly ConcurrentQueue<string> _samples = new();
    private const int MaxSamples = 20;
    private readonly ConcurrentDictionary<string, long> _elementCounts = new();
    private long _msgCount, _airCount, _unparsed;

    private static readonly string[] Arcs = { "oma", "ooa", "o3a", "o4a" };

    private static readonly TimeSpan StaleAfter = TimeSpan.FromMinutes(20);
    private static readonly TimeSpan KeepPastSta = TimeSpan.FromMinutes(10);

    public bool Configured => !string.IsNullOrEmpty(_user);
    public long MessageCount => Interlocked.Read(ref _msgCount);
    public int FlightCount => _flights.Count;

    public TbfmBridge(string user, string pass, string queue, string host, string vpn)
    {
        _user = user; _pass = pass; _queue = queue; _host = host; _vpn = vpn;
    }

    public void Start()
    {
        var receivers = SolaceTuning.Receivers("TBFM_FLOWS", 1);
        for (int i = 0; i < receivers; i++)
        {
            var idx = i;
            new Thread(() => Run(idx)) { IsBackground = true, Name = $"TbfmReceiver{idx}" }.Start();
        }
        if (receivers > 1) Console.WriteLine($"[TBFM] {receivers} receivers on the queue");
    }

    // Transport runs per receiver; processing is serialised (same rule as every other bridge).
    private readonly object _processGate = new();

    private void Run(int receiverIndex)
    {
        if (!Configured)
        {
            Console.WriteLine("[TBFM] No credentials configured — TBFM disabled");
            return;
        }
        while (true)
        {
            try
            {
                using var context = ContextFactory.Instance.CreateContext(new ContextProperties(), null);
                var sessionProps = new SessionProperties
                {
                    Host = _host, VPNName = _vpn, UserName = _user, Password = _pass,
                    ReconnectRetries = 100, ReconnectRetriesWaitInMsecs = 5000,
                    SSLValidateCertificate = false,
                    CompressionLevel = 1,  // FAA SCDS requires compressed data
                    SocketReceiveBufferSizeInBytes = SolaceTuning.ReceiveBufferBytes
                };
                using var session = context.CreateSession(sessionProps, null,
                    (_, e) => Console.WriteLine($"[TBFM] {e.Event} - {e.Info}"));

                if (session.Connect() != ReturnCode.SOLCLIENT_OK)
                {
                    Console.Error.WriteLine("[TBFM] connect failed, retrying in 10s");
                    Thread.Sleep(10000);
                    continue;
                }
                Console.WriteLine("[TBFM] Connected to TBFM");

                var solQueue = ContextFactory.Instance.CreateQueue(_queue);
                using var flow = session.CreateFlow(
                    SolaceTuning.Flow(), solQueue, null,
                    (_, msgArgs) =>
                    {
                        using var m = msgArgs.Message;
                        using var _h = FeedHealth.Track("TBFM", m);
                        try
                        {
                            string? body = null;
                            if (m.BinaryAttachment is { Length: > 0 } ba)
                                body = System.Text.Encoding.UTF8.GetString(ba);
                            else if (m.XmlContent is { Length: > 0 } xc)
                                body = System.Text.Encoding.UTF8.GetString(xc);
                            if (string.IsNullOrWhiteSpace(body)) return;
                            lock (_processGate) Process(body!);
                        }
                        catch (Exception ex) { Console.Error.WriteLine("[TBFM] parse: " + ex.Message); }
                    },
                    (_, __) => { });
                flow.Start();
                Console.WriteLine($"[TBFM] Listening on queue {_queue}");

                while (true) Thread.Sleep(60000);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("[TBFM] session error: " + ex.Message + " — reconnecting in 10s");
                Thread.Sleep(10000);
            }
        }
    }

    // ── Parsing ──────────────────────────────────────────────────────────────

    /// <summary>Parse one TBFM MIS message. Public so tests can drive it without Solace.</summary>
    public void Process(string xml)
    {
        Interlocked.Increment(ref _msgCount);

        XElement root;
        try { root = XElement.Parse(xml); }
        catch { Interlocked.Increment(ref _unparsed); return; }

        KeepSample(root);

        foreach (var e in root.DescendantsAndSelf())
            _elementCounts.AddOrUpdate(e.Name.LocalName, 1, (_, n) => n + 1);

        var envSrce = FindAncestorOrSelfAttr(root, "env", "envSrce");
        var now = DateTime.UtcNow;

        foreach (var air in root.DescendantsAndSelf().Where(e => e.Name.LocalName == "air"))
        {
            Interlocked.Increment(ref _airCount);
            var aid = Attr(air, "aid") ?? Text(air, "aid");
            if (string.IsNullOrWhiteSpace(aid)) continue;
            aid = aid.Trim().ToUpperInvariant();

            var tmaId = Attr(air, "tmaId");
            var apt = Attr(air, "apt") ?? Text(air, "apt");
            var src = FindAncestorOrSelfAttr(air, "env", "envSrce") ?? envSrce;

            var key = !string.IsNullOrEmpty(tmaId)
                ? $"{src ?? "?"}/{tmaId}"
                : $"{aid}/{apt ?? "?"}";

            var f = _flights.GetOrAdd(key, _ => new TbfmFlight { Key = key, Aid = aid });
            f.Aid = aid;
            Merge(ref f.TmaId, tmaId);
            Merge(ref f.Source, src);
            Merge(ref f.Gufi, Attr(air, "gufi"));
            Merge(ref f.Arrival, NormalizeAirport(apt));
            Merge(ref f.Departure, NormalizeAirport(Attr(air, "dap") ?? Text(air, "dap")));
            Merge(ref f.AirType, Attr(air, "airType"));
            Merge(ref f.MeterFix, Text(air, "mfx"));
            Merge(ref f.Runway, Text(air, "rwy"));
            // Meter-fix times. Live TBFM MIS has no sta_mfx: the meter-fix STA comes as
            // sta_sfx / sta_dfx (equal in every sample seen), with the matching ETA as
            // eta_sfx / eta_dfx. eta_mfx is also published but can differ from eta_sfx by
            // ~1 min, so prefer the sfx pair and STA - ETA compares one point with itself.
            bool timed = false;
            timed |= MergeTime(ref f.EtaMeterFix, Time(air, "eta_sfx", "eta_dfx", "eta_mfx"));
            timed |= MergeTime(ref f.StaMeterFix, Time(air, "sta_sfx", "sta_dfx", "sta_mfx"));
            timed |= MergeTime(ref f.EtaRunway, Time(air, "eta_rwy", "etaRwy"));
            timed |= MergeTime(ref f.StaRunway, Time(air, "sta_rwy", "staRwy"));
            // Meter arcs upstream of the meter fix (outer meter arc, outer-outer, 3rd, 4th), each
            // with its own STA/ETA. Which one a given sector actually sees is site adaptation that
            // SWIM doesn't publish, so they are exposed as data rather than picked here.
            foreach (var arc in Arcs)
            {
                var sta = Time(air, "sta_" + arc);
                var eta = Time(air, "eta_" + arc);
                if (sta is null && eta is null) continue;
                timed = true;
                var cur = f.ArcTimes.TryGetValue(arc, out var c) ? c : (null, null);
                f.ArcTimes[arc] = (sta ?? cur.Sta, eta ?? cur.Eta);
            }
            f.LastSeen = now;
            // Expiry keys on this, not LastSeen: TBFM keeps sending route-only <flt> updates for a
            // flight whose schedule has long passed (seen live: GLH3, STA = ETA 40 min in the
            // past, "updated" 4 min ago), and those must not keep a dead time on the scope.
            if (timed) f.TimesSeen = now;
        }
    }

    /// <summary>
    /// Keep a raw sample for /api/tbfm/debug with LADD-blocked aircraft removed first. The debug
    /// route is as reachable as everything else behind the gate, so it must not leak an aircraft
    /// the scope endpoint hides.
    /// </summary>
    private void KeepSample(XElement root)
    {
        var copy = new XElement(root);
        foreach (var air in copy.DescendantsAndSelf().Where(e => e.Name.LocalName == "air").ToList())
        {
            var aid = Attr(air, "aid") ?? Text(air, "aid");
            if (LaddService.IsBlocked(aid?.Trim().ToUpperInvariant(), null)) air.Remove();
        }
        var xml = copy.ToString(SaveOptions.DisableFormatting);
        _samples.Enqueue(xml.Length > 8000 ? xml[..8000] + "…(truncated)" : xml);
        while (_samples.Count > MaxSamples && _samples.TryDequeue(out _)) { }
    }

    private static void Merge(ref string? field, string? v)
    {
        if (!string.IsNullOrWhiteSpace(v)) field = v.Trim();
    }

    private static bool MergeTime(ref DateTime? field, DateTime? v)
    {
        if (!v.HasValue) return false;
        field = v;
        return true;
    }

    private static string? Attr(XElement e, string name) =>
        e.Attributes().FirstOrDefault(a => a.Name.LocalName == name)?.Value;

    /// <summary>
    /// First non-empty leaf text for the given local names, tried in the order given (so the
    /// first name wins even when a later one appears earlier in the document).
    /// </summary>
    private static string? Text(XElement parent, params string[] names)
    {
        foreach (var name in names)
            foreach (var e in parent.Descendants())
            {
                if (e.Name.LocalName != name || e.HasElements) continue;
                var t = e.Value.Trim();
                if (t.Length > 0) return t;
            }
        return null;
    }

    private static DateTime? Time(XElement parent, params string[] names) => ParseTime(Text(parent, names));

    internal static DateTime? ParseTime(string? s)
    {
        if (string.IsNullOrWhiteSpace(s)) return null;
        return DateTime.TryParse(s, CultureInfo.InvariantCulture,
            DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var t)
            ? DateTime.SpecifyKind(t, DateTimeKind.Utc)
            : null;
    }

    private static string? FindAncestorOrSelfAttr(XElement e, string elemName, string attr)
    {
        // envSrce sits on <env>, which is the root or an ancestor of <air>. Also accept it on the
        // root element under another name (some publications put the envelope on the document root).
        foreach (var a in e.AncestorsAndSelf())
            if (a.Name.LocalName == elemName && Attr(a, attr) is { } v) return v;
        foreach (var d in e.DescendantsAndSelf())
            if (d.Name.LocalName == elemName && Attr(d, attr) is { } v) return v;
        return null;
    }

    private static string? NormalizeAirport(string? a)
    {
        if (string.IsNullOrWhiteSpace(a)) return null;
        a = a.Trim().ToUpperInvariant();
        // KDCA → DCA, to match the destination the ERAM scope shows (FAA LID). PANC/PHNL keep 4.
        return a.Length == 4 && a[0] == 'K' ? a[1..] : a;
    }

    // ── Maintenance / queries ────────────────────────────────────────────────

    public void PurgeStale()
    {
        var now = DateTime.UtcNow;
        foreach (var (k, f) in _flights)
        {
            var sta = f.StaMeterFix ?? f.StaRunway;
            if (now - f.LastSeen > StaleAfter || (sta.HasValue && now - sta.Value > KeepPastSta))
                _flights.TryRemove(k, out _);
        }
    }

    /// <summary>
    /// Compact per-flight metering records for the ERAM scope. LADD aircraft are dropped: the scope
    /// matches by callsign, and returning a blocked callsign here would expose it.
    /// </summary>
    public object[] EramSnapshot()
    {
        var now = DateTime.UtcNow;
        return _flights.Values
            .Where(f => !LaddService.IsBlocked(f.Aid, null))
            .Select(f => (f, mfxDone: Passed(f.StaMeterFix, f.TimesSeen, now), rwyDone: Passed(f.StaRunway, f.TimesSeen, now)))
            .Where(x => (x.f.StaMeterFix.HasValue && !x.mfxDone) || (x.f.StaRunway.HasValue && !x.rwyDone))
            .Select(x => (object)new
            {
                aid = x.f.Aid,
                gufi = x.f.Gufi,
                apt = x.f.Arrival,
                src = x.f.Source,
                ctr = CenterOf(x.f.Source),
                mfx = x.f.MeterFix,
                rwy = x.f.Runway,
                staMfx = x.mfxDone ? null : x.f.StaMeterFix,
                etaMfx = x.mfxDone ? null : x.f.EtaMeterFix,
                staRwy = x.rwyDone ? null : x.f.StaRunway,
                etaRwy = x.rwyDone ? null : x.f.EtaRunway,
                arcs = ArcsJson(x.f, now),
                ageSec = (int)(now - x.f.TimesSeen).TotalSeconds,   // since the last schedule update
            })
            .ToArray();
    }

    /// <summary>Arc STA/ETA pairs still ahead of the flight, keyed oma/ooa/o3a/o4a; null when none.</summary>
    private static Dictionary<string, object>? ArcsJson(TbfmFlight f, DateTime now)
    {
        Dictionary<string, object>? d = null;
        foreach (var (arc, t) in f.ArcTimes)
        {
            if (t.Sta is null || Passed(t.Sta, f.TimesSeen, now)) continue;
            (d ??= new())[arc] = new { sta = t.Sta, eta = t.Eta };
        }
        return d;
    }

    /// <summary>
    /// A scheduled time is "done" once it is more than a minute past and TBFM has not updated the
    /// record since. Measured live: after a flight's meter-fix STA passes, the time since the
    /// record's last time update grows in step with it (median 3.1 / 4.8 / 6.9 min at 0-2 / 2-5 /
    /// 5-10 min past STA), i.e. TBFM stops publishing once the flight reaches the point. A late
    /// flight TBFM is still revising keeps updating, so it is not hidden.
    /// </summary>
    private static bool Passed(DateTime? sta, DateTime lastSeen, DateTime now)
    {
        if (!sta.HasValue) return false;
        var grace = sta.Value.AddSeconds(60);
        return now > grace && lastSeen < grace;
    }

    /// <summary>"TMA.ZLC.FAA.GOV" → "ZLC": the ARTCC whose TBFM published (and whose controllers see) it.</summary>
    internal static string? CenterOf(string? envSrce)
    {
        if (string.IsNullOrWhiteSpace(envSrce)) return null;
        var parts = envSrce.Split('.');
        var id = parts.Length >= 2 && parts[0].Equals("TMA", StringComparison.OrdinalIgnoreCase) ? parts[1] : parts[0];
        return id.ToUpperInvariant();
    }

    /// <summary>For verifying the field mapping against the live feed.</summary>
    public object DebugSnapshot() => new
    {
        configured = Configured,
        messages = MessageCount,
        airRecords = Interlocked.Read(ref _airCount),
        unparsed = Interlocked.Read(ref _unparsed),
        flights = FlightCount,
        withSta = _flights.Values.Count(f => f.StaMeterFix.HasValue || f.StaRunway.HasValue),
        elements = _elementCounts.OrderByDescending(kv => kv.Value)
            .ToDictionary(kv => kv.Key, kv => kv.Value),
        samples = _samples.ToArray(),
    };
}

class TbfmFlight
{
    public string Key = "";
    public string Aid = "";
    public string? TmaId, Source, Gufi, Arrival, Departure, AirType, MeterFix, Runway;
    public DateTime? EtaMeterFix, StaMeterFix, EtaRunway, StaRunway;
    // Written on the feed thread, read by API requests: concurrent, so enumeration can't throw.
    public readonly ConcurrentDictionary<string, (DateTime? Sta, DateTime? Eta)> ArcTimes = new();
    public DateTime LastSeen;
    public DateTime TimesSeen;   // last message that carried an STA/ETA (expiry uses this)
}

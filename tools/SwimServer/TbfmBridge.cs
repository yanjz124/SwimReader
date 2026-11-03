using System.Collections.Concurrent;
using System.Globalization;
using System.Text.Json;
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
    private long _msgCount, _airCount, _unparsed, _deletes;

    // centre id (ZLC) → adaptation, rates, heartbeat
    private readonly ConcurrentDictionary<string, TbfmCenter> _centers = new();
    // <tma> children we don't model yet, counted so a new message kind shows up in /debug
    private readonly ConcurrentDictionary<string, long> _unknownKinds = new();

    // Adaptation is published rarely (one centre in a ~10-minute capture), so it's kept on disk
    // and reloaded on startup; otherwise every restart would lose it for hours.
    private string? _cacheDir;
    private volatile bool _adaptationDirty;
    private const string AdaptationFile = "tbfm-adaptation.json";

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
        // Default 3: TBFM runs several times SFDPS's rate (measured 164-523 msg/s on 3 flows). On
        // one flow lag sat flat at ~10 s and never drained, the same single-session transport
        // ceiling CLAUDE.md describes for SFDPS; busyPct stayed under 3%, so parsing isn't it.
        var receivers = SolaceTuning.Receivers("TBFM_FLOWS", 3);
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
        long lastMsgTicks = DateTime.UtcNow.Ticks;
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
                        Interlocked.Exchange(ref lastMsgTicks, DateTime.UtcNow.Ticks);
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

                // Silence watchdog, as TFMS and ITWS do. A flow can stop delivering without the
                // session raising anything, and `while (true) Thread.Sleep(...)` would then sit
                // there forever — this bridge is the only consumer of its queue, so a dead flow is
                // a dead feed. 180s rather than TFMS's 90s: TBFM is a low-rate feed whose quiet
                // periods aren't characterised yet, and an over-eager reconnect unbinds the queue,
                // which costs expired messages at the broker for nothing.
                int watchdogCycles = 0;
                while (true)
                {
                    Thread.Sleep(10000);
                    watchdogCycles++;
                    var silence = (DateTime.UtcNow -
                        new DateTime(Interlocked.Read(ref lastMsgTicks), DateTimeKind.Utc)).TotalSeconds;
                    if (silence > 180)
                    {
                        Console.WriteLine($"[TBFM] No messages for {silence:F0}s — reconnecting");
                        break;
                    }
                    if (watchdogCycles % 6 == 0)
                        Console.WriteLine($"[TBFM] {_flights.Count} schedules, {_centers.Count} centre(s), "
                            + $"{Interlocked.Read(ref _msgCount)} msgs ({Interlocked.Read(ref _airCount)} air)");
                }

                try { session.Disconnect(); }
                catch (Exception ex) { Console.WriteLine($"[TBFM] disconnect: {ex.Message}"); }
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

        var now = DateTime.UtcNow;

        // Heartbeat: <mis misSrce="TMA.ZHU.FAA.GOV"><hb/></mis>
        if (root.Name.LocalName == "mis")
        {
            var hc = CenterOf(Attr(root, "misSrce"));
            if (hc != null) Center(hc).LastHeartbeat = now;
            return;
        }

        var envSrce = FindAncestorOrSelfAttr(root, "env", "envSrce");
        var ctr = CenterOf(envSrce);
        if (ctr != null) Center(ctr).LastMessage = now;

        foreach (var tma in root.DescendantsAndSelf().Where(e => e.Name.LocalName == "tma"))
            foreach (var kind in tma.Elements())
                switch (kind.Name.LocalName)
                {
                    case "air": ProcessAir(kind, envSrce, now); break;
                    case "adp": if (ctr != null) { ProcessAdaptation(kind, Center(ctr)); _adaptationDirty = true; } break;
                    case "con": if (ctr != null) ProcessConfig(kind, Center(ctr), now); break;
                    default: _unknownKinds.AddOrUpdate(kind.Name.LocalName, 1, (_, n) => n + 1); break;
                }
    }

    private TbfmCenter Center(string id) => _centers.GetOrAdd(id, k => new TbfmCenter { Id = k });

    // ── <air>: one centre's schedule for one flight ──────────────────────────
    private void ProcessAir(XElement air, string? src, DateTime now)
    {
        Interlocked.Increment(ref _airCount);
        var aid = Attr(air, "aid") ?? Leaf(Block(air, "flt"), "aid");
        if (string.IsNullOrWhiteSpace(aid)) return;
        aid = aid.Trim().ToUpperInvariant();

        var tmaId = Attr(air, "tmaId");
        var apt = Attr(air, "apt") ?? Leaf(Block(air, "flt"), "apt");
        var key = !string.IsNullOrEmpty(tmaId) ? $"{src ?? "?"}/{tmaId}" : $"{aid}/{apt ?? "?"}";

        // airType: NEW / AMD (amendment) / DEL. DEL means this centre dropped the schedule.
        var airType = Attr(air, "airType");
        if (string.Equals(airType, "DEL", StringComparison.OrdinalIgnoreCase))
        {
            _flights.TryRemove(key, out _);
            Interlocked.Increment(ref _deletes);
            return;
        }

        var f = _flights.GetOrAdd(key, _ => new TbfmFlight { Key = key, Aid = aid });
        f.Aid = aid;
        Merge(ref f.TmaId, tmaId);
        Merge(ref f.Source, src);
        Merge(ref f.Gufi, Attr(air, "gufi"));
        Merge(ref f.Cid, Attr(air, "cid"));
        Merge(ref f.Arrival, NormalizeAirport(apt));
        Merge(ref f.Departure, NormalizeAirport(Attr(air, "dap") ?? Leaf(Block(air, "flt"), "dap")));
        Merge(ref f.AirType, airType);

        var flt = Block(air, "flt");
        var mrp = Block(air, "mrp");
        var sch = Block(air, "sch");
        var eta = Block(air, "eta");
        var sta = Block(air, "sta");

        // Every leaf of the non-time blocks, under its raw tag, so nothing TBFM sends is dropped.
        MergeBlock(f.Flt, flt);
        MergeBlock(f.Mrp, mrp);
        MergeBlock(f.Sch, sch);

        // Point names live in their own block: <sta><mfx>, <eta><mfx>, <mrp><mfx>, <sch><mfx>.
        Merge(ref f.MeterFix, Leaf(sta, "mfx") ?? Leaf(eta, "mfx") ?? Leaf(mrp, "mfx") ?? Leaf(sch, "mfx"));
        Merge(ref f.Runway, Leaf(mrp, "rwy"));

        // Meter-fix times. Live TBFM MIS has no sta_mfx: the meter-fix STA comes as sta_sfx /
        // sta_dfx (equal in every sample seen), with the matching ETA as eta_sfx / eta_dfx. eta_mfx
        // is also published but can differ from eta_sfx by ~1 min, so prefer the sfx pair and
        // STA - ETA compares one point with itself.
        bool timed = false;
        timed |= MergeTime(ref f.EtaMeterFix, ParseTime(Leaf(eta, "eta_sfx") ?? Leaf(eta, "eta_dfx") ?? Leaf(eta, "eta_mfx")));
        timed |= MergeTime(ref f.StaMeterFix, ParseTime(Leaf(sta, "sta_sfx") ?? Leaf(sta, "sta_dfx") ?? Leaf(sta, "sta_mfx")));
        timed |= MergeTime(ref f.EtaRunway, ParseTime(Leaf(eta, "eta_rwy")));
        timed |= MergeTime(ref f.StaRunway, ParseTime(Leaf(sta, "sta_rwy")));
        // Meter arcs upstream of the meter fix (outer meter arc, outer-outer, 3rd, 4th). Their
        // names are in <mrp> (e.g. oma = MOXEE/T); which one a sector sees is site adaptation.
        foreach (var arc in Arcs)
        {
            var aSta = ParseTime(Leaf(sta, "sta_" + arc));
            var aEta = ParseTime(Leaf(eta, "eta_" + arc));
            if (aSta is null && aEta is null) continue;
            timed = true;
            var cur = f.ArcTimes.TryGetValue(arc, out var c) ? c : (null, null);
            f.ArcTimes[arc] = (aSta ?? cur.Sta, aEta ?? cur.Eta);
        }
        // Every eta_*/sta_* leaf too, raw, in case TBFM publishes a point we don't model.
        foreach (var blk in new[] { eta, sta })
            foreach (var (k, v) in LeafMap(blk))
                if (k.Contains('_')) f.Times[k] = v;

        f.LastSeen = now;
        // Expiry keys on this, not LastSeen: TBFM keeps sending route-only <flt> updates for a
        // flight whose schedule has long passed (seen live: GLH3, STA = ETA 40 min in the past,
        // "updated" 4 min ago), and those must not keep a dead time on the scope.
        if (timed) f.TimesSeen = now;
    }

    // ── <adp>: the centre's TBFM adaptation (meter points, airports, gates, streams) ──
    private static void ProcessAdaptation(XElement adp, TbfmCenter c)
    {
        var tra = Leaf(adp, "tra");
        if (tra != null) c.Tracons[tra] = 1;
        foreach (var trn in Kids(adp, "trn")) if (Leaf(trn, "nam") is { } tn) c.Tracons[tn] = 1;

        foreach (var mrn in Kids(Block(adp, "mrns"), "mrn"))
        {
            var nam = Leaf(mrn, "nam");
            if (nam == null) continue;
            var mrt = Leaf(mrn, "mrt");
            // Keyed by name AND type: one name can be several points (ZLA: LAX/NORTH is both an
            // O3A and an O4A; ZSE: HELNS is an MFX and "HELNS." its MFA).
            c.Points[TbfmCenter.PointKey(nam, mrt)] = new TbfmPoint
            {
                Name = nam,
                Type = mrt,
                Gate = Leaf(mrn, "gat"),
                MeterFix = Leaf(mrn, "mfx"),
                Arc = Leaf(mrn, "oma"),
                Lat = ParseDms(Leaf(mrn, "lat")),
                Lon = ParseDms(Leaf(mrn, "lon")),
                RadiusNm = ParseD(Leaf(mrn, "rad")),
                LeftAngle = ParseD(Leaf(mrn, "lan")),
                RightAngle = ParseD(Leaf(mrn, "ran")),
                AltLow = ParseD(Leaf(mrn, "alo")),
                AltHigh = ParseD(Leaf(mrn, "ahi")),
                Tracon = tra,
                Raw = LeafMap(mrn),
            };
        }
        foreach (var apn in Kids(Block(adp, "apns"), "apn"))
        {
            var nam = Leaf(apn, "nam");
            if (nam == null) continue;
            var a = c.Airports.GetOrAdd(nam, k => new TbfmAirport { Name = k });
            a.Tracon ??= tra;
            var rwys = Kids(Block(apn, "rwns"), "rwn").Select(r => Leaf(r, "nam")).OfType<string>().ToArray();
            if (rwys.Length > 0) a.Runways = rwys;
            foreach (var cfn in Kids(Block(apn, "cfns"), "cfn"))
                if (Leaf(cfn, "nam") is { } cn)
                    a.Configs[cn] = Kids(Block(cfn, "rwys"), "rwy").Select(r => r.Value.Trim()).Where(v => v.Length > 0).ToArray();
        }
        foreach (var gan in Kids(Block(adp, "gans"), "gan")) if (Leaf(gan, "nam") is { } gn) c.Gates[gn] = tra ?? "";
        foreach (var scn in Kids(Block(adp, "scns"), "scn")) if (Leaf(scn, "nam") is { } sn) c.StreamClasses[sn] = tra ?? "";
    }

    // ── <con>: acceptance rates (aar = airport, tar = TRACON) ────────────────
    private static void ProcessConfig(XElement con, TbfmCenter c, DateTime now)
    {
        foreach (var r in con.Elements())
        {
            var kind = r.Name.LocalName;                       // aar / tar / anything new
            var id = kind == "aar" ? (Leaf(r, "apt") ?? Leaf(r, "tra")) : (Leaf(r, "tra") ?? Leaf(r, "apt"));
            if (id == null) continue;
            c.Rates[$"{kind}/{id}"] = new TbfmRate
            {
                Kind = kind,
                Id = id,
                Tracon = Leaf(r, "tra"),
                Rate = ParseD(Leaf(r, "rat")),
                EffectiveTime = ParseTime(Leaf(r, "tim")),
                Type = r.Attributes().FirstOrDefault(a => a.Name.LocalName.EndsWith("Type"))?.Value,
                Received = now,
            };
        }
    }

    // ── XML helpers scoped to one block (the old Text() searched the whole message) ──
    private static XElement? Block(XElement? parent, string name) =>
        parent?.Elements().FirstOrDefault(e => e.Name.LocalName == name);

    private static IEnumerable<XElement> Kids(XElement? parent, string name) =>
        parent?.Elements().Where(e => e.Name.LocalName == name) ?? Enumerable.Empty<XElement>();

    private static string? Leaf(XElement? parent, string name)
    {
        var e = parent?.Elements().FirstOrDefault(x => x.Name.LocalName == name && !x.HasElements);
        var v = e?.Value.Trim();
        return string.IsNullOrEmpty(v) ? null : v;
    }

    private static Dictionary<string, string> LeafMap(XElement? block)
    {
        var d = new Dictionary<string, string>();
        if (block == null) return d;
        foreach (var e in block.Elements())
            if (!e.HasElements && e.Value.Trim() is { Length: > 0 } v) d[e.Name.LocalName] = v;
        return d;
    }

    private static void MergeBlock(ConcurrentDictionary<string, string> into, XElement? block)
    {
        foreach (var (k, v) in LeafMap(block)) into[k] = v;
    }

    private static double? ParseD(string? s) =>
        double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var d) ? d : null;

    /// <summary>"445759N" → 44.9664, "1224018W" → -122.6717 (DDMMSS / DDDMMSS + hemisphere).</summary>
    internal static double? ParseDms(string? s)
    {
        if (string.IsNullOrWhiteSpace(s) || s.Length < 7) return null;
        var hemi = char.ToUpperInvariant(s[^1]);
        var digits = s[..^1];
        if (!digits.All(char.IsDigit) || digits.Length is not (6 or 7)) return null;
        int degLen = digits.Length - 4;
        var deg = int.Parse(digits[..degLen]);
        var min = int.Parse(digits.Substring(degLen, 2));
        var sec = int.Parse(digits.Substring(degLen + 2, 2));
        var v = deg + min / 60.0 + sec / 3600.0;
        return hemi is 'S' or 'W' ? -v : v;
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
            var aid = Attr(air, "aid") ?? Leaf(Block(air, "flt"), "aid");
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
            // The LAST scheduled time, not the first non-null one. A record carries both a
            // meter-fix and a runway STA, and the runway is 20-30 min further on, so keying off
            // StaMeterFix deleted the record while EramSnapshot was still willing to show its
            // runway STA (`StaRunway.HasValue && !rwyDone`) — i.e. the runway STA/DELAY blanked
            // out mid-approach, which is exactly when it matters most.
            var sta = Later(f.StaMeterFix, f.StaRunway);
            if (now - f.LastSeen > StaleAfter || (sta.HasValue && now - sta.Value > KeepPastSta))
                _flights.TryRemove(k, out _);
        }
    }

    private static DateTime? Later(DateTime? a, DateTime? b) =>
        a is null ? b : b is null ? a : (a > b ? a : b);

    /// <summary>
    /// Compact per-flight metering records for the ERAM scope. LADD aircraft are dropped: the scope
    /// matches by callsign, and returning a blocked callsign here would expose it.
    /// </summary>
    public object[] EramSnapshot()
    {
        var now = DateTime.UtcNow;
        return _flights.Values
            .Where(f => !LaddService.IsBlocked(f.Aid, null))
            // TBFM's track status says when it's over (live: JBU190 acs=LANDED with a runway STA).
            .Where(f => !(f.Flt.TryGetValue("acs", out var acs) && acs == "LANDED"))
            .Select(f => (f, mfxDone: Passed(f.StaMeterFix, f.TimesSeen, now), rwyDone: Passed(f.StaRunway, f.TimesSeen, now)))
            .Where(x => (x.f.StaMeterFix.HasValue && !x.mfxDone) || (x.f.StaRunway.HasValue && !x.rwyDone))
            .Select(x => (object)new
            {
                aid = x.f.Aid,
                gufi = x.f.Gufi,
                apt = x.f.Arrival,
                src = x.f.Source,
                ctr = CenterOf(x.f.Source),
                // The point this centre schedules to. TBFM tags it <mfx> whether it is a fix or an
                // arc (ZLA: PXN, DVC are arcs), so it is named neutrally here; the type is separate.
                point = ScheduledPoint(x.f),
                meterFix = x.f.MeterFix,
                pointType = PointType(x.f),   // MFX / MFA / OMA / OOA from adaptation; null = unknown
                rwy = x.f.Runway,
                staPoint = x.mfxDone ? null : x.f.StaMeterFix,
                etaPoint = x.mfxDone ? null : x.f.EtaMeterFix,
                staRwy = x.rwyDone ? null : x.f.StaRunway,
                etaRwy = x.rwyDone ? null : x.f.EtaRunway,
                arcs = ArcsJson(x.f, now),
                // Point names for this schedule (mfx/sfx/dfx/oma/ooa/o3a/o4a/rwy/gat/scn/tra/cat/cfg)
                mrp = x.f.Mrp.IsEmpty ? null : new Dictionary<string, string>(x.f.Mrp),
                // Schedule flags (sfz frozen, rfz runway-frozen, sus suspended, man manual)
                sch = x.f.Sch.IsEmpty ? null : new Dictionary<string, string>(x.f.Sch),
                ageSec = (int)(now - x.f.TimesSeen).TotalSeconds,   // since the last schedule update
            })
            .ToArray();
    }

    /// <summary>Everything every centre holds for one callsign — all blocks, all raw times.</summary>
    public object[] FlightDetail(string callsign)
    {
        var cs = callsign.Trim().ToUpperInvariant();
        if (LaddService.IsBlocked(cs, null)) return Array.Empty<object>();
        var now = DateTime.UtcNow;
        return _flights.Values
            .Where(f => f.Aid == cs)
            .OrderBy(f => f.Source)
            .Select(f => (object)new
            {
                key = f.Key,
                ctr = CenterOf(f.Source),
                src = f.Source,
                tmaId = f.TmaId,
                gufi = f.Gufi,
                cid = f.Cid,
                airType = f.AirType,
                dep = f.Departure,
                apt = f.Arrival,
                point = ScheduledPoint(f),
                meterFix = f.MeterFix,
                pointType = PointType(f),
                rwy = f.Runway,
                staPoint = f.StaMeterFix, etaPoint = f.EtaMeterFix,
                staRwy = f.StaRunway, etaRwy = f.EtaRunway,
                arcs = f.ArcTimes.ToDictionary(kv => kv.Key, kv => new { name = ArcName(f, kv.Key), sta = kv.Value.Sta, eta = kv.Value.Eta }),
                times = new SortedDictionary<string, string>(f.Times),
                flt = new SortedDictionary<string, string>(f.Flt),
                mrp = new SortedDictionary<string, string>(f.Mrp),
                sch = new SortedDictionary<string, string>(f.Sch),
                lastSeenSec = (int)(now - f.LastSeen).TotalSeconds,
                timesSeenSec = f.TimesSeen == default ? (int?)null : (int)(now - f.TimesSeen).TotalSeconds,
            })
            .ToArray();
    }

    /// <summary>One row per TBFM system: liveness, schedule count, adaptation size, acceptance rates.</summary>
    public object[] CentersSnapshot()
    {
        var now = DateTime.UtcNow;
        var perCtr = _flights.Values.GroupBy(f => CenterOf(f.Source) ?? "?").ToDictionary(g => g.Key, g => g.Count());
        return _centers.Values.OrderBy(c => c.Id).Select(c => (object)new
        {
            ctr = c.Id,
            heartbeatSec = c.LastHeartbeat is { } h ? (int)(now - h).TotalSeconds : (int?)null,
            lastMessageSec = c.LastMessage is { } m ? (int)(now - m).TotalSeconds : (int?)null,
            schedules = perCtr.TryGetValue(c.Id, out var n) ? n : 0,
            tracons = c.Tracons.Keys.OrderBy(k => k).ToArray(),
            points = c.Points.Count,
            airports = c.Airports.Count,
            rates = c.Rates.Values.OrderBy(r => r.Kind).ThenBy(r => r.Id).Select(r => new
            {
                kind = r.Kind, id = r.Id, tracon = r.Tracon, rate = r.Rate, type = r.Type,
                effective = r.EffectiveTime,
            }).ToArray(),
        }).ToArray();
    }

    /// <summary>A centre's TBFM adaptation: meter points (with arc geometry), airports, gates, streams.</summary>
    public object? Adaptation(string center)
    {
        if (!_centers.TryGetValue(center.Trim().ToUpperInvariant(), out var c)) return null;
        return new
        {
            ctr = c.Id,
            tracons = c.Tracons.Keys.OrderBy(k => k).ToArray(),
            points = c.Points.Values.OrderBy(p => p.Name).Select(p => new
            {
                name = p.Name, type = p.Type, gate = p.Gate, meterFix = p.MeterFix, arc = p.Arc,
                tracon = p.Tracon, lat = p.Lat, lon = p.Lon, radiusNm = p.RadiusNm,
                leftAngle = p.LeftAngle, rightAngle = p.RightAngle, altLow = p.AltLow, altHigh = p.AltHigh,
                raw = p.Raw,
            }).ToArray(),
            airports = c.Airports.Values.OrderBy(a => a.Name).Select(a => new
            {
                name = a.Name, tracon = a.Tracon, runways = a.Runways,
                configs = new SortedDictionary<string, string[]>(a.Configs),
            }).ToArray(),
            gates = new SortedDictionary<string, string>(c.Gates),
            streamClasses = new SortedDictionary<string, string>(c.StreamClasses),
        };
    }

    /// <summary>
    /// Arc STA/ETA pairs still ahead of the flight, keyed oma/ooa/o3a/o4a, each with its name;
    /// null when none.
    /// </summary>
    private Dictionary<string, object>? ArcsJson(TbfmFlight f, DateTime now)
    {
        Dictionary<string, object>? d = null;
        foreach (var (arc, t) in f.ArcTimes)
        {
            if (t.Sta is null || Passed(t.Sta, f.TimesSeen, now)) continue;
            (d ??= new())[arc] = new { name = ArcName(f, arc), sta = t.Sta, eta = t.Eta };
        }
        return d;
    }

    /// <summary>
    /// The point staPoint/etaPoint refer to. Those come from sta_sfx/eta_sfx, and &lt;mrp&gt; names
    /// sfx separately from mfx: live, ZAU schedules AAL1614 with mfx MOTRR but sfx/dfx FYTTEMF,
    /// and eta_sfx (FYTTEMF) differs from eta_mfx (MOTRR). So prefer sfx, then dfx; mrp is sent
    /// rarely, so fall back to mfx, which is the same point whenever mrp hasn't said otherwise.
    /// </summary>
    private static string? ScheduledPoint(TbfmFlight f) =>
        f.Mrp.TryGetValue("sfx", out var sfx) && !string.IsNullOrWhiteSpace(sfx) ? sfx
        : f.Mrp.TryGetValue("dfx", out var dfx) && !string.IsNullOrWhiteSpace(dfx) ? dfx
        : f.MeterFix;

    /// <summary>
    /// What kind of point a schedule's "mfx" really is, from the centre's adaptation: MFX meter fix,
    /// MFA meter-fix arc, OMA / OOA outer arcs. TBFM labels whatever point it schedules to as
    /// &lt;mfx&gt; (live: ZLA schedules an OAK arrival to PXN), so this is the only way to tell.
    /// Null until that centre's adaptation has been received.
    /// </summary>
    private string? PointType(TbfmFlight f)
    {
        if (ScheduledPoint(f) is not { } name || CenterOf(f.Source) is not { } ctr
            || !_centers.TryGetValue(ctr, out var c)) return null;
        var hits = c.Points.Values.Where(p => p.Name == name).ToList();
        if (hits.Count == 0) hits = c.Points.Values.Where(p => p.Name == name + ".").ToList(); // ZSE names arcs "HELNS."
        if (hits.Count == 0) return null;
        // The scheduled point is a fix when the centre has one by that name (ZSE: HELNS MFX beside
        // "HELNS." MFA); otherwise it is whatever single kind of point the name is (ZLA: PXN MFA).
        return hits.FirstOrDefault(p => p.Type == "MFX")?.Type ?? hits[0].Type;
    }

    public void SetCacheDir(string dir) => _cacheDir = dir;

    /// <summary>Write adaptation to disk if it changed (called from the purge timer).</summary>
    public void SaveAdaptationIfDirty()
    {
        if (!_adaptationDirty || _cacheDir is null) return;
        _adaptationDirty = false;
        try
        {
            Directory.CreateDirectory(_cacheDir);
            var path = Path.Combine(_cacheDir, AdaptationFile);
            var payload = _centers.Values
                .Where(c => !c.Points.IsEmpty || !c.Airports.IsEmpty)
                .Select(c => new PersistedCenter
                {
                    Id = c.Id,
                    Points = c.Points.Values.ToList(),
                    Airports = c.Airports.Values.Select(a => new PersistedAirport
                    {
                        Name = a.Name, Tracon = a.Tracon, Runways = a.Runways,
                        Configs = new Dictionary<string, string[]>(a.Configs),
                    }).ToList(),
                    Gates = new Dictionary<string, string>(c.Gates),
                    StreamClasses = new Dictionary<string, string>(c.StreamClasses),
                    Tracons = c.Tracons.Keys.ToList(),
                }).ToList();
            var tmp = path + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(payload, PersistOpts));
            File.Move(tmp, path, overwrite: true);
        }
        catch (Exception ex)
        {
            _adaptationDirty = true;
            Console.Error.WriteLine($"[TBFM] adaptation save failed: {ex.GetType().Name}: {ex.Message}");
        }
    }

    public void LoadAdaptation(string dir)
    {
        try
        {
            var path = Path.Combine(dir, AdaptationFile);
            if (!File.Exists(path)) return;
            var list = JsonSerializer.Deserialize<List<PersistedCenter>>(File.ReadAllText(path), PersistOpts);
            if (list is null) return;
            int pts = 0;
            foreach (var pc in list)
            {
                var c = Center(pc.Id);
                foreach (var p in pc.Points) { c.Points[TbfmCenter.PointKey(p.Name, p.Type)] = p; pts++; }
                foreach (var a in pc.Airports)
                {
                    var ap = c.Airports.GetOrAdd(a.Name, k => new TbfmAirport { Name = k });
                    ap.Tracon = a.Tracon; ap.Runways = a.Runways ?? Array.Empty<string>();
                    foreach (var (k, v) in a.Configs ?? new()) ap.Configs[k] = v;
                }
                foreach (var (k, v) in pc.Gates ?? new()) c.Gates[k] = v;
                foreach (var (k, v) in pc.StreamClasses ?? new()) c.StreamClasses[k] = v;
                foreach (var t in pc.Tracons ?? new()) c.Tracons[t] = 1;
            }
            Console.WriteLine($"[TBFM] loaded adaptation for {list.Count} centre(s), {pts} meter points");
        }
        catch (Exception ex) { Console.Error.WriteLine($"[TBFM] adaptation load failed: {ex.Message}"); }
    }

    private static readonly JsonSerializerOptions PersistOpts = new() { IncludeFields = true };

    private class PersistedCenter
    {
        public string Id = "";
        public List<TbfmPoint> Points = new();
        public List<PersistedAirport> Airports = new();
        public Dictionary<string, string>? Gates, StreamClasses;
        public List<string>? Tracons;
    }

    private class PersistedAirport
    {
        public string Name = "";
        public string? Tracon;
        public string[]? Runways;
        public Dictionary<string, string[]>? Configs;
    }

    /// <summary>
    /// The arc's name. First the schedule's own &lt;mrp&gt; (oma = "MOXEE/T"). That block often
    /// arrives in a different message from the times, so fall back to the centre's adaptation.
    /// </summary>
    private string? ArcName(TbfmFlight f, string arc)
    {
        if (f.Mrp.TryGetValue(arc, out var n) && !string.IsNullOrWhiteSpace(n)) return n;
        if (f.MeterFix is not { } mfx || CenterOf(f.Source) is not { } ctr
            || !_centers.TryGetValue(ctr, out var c)) return null;
        // Adaptation arcs name the meter point they serve (ZLA: ZABEOA is the OMA with mfx ZABEAST).
        // Name it only when exactly one arc of this kind serves this point: STEWWMP has two OMAs
        // (STEWOA, STEWOA2), and guessing between them would be worse than saying nothing.
        var type = arc.ToUpperInvariant();
        var arcs = c.Points.Values.Where(p => p.Type == type && p.MeterFix == mfx).Select(p => p.Name).Distinct().ToList();
        return arcs.Count == 1 ? arcs[0] : null;
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
        deletes = Interlocked.Read(ref _deletes),
        centers = _centers.Count,
        unknownKinds = new Dictionary<string, long>(_unknownKinds),
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
    public string? TmaId, Source, Gufi, Cid, Arrival, Departure, AirType, MeterFix, Runway;
    // Raw leaves of each block, keyed by TBFM tag (see the glossary in CLAUDE.md). Concurrent:
    // written on the feed thread, read by API requests.
    public readonly ConcurrentDictionary<string, string> Flt = new();   // flight plan / status
    public readonly ConcurrentDictionary<string, string> Mrp = new();   // assigned meter points
    public readonly ConcurrentDictionary<string, string> Sch = new();   // schedule status flags
    public readonly ConcurrentDictionary<string, string> Times = new(); // every eta_*/sta_* raw
    public DateTime? EtaMeterFix, StaMeterFix, EtaRunway, StaRunway;
    // Written on the feed thread, read by API requests: concurrent, so enumeration can't throw.
    public readonly ConcurrentDictionary<string, (DateTime? Sta, DateTime? Eta)> ArcTimes = new();
    public DateTime LastSeen;
    public DateTime TimesSeen;   // last message that carried an STA/ETA (expiry uses this)
}

/// <summary>One ARTCC's TBFM system: its adaptation, acceptance rates and liveness.</summary>
class TbfmCenter
{
    public string Id = "";
    public static string PointKey(string name, string? type) => $"{name}|{type}";
    public DateTime? LastHeartbeat, LastMessage;
    public readonly ConcurrentDictionary<string, TbfmPoint> Points = new();      // "name|type" → meter reference point
    public readonly ConcurrentDictionary<string, TbfmAirport> Airports = new();
    public readonly ConcurrentDictionary<string, string> Gates = new();          // gate → TRACON
    public readonly ConcurrentDictionary<string, string> StreamClasses = new();  // stream class → TRACON
    public readonly ConcurrentDictionary<string, byte> Tracons = new();
    public readonly ConcurrentDictionary<string, TbfmRate> Rates = new();        // "aar/SEA", "tar/S46"
}

/// <summary>A meter reference point (mrn). Type: MFX meter fix, MFA meter-fix arc, OMA outer meter arc, OOA outer-outer arc.</summary>
class TbfmPoint
{
    public string Name = "";
    public string? Type, Gate, MeterFix, Arc, Tracon;
    public double? Lat, Lon, RadiusNm, LeftAngle, RightAngle, AltLow, AltHigh;
    public Dictionary<string, string> Raw = new();
}

class TbfmAirport
{
    public string Name = "";
    public string? Tracon;
    public string[] Runways = Array.Empty<string>();
    public readonly ConcurrentDictionary<string, string[]> Configs = new();     // runway config → runways
}

class TbfmRate
{
    public string Kind = "", Id = "";
    public string? Tracon, Type;
    public double? Rate;
    public DateTime? EffectiveTime;
    public DateTime Received;
}

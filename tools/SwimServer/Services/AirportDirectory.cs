using System.Globalization;
using System.Text;

namespace SwimServer;

/// <summary>
/// Worldwide airport coordinates for maps and distances. NASR only covers US airports, but airline networks reach
/// Canada, Mexico, the Caribbean and overseas (CYYZ, MMUN, TJSJ, EGLL…), so this loads the public-domain OurAirports
/// dataset (cached under airport-data/, refreshed monthly) and falls back to NASR for anything it can't resolve.
///
/// Lookup accepts what flight plans actually contain: ICAO codes (KATL), FAA identifiers for US fields without one
/// (26N), and IATA codes. When several airports claim a code, an ICAO/GPS match beats the OurAirports ident, which
/// beats a US FAA local code, which beats IATA; ties go to the larger airport.
/// </summary>
sealed class AirportDirectory
{
    public sealed record Airport(string Ident, string Name, string City, string Country, double Lat, double Lon, string Type);

    private const string Url = "https://davidmegginson.github.io/ourairports-data/airports.csv";
    private static readonly TimeSpan MaxAge = TimeSpan.FromDays(30);

    private readonly string _file;
    private readonly Func<string, (double Lat, double Lon)?> _nasr;
    private volatile Dictionary<string, Airport> _byCode = new(StringComparer.OrdinalIgnoreCase);

    public int Count => _byCode.Count;

    public AirportDirectory(string dataDir, Func<string, (double Lat, double Lon)?> nasrLookup)
    {
        _file = Path.Combine(dataDir, "ourairports-airports.csv");
        _nasr = nasrLookup;
    }

    /// <summary>Load the cached file, then refresh it in the background when missing or older than a month.</summary>
    public void StartAsync() => Task.Run(async () =>
    {
        try
        {
            if (File.Exists(_file)) Load();
            if (!File.Exists(_file) || DateTime.UtcNow - File.GetLastWriteTimeUtc(_file) > MaxAge)
            {
                await Download();
                Load();
            }
        }
        catch (Exception ex) { Console.WriteLine($"[AIRPORTS] {ex.Message} (NASR fallback only)"); }
    });

    private async Task Download()
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromMinutes(3) };
        var bytes = await http.GetByteArrayAsync(Url);
        if (bytes.Length < 1_000_000) throw new InvalidOperationException($"OurAirports download too small ({bytes.Length} bytes)");
        Directory.CreateDirectory(Path.GetDirectoryName(_file)!);
        var tmp = _file + ".tmp";
        await File.WriteAllBytesAsync(tmp, bytes);
        File.Move(tmp, _file, overwrite: true);
        Console.WriteLine($"[AIRPORTS] Downloaded OurAirports ({bytes.Length / 1024:N0} KB)");
    }

    public void Load()
    {
        var text = File.ReadAllText(_file);
        Dictionary<string, int>? col = null;
        var best = new Dictionary<string, (int Rank, Airport A)>(StringComparer.OrdinalIgnoreCase);
        int rows = 0;
        foreach (var r in ParseCsv(text))
        {
            if (col == null)
            {
                col = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
                for (int i = 0; i < r.Count; i++) col[r[i].Trim()] = i;
                continue;
            }
            var c = col;
            string F(string name) => c.TryGetValue(name, out var i) && i < r.Count ? r[i].Trim() : "";

            if (!double.TryParse(F("latitude_deg"), NumberStyles.Float, CultureInfo.InvariantCulture, out var lat)
                || !double.TryParse(F("longitude_deg"), NumberStyles.Float, CultureInfo.InvariantCulture, out var lon))
                continue;
            var type = F("type");
            int typeRank = type switch
            {
                "large_airport" => 0, "medium_airport" => 1, "small_airport" => 2,
                "seaplane_base" => 3, "heliport" => 4, "closed" => 9, _ => 5,
            };
            var country = F("iso_country");
            var a = new Airport(F("ident"), F("name"), F("municipality"), country, lat, lon, type);

            void Offer(string code, int sourceRank)
            {
                if (code.Length < 2) return;
                int rank = sourceRank * 10 + typeRank;
                if (!best.TryGetValue(code, out var cur) || rank < cur.Rank) best[code] = (rank, a);
            }
            Offer(F("icao_code"), 0);
            Offer(F("gps_code"), 0);
            Offer(F("ident"), 1);
            if (country == "US") Offer(F("local_code"), 2);
            Offer(F("iata_code"), 3);
            rows++;
        }
        _byCode = best.ToDictionary(kv => kv.Key, kv => kv.Value.A, StringComparer.OrdinalIgnoreCase);
        Console.WriteLine($"[AIRPORTS] {rows:N0} airports, {_byCode.Count:N0} codes from OurAirports");
    }

    /// <summary>Coordinates and identity for a flight-plan airport code, or null if unknown.</summary>
    public Airport? Find(string? code)
    {
        if (string.IsNullOrWhiteSpace(code)) return null;
        var c = code.Trim().ToUpperInvariant();
        var d = _byCode;
        if (d.TryGetValue(c, out var a)) return a;
        if (c.Length == 4 && c[0] == 'K' && d.TryGetValue(c[1..], out a)) return a;   // K26N → 26N
        if (c.Length == 3 && d.TryGetValue("K" + c, out a)) return a;
        var n = _nasr(c);
        return n == null ? null : new Airport(c, "", "", "US", n.Value.Lat, n.Value.Lon, "");
    }

    /// <summary>RFC 4180 CSV records (quoted fields may contain commas and doubled quotes).</summary>
    private static IEnumerable<List<string>> ParseCsv(string text)
    {
        var row = new List<string>();
        var field = new StringBuilder();
        bool inQuotes = false;
        for (int i = 0; i < text.Length; i++)
        {
            char ch = text[i];
            if (inQuotes)
            {
                if (ch == '"')
                {
                    if (i + 1 < text.Length && text[i + 1] == '"') { field.Append('"'); i++; }
                    else inQuotes = false;
                }
                else field.Append(ch);
            }
            else if (ch == '"') inQuotes = true;
            else if (ch == ',') { row.Add(field.ToString()); field.Clear(); }
            else if (ch == '\n')
            {
                row.Add(field.ToString());
                field.Clear();
                yield return row;
                row = new List<string>();
            }
            else if (ch != '\r') field.Append(ch);
        }
        if (field.Length > 0 || row.Count > 0)
        {
            row.Add(field.ToString());
            yield return row;
        }
    }
}

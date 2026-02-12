using System.Text.Json;
using System.Text.Json.Serialization;

namespace SwimReader.Server.AdsbFi;

public sealed class AdsbFiAircraft
{
    [JsonPropertyName("hex")]
    public string? Hex { get; set; }

    [JsonPropertyName("type")]
    public string? SourceType { get; set; }

    [JsonPropertyName("flight")]
    public string? Flight { get; set; }

    [JsonPropertyName("r")]
    public string? Registration { get; set; }

    [JsonPropertyName("t")]
    public string? AircraftType { get; set; }

    [JsonPropertyName("desc")]
    public string? AircraftDescription { get; set; }

    [JsonPropertyName("dbFlags")]
    public int? DbFlags { get; set; }

    [JsonPropertyName("alt_baro")]
    public JsonElement? AltBaro { get; set; }

    [JsonPropertyName("alt_geom")]
    public int? AltGeom { get; set; }

    [JsonPropertyName("gs")]
    public double? GroundSpeed { get; set; }

    [JsonPropertyName("track")]
    public double? Track { get; set; }

    [JsonPropertyName("baro_rate")]
    public int? BaroRate { get; set; }

    [JsonPropertyName("squawk")]
    public string? Squawk { get; set; }

    [JsonPropertyName("emergency")]
    public string? Emergency { get; set; }

    [JsonPropertyName("category")]
    public string? Category { get; set; }

    [JsonPropertyName("lat")]
    public double? Lat { get; set; }

    [JsonPropertyName("lon")]
    public double? Lon { get; set; }

    [JsonPropertyName("seen")]
    public double? Seen { get; set; }

    [JsonPropertyName("seen_pos")]
    public double? SeenPos { get; set; }

    public string? TrimmedCallsign => Flight?.Trim();

    public bool IsMilitary => (DbFlags & 1) == 1;

    public int? ParsedAltBaro
    {
        get
        {
            if (AltBaro is null) return null;
            var el = AltBaro.Value;
            return el.ValueKind == JsonValueKind.Number ? el.GetInt32() : null;
        }
    }

    public bool IsOnGround
    {
        get
        {
            if (AltBaro is null) return false;
            return AltBaro.Value.ValueKind == JsonValueKind.String
                && AltBaro.Value.GetString() == "ground";
        }
    }
}

public sealed class AdsbFiResponse
{
    [JsonPropertyName("ac")]
    public List<AdsbFiAircraft>? Aircraft { get; set; }

    [JsonPropertyName("total")]
    public int? Total { get; set; }

    [JsonPropertyName("now")]
    public double? Now { get; set; }
}

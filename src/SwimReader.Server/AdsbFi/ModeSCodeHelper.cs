using System.Globalization;

namespace SwimReader.Server.AdsbFi;

public static class ModeSCodeHelper
{
    public static string ToHexString(int modeSCode) => modeSCode.ToString("x6");

    public static int? ParseHex(string? hex)
    {
        if (string.IsNullOrEmpty(hex)) return null;
        return int.TryParse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var code) && code > 0
            ? code
            : null;
    }

    public static bool IsUsMilitaryHex(string? hex)
    {
        if (string.IsNullOrEmpty(hex) || hex.Length != 6) return false;
        var upper = hex.ToUpperInvariant();
        return upper.StartsWith("AE", StringComparison.Ordinal) ||
               upper.StartsWith("AF", StringComparison.Ordinal);
    }
}

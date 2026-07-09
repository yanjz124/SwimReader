// Shims for .NET primitive TryParse helpers, using the out-holder convention:
//   const x = {}; if (tryParseDouble(s, x)) { ... x.value ... }

// double.TryParse(string, out double)
export function tryParseDouble(s, out) {
    out.value = 0;
    if (s == null) return false;
    const t = s.trim();
    if (t === "") return false;         // C# TryParse("") == false (JS Number("") == 0)
    const v = Number(t);
    if (Number.isNaN(v)) return false;
    out.value = v;
    return true;
}

// int.TryParse(string, out int)
export function tryParseInt(s, out) {
    out.value = 0;
    if (s == null) return false;
    const t = s.trim();
    if (!/^[+-]?\d+$/.test(t)) return false;  // C# int.TryParse rejects decimals/letters
    out.value = parseInt(t, 10);
    return true;
}

// Ported 1:1 from _source/STARS/LeaderDirection.cs
// namespace DGScope.STARS

export const LeaderDirection = Object.freeze({
    NW: 1,
    N: 2,
    NE: 3,
    W: 4,
    E: 6,
    SW: 7,
    S: 8,
    SE: 9,
    Invalid: 0,
});

// C# implicitly stringifies an enum to its NAME (e.g. "N"), but this enum is numeric (needed for the
// arithmetic in ProcessCommand). Use this where DGScope concatenates the enum into display text.
const _names = Object.fromEntries(Object.entries(LeaderDirection).map(([k, v]) => [v, k]));
export function LeaderDirectionName(value) { return _names[value] ?? String(value); }

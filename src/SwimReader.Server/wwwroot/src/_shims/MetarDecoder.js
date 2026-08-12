// Stub for the external csharp-metar-decoder library (scope/csharp-metar-decoder — outside the
// 73-file main-project scope). It parses raw METAR text into structured values. A faithful port
// is a separate effort; DGScope's Metars.cs (in the main project) also parses METARs and is
// ported for real. WeatherService degrades gracefully with this stub (no METAR -> 29.92 default).
//
// TODO: port csharp-metar-decoder proper (or route WeatherService through Metars.cs) if needed.

export const Unit = Object.freeze({ MercuryInch: 0, HectoPascal: 1 });
export const Value = { Unit };

export class DecodedMetar {
    ICAO = null;     // string
    Pressure = null; // Value  (with GetConvertedValue(unit))
    IsValid = false; // bool
}

export class MetarDecoder {
    static ParseWithMode(raw) { // DecodedMetar ParseWithMode(string)
        // External binary/text parse deferred -> returns an invalid metar (filtered out by callers).
        return new DecodedMetar();
    }
}

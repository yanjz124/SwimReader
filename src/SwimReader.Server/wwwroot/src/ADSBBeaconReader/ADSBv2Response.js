// Ported 1:1 from _source/ADSBBeaconReader/ADSBv2Response.cs
// namespace DGScope.ADSBBeaconReader
// using Newtonsoft.Json;  ([JsonProperty] wire-name mappings preserved as comments)

export class ADSBv2Response {
    Aircraft = [];   // [JsonProperty("ac")]    List<ADSBv2Aircraft>
    Message = null;  // [JsonProperty("msg")]   string
    Now = 0;         // [JsonProperty("now")]   long
    Total = 0;       // [JsonProperty("total")] int
}

export class ADSBv2Aircraft {
    Hex = null;          // [JsonProperty("hex")]      string
    Flight = null;       // [JsonProperty("flight")]   string
    Squawk = null;       // [JsonProperty("squawk")]   string
    Registration = null; // [JsonProperty("r")]        string
    AircraftType = null; // [JsonProperty("t")]        string
    Latitude = null;     // [JsonProperty("lat")]      double?
    Longitude = null;    // [JsonProperty("lon")]      double?
    AltitudeBaro = null; // [JsonProperty("alt_baro")] object
    GroundSpeed = null;  // [JsonProperty("gs")]       double?
    Track = null;        // [JsonProperty("track")]    double?
    DbFlags = null;      // [JsonProperty("dbFlags")]  int?

    // DbFlags.HasValue && (DbFlags.Value & 8) != 0
    get IsLADD() { return this.DbFlags != null && (this.DbFlags & 8) != 0; }
}

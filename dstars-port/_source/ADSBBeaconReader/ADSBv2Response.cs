using Newtonsoft.Json;
using System.Collections.Generic;

namespace DGScope.ADSBBeaconReader
{
    public class ADSBv2Response
    {
        [JsonProperty("ac")]
        public List<ADSBv2Aircraft> Aircraft { get; set; } = new List<ADSBv2Aircraft>();

        [JsonProperty("msg")]
        public string Message { get; set; }

        [JsonProperty("now")]
        public long Now { get; set; }

        [JsonProperty("total")]
        public int Total { get; set; }
    }

    public class ADSBv2Aircraft
    {
        [JsonProperty("hex")]
        public string Hex { get; set; }

        [JsonProperty("flight")]
        public string Flight { get; set; }

        [JsonProperty("squawk")]
        public string Squawk { get; set; }

        [JsonProperty("r")]
        public string Registration { get; set; }

        [JsonProperty("t")]
        public string AircraftType { get; set; }

        [JsonProperty("lat")]
        public double? Latitude { get; set; }

        [JsonProperty("lon")]
        public double? Longitude { get; set; }

        [JsonProperty("alt_baro")]
        public object AltitudeBaro { get; set; }

        [JsonProperty("gs")]
        public double? GroundSpeed { get; set; }

        [JsonProperty("track")]
        public double? Track { get; set; }

        [JsonProperty("dbFlags")]
        public int? DbFlags { get; set; }

        public bool IsLADD => DbFlags.HasValue && (DbFlags.Value & 8) != 0;
    }
}

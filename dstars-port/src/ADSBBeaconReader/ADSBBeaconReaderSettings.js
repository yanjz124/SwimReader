// Ported 1:1 from _source/ADSBBeaconReader/ADSBBeaconReaderSettings.cs
// namespace DGScope.ADSBBeaconReader
// [Serializable()] [TypeConverter(typeof(ExpandableObjectConverter))] [JsonObject]

export class ADSBBeaconReaderSettings {
    // Empty list — XmlSerializer calls the constructor then appends deserialized items.
    // Pre-populating here would cause duplicates. Use EnsureBuiltInSources() after load.
    Sources = [];              // List<ADSBSource>
    HideLADDCallsigns = true;  // bool
    PollIntervalSeconds = 5;   // int

    // [XmlIgnore]
    get AnyEnabled() { return this.Sources != null && this.Sources.some(s => s.Enabled); } // Sources.Any(s => s.Enabled)

    /// <summary>
    /// Ensures built-in sources exist after deserialization (in case user has an older config)
    /// </summary>
    EnsureBuiltInSources() {
        if (this.Sources == null)
            this.Sources = [];

        // Deduplicate by BaseUrl (older configs may have duplicates)
        // HashSet<string>(StringComparer.OrdinalIgnoreCase) -> Set keyed by lowercased value
        let seen = new Set();
        for (let i = this.Sources.length - 1; i >= 0; i--) {
            let key = this.Sources[i].BaseUrl.toLowerCase(); // OrdinalIgnoreCase
            if (seen.has(key)) {            // !seen.Add(x)  == already present
                this.Sources.splice(i, 1); // Sources.RemoveAt(i)
            } else {
                seen.add(key);
            }
        }

        let builtIns = [
            Object.assign(new ADSBSource(), { Name: "adsb.lol", BaseUrl: "https://api.adsb.lol/v2", Enabled: true, IsBuiltIn: true }),
            Object.assign(new ADSBSource(), { Name: "adsb.fi", BaseUrl: "https://opendata.adsb.fi/api/v2", Enabled: true, IsBuiltIn: true }),
            Object.assign(new ADSBSource(), { Name: "airplanes.live", BaseUrl: "https://api.airplanes.live/v2", Enabled: true, IsBuiltIn: true }),
        ];

        for (const builtIn of builtIns) {
            if (!this.Sources.some(s => s.BaseUrl === builtIn.BaseUrl)) {
                this.Sources.unshift(builtIn); // Sources.Insert(0, builtIn)
            }
        }
    }
}

// [Serializable()]
export class ADSBSource {
    Name = null;       // string
    BaseUrl = null;    // string
    Enabled = false;   // bool
    IsBuiltIn = false; // bool

    toString() {
        return this.Name + (this.IsBuiltIn ? "" : " (" + this.BaseUrl + ")");
    }
}

// Ported 1:1 from _source/VideoMapFile.cs
// namespace DGScope
// [Serializable()]
// [TypeConverter(typeof(ExpandableObjectConverter))]
import { MapCategory } from "./VideoMap.js";

export class VideoMapFile {
    // File path to the GeoJSON file
    Filepath = null;   // string

    // Map number for this map (used for DCB mapping and visibility)
    MapNumber = 0;     // int

    // Short mnemonic name (shown on DCB button)
    ShortName = null;  // string

    // Full descriptive name
    FullName = null;   // string

    // Brightness group (A or B)
    BrightnessGroup = MapCategory.A;  // MapCategory

    // Which DCB button(s) control this map
    // Can be single number (e.g., "3") or comma-separated (e.g., "3,11")
    // Empty or "0" means map not on DCB, only in Ctrl+F2 selector
    DCBButton = null;  // string

    toString() {
        return `${this.MapNumber}: ${this.ShortName} (${this.Filepath})`;
    }
}

using System;
using System.ComponentModel;
using System.Xml.Serialization;

namespace DGScope
{
    [Serializable()]
    [TypeConverter(typeof(ExpandableObjectConverter))]
    public class VideoMapFile
    {
        // File path to the GeoJSON file
        public string Filepath { get; set; }

        // Map number for this map (used for DCB mapping and visibility)
        public int MapNumber { get; set; }

        // Short mnemonic name (shown on DCB button)
        public string ShortName { get; set; }

        // Full descriptive name
        public string FullName { get; set; }

        // Brightness group (A or B)
        public MapCategory BrightnessGroup { get; set; } = MapCategory.A;

        // Which DCB button(s) control this map
        // Can be single number (e.g., "3") or comma-separated (e.g., "3,11")
        // Empty or "0" means map not on DCB, only in Ctrl+F2 selector
        public string DCBButton { get; set; }

        public override string ToString()
        {
            return $"{MapNumber}: {ShortName} ({Filepath})";
        }
    }
}

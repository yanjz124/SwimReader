using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Xml.Linq;

namespace DGScope
{
    /// <summary>
    /// Imports MSAW volumes from vSTARS facility "SystemVolume" XML
    /// (the format produced by the myfsim.com vSTARS MSAW Volume Creator).
    /// </summary>
    public static class MSAWImporter
    {
        public static List<MSAWVolume> Import(string path)
        {
            return Parse(File.ReadAllText(path));
        }

        public static List<MSAWVolume> Parse(string text)
        {
            var result = new List<MSAWVolume>();
            if (string.IsNullOrWhiteSpace(text))
                return result;

            XDocument doc;
            try
            {
                doc = XDocument.Parse(text);
            }
            catch (System.Xml.XmlException)
            {
                // The MSAW creator emits a bare sequence of <SystemVolume> elements
                // with no single root, which isn't valid standalone XML. Wrap it.
                doc = XDocument.Parse("<MSAWVolumes>" + text + "</MSAWVolumes>");
            }

            foreach (var el in doc.Descendants("SystemVolume"))
            {
                var type = (string)el.Attribute("VolumeType");
                if (!string.IsNullOrEmpty(type) && !type.Equals("MSAW", StringComparison.OrdinalIgnoreCase))
                    continue;

                var vol = new MSAWVolume
                {
                    Name = (string)el.Attribute("Name"),
                    Floor = ParseInt(el.Attribute("Floor")),
                    Ceiling = ParseInt(el.Attribute("Ceiling")),
                    Radius = ParseDouble(el.Attribute("Radius")),
                };

                var shape = (string)el.Attribute("VolumeShape");
                bool isCircle = !string.IsNullOrEmpty(shape) && shape.Equals("Circle", StringComparison.OrdinalIgnoreCase);

                var center = el.Element("Center");
                if (center != null && isCircle)
                    vol.Center = ReadPoint(center);

                foreach (var wp in el.Descendants("WorldPoint"))
                {
                    var p = ReadPoint(wp);
                    if (p != null)
                        vol.Points.Add(p);
                }

                // Keep usable volumes only: a polygon needs >= 3 points, a circle a center + radius.
                if (vol.Points.Count >= 3 || (vol.Radius > 0 && vol.Center != null))
                    result.Add(vol);
            }
            return result;
        }

        private static GeoPoint ReadPoint(XElement el)
        {
            if (double.TryParse((string)el.Attribute("Lat"), NumberStyles.Float, CultureInfo.InvariantCulture, out double lat) &&
                double.TryParse((string)el.Attribute("Lon"), NumberStyles.Float, CultureInfo.InvariantCulture, out double lon))
                return new GeoPoint(lat, lon);
            return null;
        }

        private static int ParseInt(XAttribute a)
        {
            return a != null && int.TryParse(a.Value, NumberStyles.Integer, CultureInfo.InvariantCulture, out int v) ? v : 0;
        }

        private static double ParseDouble(XAttribute a)
        {
            return a != null && double.TryParse(a.Value, NumberStyles.Float, CultureInfo.InvariantCulture, out double v) ? v : 0;
        }
    }
}

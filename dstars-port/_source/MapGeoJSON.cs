using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using BAMCIS.GeoJSON;
using Newtonsoft.Json.Linq;

namespace DGScope
{
    public static class GeoJSONMapExporter
    {
        public static string MapsToGeoJSON(VideoMapList maps)
        {
            List<Feature> features = new List<Feature>();
            foreach (var map in maps)
            {
                Feature feature = new Feature(MapToGeometryCollection(map));
                feature.Properties.Add("name", map.Name);
                feature.Properties.Add("number", map.Number);
                feature.Properties.Add("category", map.Category);
                feature.Properties.Add("mnemonic", map.Mnemonic);
                features.Add(feature);
            }
            FeatureCollection fc = new FeatureCollection(features);
            return fc.ToJson();
        }
        public static string MapToGeoJSON(VideoMap map)
        {
            
            FeatureCollection fc = new FeatureCollection(MapToFeatureList(map));
            return fc.ToJson();
        }

        private static List<Feature> MapToFeatureList(VideoMap map)
        {
            List<Feature> features = new List<Feature>();
            foreach (var line in map.Lines)
            {
                var lineString = LineToLineString(line);
                if (lineString != null)
                {
                    Feature feature = new Feature(lineString);
                    features.Add(feature);
                }
            }
            return features;
        }

        private static GeometryCollection MapToGeometryCollection(VideoMap map)
        {
            List<Geometry> linestrings = new List<Geometry>();
            foreach (var line in map.Lines)
            {
                var lineString = LineToLineString(line);
                if (lineString != null)
                    linestrings.Add(lineString);
            }
            return new GeometryCollection(linestrings);
        }

        private static LineString LineToLineString(Line line)
        {
            List<Position> positions = new List<Position>();
            if (Math.Abs(line.End1.Latitude) > 90 || Math.Abs(line.End2.Latitude) > 90 || Math.Abs(line.End1.Longitude) > 180 || Math.Abs(line.End2.Longitude) > 180)
                return null;
            positions.Add(new Position(line.End1.Longitude, line.End1.Latitude));
            positions.Add(new Position(line.End2.Longitude, line.End2.Latitude));
            LineString lineString = new LineString(positions);
            return lineString;
        }

        public static void MapToGeoJSONFile(VideoMap map, string filename)
        {
            File.WriteAllText(filename, MapToGeoJSON(map));
        }
        public static void MapsToGeoJSONFile(VideoMapList maps, string filename)
        {
            File.WriteAllText(filename, MapsToGeoJSON(maps));
        }

        public static VideoMapList GeoJSONFileToMaps(string path)
        {
            var json = File.ReadAllText(path);
            try
            {
                return GeoJSONToMaps(json);
            }
            catch (Exception ex) { System.Windows.Forms.MessageBox.Show("Error with video map " + path + "\r\n" + ex.Message); }
            return null;
        }

        /// <summary>
        /// <summary>
        /// Preprocesses GeoJSON to fix invalid LineStrings with fewer than 2 positions.
        /// LineStrings with 0 or 1 position are removed to allow the file to be parsed.
        /// </summary>
        private static string FixInvalidLineStrings(string json)
        {
            try
            {
                var obj = JObject.Parse(json);
                FixGeometriesRecursive(obj);
                return obj.ToString();
            }
            catch (Exception ex)
            {
                // If JSON parsing fails, log and return original JSON
                System.Diagnostics.Debug.WriteLine($"Error preprocessing GeoJSON: {ex.Message}");
                return json;
            }
        }

        private static void FixGeometriesRecursive(JToken token)
        {
            if (token == null) return;

            if (token is JObject jObj)
            {
                // Handle LineString type
                var typeValue = jObj["type"]?.Value<string>();
                if (typeValue == "LineString")
                {
                    var coordinates = jObj["coordinates"] as JArray;
                    if (coordinates != null && coordinates.Count < 2)
                    {
                        // Mark for deletion - will be handled by parent
                        jObj["__delete__"] = true;
                    }
                    return; // Don't process children of LineString
                }

                // Handle GeometryCollection
                if (typeValue == "GeometryCollection")
                {
                    var geometries = jObj["geometries"] as JArray;
                    if (geometries != null)
                    {
                        // First, process all geometries
                        foreach (var geom in geometries)
                        {
                            FixGeometriesRecursive(geom);
                        }
                        
                        // Then remove marked geometries
                        var validGeometries = new JArray(geometries.Where(g => 
                            !(g is JObject gObj && gObj["__delete__"]?.Value<bool>() == true)));
                        jObj["geometries"] = validGeometries;
                        return;
                    }
                }

                // Handle Feature with geometry
                if (typeValue == "Feature")
                {
                    var geometry = jObj["geometry"];
                    if (geometry != null)
                    {
                        FixGeometriesRecursive(geometry);
                        // If geometry was marked for deletion, set it to null
                        if (geometry is JObject geomObj && geomObj["__delete__"]?.Value<bool>() == true)
                        {
                            jObj["geometry"] = null;
                        }
                    }
                    return;
                }

                // Handle FeatureCollection
                if (typeValue == "FeatureCollection")
                {
                    var features = jObj["features"] as JArray;
                    if (features != null)
                    {
                        foreach (var feature in features)
                        {
                            FixGeometriesRecursive(feature);
                        }
                    }
                    return;
                }

                // Handle MultiLineString
                if (typeValue == "MultiLineString")
                {
                    var coordinates = jObj["coordinates"] as JArray;
                    if (coordinates != null)
                    {
                        // Filter out LineStrings with less than 2 coordinates
                        var validLines = new JArray(coordinates.Where(line =>
                            line is JArray lineArray && lineArray.Count >= 2));
                        jObj["coordinates"] = validLines;
                    }
                    return;
                }

                // Handle Polygon - check exterior and interior rings
                if (typeValue == "Polygon")
                {
                    var coordinates = jObj["coordinates"] as JArray;
                    if (coordinates != null)
                    {
                        var validRings = new JArray();
                        foreach (var ring in coordinates)
                        {
                            if (ring is JArray ringArray && ringArray.Count >= 2)
                            {
                                validRings.Add(ring);
                            }
                        }
                        jObj["coordinates"] = validRings;
                    }
                    return;
                }

                // Recursively process all other properties
                foreach (var prop in jObj.Properties().ToList())
                {
                    if (prop.Name != "__delete__")
                    {
                        FixGeometriesRecursive(prop.Value);
                    }
                }
            }
            else if (token is JArray jArr)
            {
                for (int i = 0; i < jArr.Count; i++)
                {
                    FixGeometriesRecursive(jArr[i]);
                }
            }
        }

        public static VideoMapList GeoJSONToMaps(string json)
        {
            VideoMapList maps = new VideoMapList();
            GeoJsonConfig.IgnoreLatitudeValidation = true;
            GeoJsonConfig.IgnoreLongitudeValidation = true;
            
            // Preprocess JSON to handle invalid LineStrings with fewer than 2 positions
            json = FixInvalidLineStrings(json);
            
            try
            {
                var data = GeoJson.FromJson(json);
                switch (data.Type)
            {
                case GeoJsonType.FeatureCollection:
                    var featureCollection = data as FeatureCollection;

                    // Check if this is a GeometryCollection-based format (multiple maps per file)
                    if (featureCollection.Features.Any(x => x.Geometry != null && x.Geometry.Type == GeoJsonType.GeometryCollection))
                    {
                        // Each feature with GeometryCollection becomes its own map
                        foreach (var feature in featureCollection.Features.Where(x => x.Geometry != null && x.Geometry.Type == GeoJsonType.GeometryCollection))
                        {
                            VideoMap newmap = new VideoMap();
                            var geometryCollection = feature.Geometry as GeometryCollection;

                            // Extract metadata from feature properties
                            if (feature.Properties.ContainsKey("name"))
                                newmap.Name = feature.Properties["name"];
                            if (feature.Properties.ContainsKey("number"))
                                newmap.Number = (int)feature.Properties["number"];
                            if (feature.Properties.ContainsKey("mnemonic"))
                                newmap.Mnemonic = feature.Properties["mnemonic"];
                            if (feature.Properties.ContainsKey("category"))
                                newmap.Category = (MapCategory)(int)feature.Properties["category"];

                            // Process all geometries in the collection
                            foreach (var geometry in geometryCollection.Geometries)
                            {
                                var lines = GeometryToLines(geometry);
                                if (lines != null && lines.Count > 0)
                                {
                                    newmap.Lines.AddRange(lines);
                                }
                            }

                            if (newmap.Lines.Count > 0)
                            {
                                maps.Add(newmap);
                            }
                        }
                    }
                    else
                    {
                        // Standard format: all features combined into a single map
                        VideoMap map = new VideoMap();
                        map.Name = "Imported map - " + DateTime.Now.ToShortDateString() + " " + DateTime.Now.ToShortTimeString();

                        foreach (var feature in featureCollection.Features.Where(x => x.Geometry != null))
                        {
                            var lines = GeometryToLines(feature.Geometry);
                            if (lines != null && lines.Count > 0)
                            {
                                map.Lines.AddRange(lines);
                            }
                        }

                        if (map.Lines.Count > 0)
                        {
                            maps.Add(map);
                        }
                    }
                    break;
                case GeoJsonType.Feature:
                    // Single Feature at top level
                    var singleFeature = data as Feature;
                    if (singleFeature?.Geometry != null)
                    {
                        VideoMap featureMap = new VideoMap();
                        if (singleFeature.Properties.ContainsKey("name"))
                            featureMap.Name = singleFeature.Properties["name"];
                        else
                            featureMap.Name = "Imported map - " + DateTime.Now.ToShortDateString() + " " + DateTime.Now.ToShortTimeString();
                        if (singleFeature.Properties.ContainsKey("number"))
                            featureMap.Number = (int)singleFeature.Properties["number"];
                        if (singleFeature.Properties.ContainsKey("mnemonic"))
                            featureMap.Mnemonic = singleFeature.Properties["mnemonic"];
                        if (singleFeature.Properties.ContainsKey("category"))
                            featureMap.Category = (MapCategory)(int)singleFeature.Properties["category"];
                        var featureLines = GeometryToLines(singleFeature.Geometry);
                        if (featureLines != null && featureLines.Count > 0)
                        {
                            featureMap.Lines.AddRange(featureLines);
                            maps.Add(featureMap);
                        }
                    }
                    break;
                case GeoJsonType.LineString:
                case GeoJsonType.MultiLineString:
                case GeoJsonType.Polygon:
                case GeoJsonType.MultiPolygon:
                case GeoJsonType.GeometryCollection:
                    // Bare geometry at top level
                    var geomLines = GeometryToLines(data as Geometry);
                    if (geomLines != null && geomLines.Count > 0)
                    {
                        VideoMap geomMap = new VideoMap();
                        geomMap.Name = "Imported map - " + DateTime.Now.ToShortDateString() + " " + DateTime.Now.ToShortTimeString();
                        geomMap.Lines.AddRange(geomLines);
                        maps.Add(geomMap);
                    }
                    break;
            }
            return maps;
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"BAMCIS parsing failed: {ex.Message}. Attempting fallback JSON parsing.");
                // Fallback: try to extract geometries manually from the JSON
                try
                {
                    return TryManualGeoJSONParse(json);
                }
                catch (Exception fallbackEx)
                {
                    System.Diagnostics.Debug.WriteLine($"Fallback parsing also failed: {fallbackEx.Message}");
                    return maps; // Return empty maps
                }
            }
        }

        /// <summary>
        /// Fallback manual GeoJSON parsing when BAMCIS fails
        /// </summary>
        private static VideoMapList TryManualGeoJSONParse(string json)
        {
            var maps = new VideoMapList();
            var obj = JObject.Parse(json);
            var topType = obj["type"]?.Value<string>();

            if (topType == "FeatureCollection")
            {
                var features = obj["features"] as JArray;
                if (features != null)
                {
                    foreach (var feature in features)
                    {
                        if (feature["geometry"] != null)
                        {
                            var geometry = feature["geometry"];
                            var lines = ManualGeometryToLines(geometry);
                            if (lines != null && lines.Count > 0)
                            {
                                VideoMap map = new VideoMap();
                                if (feature["properties"]?["name"] != null)
                                    map.Name = feature["properties"]["name"].Value<string>();
                                if (feature["properties"]?["number"] != null)
                                    map.Number = feature["properties"]["number"].Value<int>();
                                if (feature["properties"]?["mnemonic"] != null)
                                    map.Mnemonic = feature["properties"]["mnemonic"].Value<string>();

                                map.Lines.AddRange(lines);
                                maps.Add(map);
                            }
                        }
                    }
                }
            }
            else if (topType == "Feature")
            {
                // Single Feature at top level
                if (obj["geometry"] != null)
                {
                    var lines = ManualGeometryToLines(obj["geometry"]);
                    if (lines != null && lines.Count > 0)
                    {
                        VideoMap map = new VideoMap();
                        if (obj["properties"]?["name"] != null)
                            map.Name = obj["properties"]["name"].Value<string>();
                        else
                            map.Name = "Imported map - " + DateTime.Now.ToShortDateString() + " " + DateTime.Now.ToShortTimeString();
                        map.Lines.AddRange(lines);
                        maps.Add(map);
                    }
                }
            }
            else
            {
                // Bare geometry at top level
                var lines = ManualGeometryToLines(obj);
                if (lines != null && lines.Count > 0)
                {
                    VideoMap map = new VideoMap();
                    map.Name = "Imported map - " + DateTime.Now.ToShortDateString() + " " + DateTime.Now.ToShortTimeString();
                    map.Lines.AddRange(lines);
                    maps.Add(map);
                }
            }

            return maps;
        }

        /// <summary>
        /// Manually extract lines from geometry without using BAMCIS
        /// </summary>
        private static List<Line> ManualGeometryToLines(JToken geometry)
        {
            if (geometry == null || !(geometry is JObject geometryObj)) return null;

            var typeStr = geometryObj["type"]?.Value<string>();
            var lines = new List<Line>();

            try
            {
                if (typeStr == "LineString")
                {
                    var coordinates = geometryObj["coordinates"] as JArray;
                    if (coordinates != null && coordinates.Count >= 2)
                    {
                        for (int i = 1; i < coordinates.Count; i++)
                        {
                            var pt1 = coordinates[i - 1];
                            var pt2 = coordinates[i];
                            if (pt1 is JArray && pt2 is JArray && pt1.Count() >= 2 && pt2.Count() >= 2)
                            {
                                double lon1 = pt1[0].Value<double>();
                                double lat1 = pt1[1].Value<double>();
                                double lon2 = pt2[0].Value<double>();
                                double lat2 = pt2[1].Value<double>();
                                lines.Add(new Line(new GeoPoint(lat1, lon1), new GeoPoint(lat2, lon2)));
                            }
                        }
                    }
                }
                else if (typeStr == "MultiLineString")
                {
                    var lineStrings = geometryObj["coordinates"] as JArray;
                    if (lineStrings != null)
                    {
                        foreach (var lineString in lineStrings)
                        {
                            if (lineString is JArray lsArray && lsArray.Count >= 2)
                            {
                                for (int i = 1; i < lsArray.Count; i++)
                                {
                                    var pt1 = lsArray[i - 1];
                                    var pt2 = lsArray[i];
                                    if (pt1 is JArray && pt2 is JArray && pt1.Count() >= 2 && pt2.Count() >= 2)
                                    {
                                        double lon1 = pt1[0].Value<double>();
                                        double lat1 = pt1[1].Value<double>();
                                        double lon2 = pt2[0].Value<double>();
                                        double lat2 = pt2[1].Value<double>();
                                        lines.Add(new Line(new GeoPoint(lat1, lon1), new GeoPoint(lat2, lon2)));
                                    }
                                }
                            }
                        }
                    }
                }
                else if (typeStr == "Polygon")
                {
                    var rings = geometryObj["coordinates"] as JArray;
                    if (rings != null)
                    {
                        foreach (var ring in rings)
                        {
                            if (ring is JArray ringArray && ringArray.Count >= 2)
                            {
                                for (int i = 1; i < ringArray.Count; i++)
                                {
                                    var pt1 = ringArray[i - 1];
                                    var pt2 = ringArray[i];
                                    if (pt1 is JArray && pt2 is JArray && pt1.Count() >= 2 && pt2.Count() >= 2)
                                    {
                                        double lon1 = pt1[0].Value<double>();
                                        double lat1 = pt1[1].Value<double>();
                                        double lon2 = pt2[0].Value<double>();
                                        double lat2 = pt2[1].Value<double>();
                                        lines.Add(new Line(new GeoPoint(lat1, lon1), new GeoPoint(lat2, lon2)));
                                    }
                                }
                            }
                        }
                    }
                }
                else if (typeStr == "MultiPolygon")
                {
                    var polygons = geometryObj["coordinates"] as JArray;
                    if (polygons != null)
                    {
                        foreach (var polygon in polygons)
                        {
                            if (polygon is JArray rings)
                            {
                                foreach (var ring in rings)
                                {
                                    if (ring is JArray ringArray && ringArray.Count >= 2)
                                    {
                                        for (int i = 1; i < ringArray.Count; i++)
                                        {
                                            var pt1 = ringArray[i - 1];
                                            var pt2 = ringArray[i];
                                            if (pt1 is JArray && pt2 is JArray && pt1.Count() >= 2 && pt2.Count() >= 2)
                                            {
                                                double lon1 = pt1[0].Value<double>();
                                                double lat1 = pt1[1].Value<double>();
                                                double lon2 = pt2[0].Value<double>();
                                                double lat2 = pt2[1].Value<double>();
                                                lines.Add(new Line(new GeoPoint(lat1, lon1), new GeoPoint(lat2, lon2)));
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                else if (typeStr == "GeometryCollection")
                {
                    var geometries = geometryObj["geometries"] as JArray;
                    if (geometries != null)
                    {
                        foreach (var geom in geometries)
                        {
                            var geomLines = ManualGeometryToLines(geom);
                            if (geomLines != null)
                                lines.AddRange(geomLines);
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"Error in manual geometry parsing: {ex.Message}");
            }

            return lines.Count > 0 ? lines : null;
        }

        /// <summary>
        /// Converts any GeoJSON geometry type to line segments for rendering
        /// </summary>
        private static List<Line> GeometryToLines(Geometry geometry)
        {
            if (geometry == null) return null;

            switch (geometry.Type)
            {
                case GeoJsonType.LineString:
                    return LineStringToLines(geometry as LineString);

                case GeoJsonType.Polygon:
                    return PolygonToLines(geometry as BAMCIS.GeoJSON.Polygon);

                case GeoJsonType.MultiLineString:
                    return MultiLineStringToLines(geometry as MultiLineString);

                case GeoJsonType.MultiPolygon:
                    return MultiPolygonToLines(geometry as BAMCIS.GeoJSON.MultiPolygon);

                case GeoJsonType.GeometryCollection:
                    // Recursively process all geometries in the collection
                    var allLines = new List<Line>();
                    var collection = geometry as GeometryCollection;
                    foreach (var geom in collection.Geometries)
                    {
                        var lines = GeometryToLines(geom);
                        if (lines != null && lines.Count > 0)
                        {
                            allLines.AddRange(lines);
                        }
                    }
                    return allLines.Count > 0 ? allLines : null;

                default:
                    // Point, MultiPoint not supported for line rendering
                    return null;
            }
        }

        private static List<Line> LineStringToLines(LineString lineString)
        {
            if (lineString == null) return null;
            var points = lineString.Coordinates.ToArray();
            var lines = new List<Line>();
            for (int i = 1; i < points.Length; i++)
            {
                var end1 = new GeoPoint(points[i].Latitude, points[i].Longitude);
                var end2 = new GeoPoint(points[i - 1].Latitude, points[i - 1].Longitude);
                lines.Add(new Line(end1, end2));
            }
            return lines;
        }

        /// <summary>
        /// Converts a Polygon to line segments (exterior ring + interior holes)
        /// </summary>
        private static List<Line> PolygonToLines(BAMCIS.GeoJSON.Polygon polygon)
        {
            if (polygon == null || polygon.Coordinates == null || !polygon.Coordinates.Any())
                return null;

            var lines = new List<Line>();

            // Process all rings (exterior + holes)
            foreach (var ring in polygon.Coordinates)
            {
                var ringLines = LinearRingToLines(ring);
                if (ringLines != null && ringLines.Count > 0)
                {
                    lines.AddRange(ringLines);
                }
            }

            return lines.Count > 0 ? lines : null;
        }

        /// <summary>
        /// Converts a LinearRing (closed loop) to line segments
        /// </summary>
        private static List<Line> LinearRingToLines(LinearRing ring)
        {
            if (ring == null || ring.Coordinates == null || ring.Coordinates.Count() < 2)
                return null;

            var points = ring.Coordinates.ToArray();
            var lines = new List<Line>();

            // Connect each point to the next (ring automatically closes)
            for (int i = 1; i < points.Length; i++)
            {
                var end1 = new GeoPoint(points[i].Latitude, points[i].Longitude);
                var end2 = new GeoPoint(points[i - 1].Latitude, points[i - 1].Longitude);
                lines.Add(new Line(end1, end2));
            }

            return lines;
        }

        /// <summary>
        /// Converts a MultiLineString to line segments
        /// </summary>
        private static List<Line> MultiLineStringToLines(MultiLineString multiLineString)
        {
            if (multiLineString == null || multiLineString.Coordinates == null || !multiLineString.Coordinates.Any())
                return null;

            var lines = new List<Line>();

            foreach (var lineString in multiLineString.Coordinates)
            {
                var lineStringLines = LineStringToLines(lineString);
                if (lineStringLines != null && lineStringLines.Count > 0)
                {
                    lines.AddRange(lineStringLines);
                }
            }

            return lines.Count > 0 ? lines : null;
        }

        /// <summary>
        /// Converts a MultiPolygon to line segments
        /// </summary>
        private static List<Line> MultiPolygonToLines(BAMCIS.GeoJSON.MultiPolygon multiPolygon)
        {
            if (multiPolygon == null || multiPolygon.Coordinates == null || !multiPolygon.Coordinates.Any())
                return null;

            var lines = new List<Line>();

            foreach (var polygon in multiPolygon.Coordinates)
            {
                var polygonLines = PolygonToLines(polygon);
                if (polygonLines != null && polygonLines.Count > 0)
                {
                    lines.AddRange(polygonLines);
                }
            }

            return lines.Count > 0 ? lines : null;
        }
    }
}

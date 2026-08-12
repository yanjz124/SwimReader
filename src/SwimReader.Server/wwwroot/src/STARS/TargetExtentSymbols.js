// Ported 1:1 from _source/STARS/TargetExtentSymbols.cs
// namespace DGScope.STARS
// [Serializable()] [TypeConverter(typeof(ExpandableObjectConverter))] [JsonObject]
import { RadarType } from "../Radar.js";

export class TargetExtentSymbols {
    static #acpangle = Math.PI / 2048; // static double acpangle
    SearchTargets = new SearchTargetParams();                 // SearchTargetParams
    FusedTracks = new FusedTrackTargetSymbolParams();         // FusedTrackTargetSymbolParams
    BeaconTargets = new BeaconTargetParams();                 // BeaconTargetParams
    MultiRadarTargets = new MultiRadarTargetParams();         // MultiRadarTargetParams
    PositionSymbolOffset = 0;                                 // int
    FMATargetSymbols = new FMATargetSymbolParams();           // FMATargetSymbolParams

    PositionSymbolLocation(aircraft, radar) { // GeoPoint
        let loc = aircraft.SweptLocation(radar);
        if (radar.RadarType !== RadarType.SLANT_RANGE || this.PositionSymbolOffset === 0) return loc;
        let bearing = radar.Location.BearingTo(loc);
        return loc.FromPoint(this.PositionSymbolOffset / 32, bearing);
    }
    TargetWidth(aircraft, radar, scale, pixelscale) { // double
        let size = 0;
        let minsize = 0;
        let loc = aircraft.SweptLocation(radar);
        switch (radar.RadarType) {
            case RadarType.SLANT_RANGE: {
                let dist = radar.Location.DistanceTo(loc);
                let acp;
                if (dist <= 10) {
                    acp = this.SearchTargets.AzimuthExtents.Ten;
                }
                else if (dist <= 20) {
                    let diff = this.SearchTargets.AzimuthExtents.Twenty - this.SearchTargets.AzimuthExtents.Ten;
                    let diffdist = (dist - 10) / 10;
                    acp = this.SearchTargets.AzimuthExtents.Ten + (diffdist * diff);
                }
                else if (dist <= 30) {
                    let diff = this.SearchTargets.AzimuthExtents.Thirty - this.SearchTargets.AzimuthExtents.Twenty;
                    let diffdist = (dist - 20) / 10;
                    acp = this.SearchTargets.AzimuthExtents.Twenty + (diffdist * diff);
                }
                else if (dist <= 40) {
                    let diff = this.SearchTargets.AzimuthExtents.Forty - this.SearchTargets.AzimuthExtents.Thirty;
                    let diffdist = (dist - 30) / 10;
                    acp = this.SearchTargets.AzimuthExtents.Thirty + (diffdist * diff);
                }
                else if (dist <= 50) {
                    let diff = this.SearchTargets.AzimuthExtents.Fifty - this.SearchTargets.AzimuthExtents.Forty;
                    let diffdist = (dist - 40) / 10;
                    acp = this.SearchTargets.AzimuthExtents.Forty + (diffdist * diff);
                }
                else if (dist <= 60) {
                    let diff = this.SearchTargets.AzimuthExtents.Sixty - this.SearchTargets.AzimuthExtents.Fifty;
                    let diffdist = (dist - 50) / 10;
                    acp = this.SearchTargets.AzimuthExtents.Fifty + (diffdist * diff);
                }
                else {
                    acp = this.SearchTargets.AzimuthExtents.Sixty;
                }
                let angle = acp * TargetExtentSymbols.#acpangle;
                minsize = ((this.SearchTargets.AzimuthExtentMinimum / 6076) * dist) / scale;
                size = dist * Math.tan(angle) / scale;
                if (minsize > size) {
                    size = minsize;
                }
                break;
            }
            case RadarType.FUSED:
                minsize = this.FusedTracks.MinimumPixelDimension * pixelscale;
                size = (this.FusedTracks.NormalSymbolDistanceDimension / 60.76) / scale;
                break;
            case RadarType.GROUND_RANGE:
                return this.MultiRadarTargets.SymbolWidth;
        }
        if (minsize > size) {
            return minsize;
        }
        return size;
    }
}

// (C# nested class TargetExtentSymbols.SearchTargetParams)
export class SearchTargetParams {
    RangeExtent = 0; // int
    // [DisplayName("Azimuth Extent")]
    AzimuthExtents = new AzimuthExtentValues(); // AzimuthExtentValues
    AzimuthExtentMinimum = 0; // int
}

// (C# nested class TargetExtentSymbols.SearchTargetParams.AzimuthExtentValues)
export class AzimuthExtentValues {
    // [DisplayName("0 to 10 nmi")]
    Ten = 28;    // int
    // [DisplayName("20 nmi")]
    Twenty = 19; // int
    // [DisplayName("30 nmi")]
    Thirty = 16; // int
    // [DisplayName("40 nmi")]
    Forty = 12;  // int
    // [DisplayName("50 nmi")]
    Fifty = 11;  // int
    // [DisplayName("60 nmi")]
    Sixty = 9;   // int
}

// (C# nested class TargetExtentSymbols.FusedTrackTargetSymbolParams)
export class FusedTrackTargetSymbolParams {
    MinimumPixelDimension = 0;         // int
    NormalSymbolDistanceDimension = 0; // int
    ReducedSymbolDistanceDimension = 0; // int
    SymbolOpacity = 0;                 // int
    LowConfidencePrimarySymbolRatio = 0; // int
    PrimarySymbolMaximumPixelDimension = 0; // int
}

// (C# nested class TargetExtentSymbols.BeaconTargetParams)
export class BeaconTargetParams {
    RangeExtent = 0;        // int
    AzimuthExtentFactor = 0; // int
    RangeOffset = 0;        // int
}

// (C# nested class TargetExtentSymbols.MultiRadarTargetParams)
export class MultiRadarTargetParams {
    SymbolFillRange = 0;      // int
    SymbolHeight = 0;         // int
    SymbolWidth = 0;          // int
    UncorrSymbolPlotSize = 8; // int
}

// (C# nested class TargetExtentSymbols.FMATargetSymbolParams)
export class FMATargetSymbolParams {
    Radius = 0;    // int
    Thickness = 0; // int
}

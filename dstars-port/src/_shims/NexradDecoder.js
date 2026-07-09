// Stub for the external NexradDecoder library (scope/NexradDecoder project — outside the
// 73-file main-project scope). It decodes NWS NEXRAD binary radial products; a faithful port
// is a separate effort. NexradDisplay only uses these for WxRadarMode.NWSNexrad; the default
// WxRadarMode.ScopeServer path does NOT use the decoder, so weather still works there.
//
// TODO: port NexradDecoder proper if the NWS binary path is needed.

export class DescriptionBlock {
    Latitude = 0; Longitude = 0; Code = 0; ProductSpecific_3 = 0;
}

export class RadialSymbologyBlock {
    LayerNumberOfRangeBins = 0;
    NumberOfRadials = 0;
    Radials = []; // Radial[] { StartAngle, AngleDelta, ColorValues[], Values[] }
}

export class RadialPacketDecoder {
    setStreamResource(stream) { /* NWS binary decode deferred */ }
    setFileResource(path) { /* NWS binary decode deferred */ }
    parseMHB() { /* message header block */ }
    parsePDB() { return new DescriptionBlock(); } // product description block
    parsePSB() { return new RadialSymbologyBlock(); } // product symbology block
}

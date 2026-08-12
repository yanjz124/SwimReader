// Ported 1:1 from _source/Metars.cs
// namespace DGScope
// XSD-generated DTOs for the aviationweather.gov ADDS XML METAR response. The C# uses
// private `*Field` backing fields + trivial passthrough properties; flattened here to public
// fields (behaviorally identical). Attributes preserved as comments. uint/byte/ushort/decimal
// -> number; DateTime -> Date/null; object/arrays -> null.

/// <remarks/>
// [Serializable] [DesignerCategory("code")] [XmlType(AnonymousType=true)] [XmlRoot(Namespace="", IsNullable=false)]
export class response {
    request_index = 0;   // uint
    data_source = null;  // responseData_source
    request = null;      // responseRequest
    errors = null;       // object
    warnings = null;     // object
    time_taken_ms = 0;   // byte
    data = null;         // responseData
    // [XmlAttribute]
    version = 0;         // decimal
}

/// <remarks/>
export class responseData_source {
    // [XmlAttribute]
    name = null; // string
}

/// <remarks/>
export class responseRequest {
    // [XmlAttribute]
    type = null; // string
}

/// <remarks/>
export class responseData {
    // [XmlElement("METAR")]
    METAR = null;       // responseDataMETAR[]
    // [XmlAttribute]
    num_results = 0;    // ushort
}

/// <remarks/>
export class responseDataMETAR {
    // [XmlElement("altim_in_hg", typeof(decimal))] ... (many typed choice elements) ...
    // [XmlChoiceIdentifier("ItemsElementName")]
    Items = null;            // object[]
    // [XmlElement("ItemsElementName")] [XmlIgnore]
    ItemsElementName = null; // ItemsChoiceType1[]
}

/// <remarks/>
export class responseDataMETARQuality_control_flags {
    // [XmlElement("auto"/"auto_station"/"corrected"/... typeof(string))]
    // [XmlChoiceIdentifier("ItemsElementName")]
    Items = null;            // string[]
    // [XmlElement("ItemsElementName")] [XmlIgnore]
    ItemsElementName = null; // ItemsChoiceType[]
}

/// <remarks/>
// [Serializable] [XmlType(IncludeInSchema=false)]
export const ItemsChoiceType = Object.freeze({
    auto: 0,
    auto_station: 1,
    corrected: 2,
    freezing_rain_sensor_off: 3,
    lightning_sensor_off: 4,
    maintenance_indicator_on: 5,
    no_signal: 6,
    present_weather_sensor_off: 7,
});

/// <remarks/>
export class responseDataMETARSky_condition {
    // [XmlAttribute]
    sky_cover = null;                    // string
    // [XmlAttribute]
    cloud_base_ft_agl = 0;               // ushort
    // [XmlIgnore]
    cloud_base_ft_aglSpecified = false;  // bool
}

/// <remarks/>
// [Serializable] [XmlType(IncludeInSchema=false)]
export const ItemsChoiceType1 = Object.freeze({
    altim_in_hg: 0,
    dewpoint_c: 1,
    elevation_m: 2,
    flight_category: 3,
    latitude: 4,
    longitude: 5,
    maxT24hr_c: 6,
    maxT_c: 7,
    metar_type: 8,
    minT24hr_c: 9,
    minT_c: 10,
    observation_time: 11,
    pcp24hr_in: 12,
    pcp6hr_in: 13,
    precip_in: 14,
    quality_control_flags: 15,
    raw_text: 16,
    sea_level_pressure_mb: 17,
    sky_condition: 18,
    station_id: 19,
    temp_c: 20,
    three_hr_pressure_tendency_mb: 21,
    vert_vis_ft: 22,
    visibility_statute_mi: 23,
    wind_dir_degrees: 24,
    wind_gust_kt: 25,
    wind_speed_kt: 26,
    wx_string: 27,
});

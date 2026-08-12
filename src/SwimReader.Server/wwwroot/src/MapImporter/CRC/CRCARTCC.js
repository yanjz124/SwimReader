// Ported 1:1 from _source/MapImporter/CRC/CRCARTCC.cs
// namespace DGScope.MapImporter.CRC
// Pure JSON DTO data classes (Newtonsoft-deserialized). C# auto-prop defaults:
// reference types / arrays -> null; int/float -> 0; bool -> false; DateTime -> null.

export class CRCARTCC {
    id = null;                 // string
    lastUpdatedAt = null;      // DateTime
    facility = null;           // Facility
    visibilityCenters = null;  // Visibilitycenter[]
    aliasesLastUpdatedAt = null; // DateTime
    videoMaps = null;          // Videomap[]
}

export class Eramconfiguration {
    nasId = null;                          // string
    geoMaps = null;                        // Geomap[]
    emergencyChecklist = null;             // string[]
    positionReliefChecklist = null;        // string[]
    internalAirports = null;               // string[]
    beaconCodeBanks = null;                // Beaconcodebank[]
    neighboringStarsConfigurations = null; // Neighboringstarsconfiguration[]
    neighboringCaatsConfigurations = null; // object[]
    atopHandoffLetter = null;              // object
    referenceFixes = null;                 // string[]
    asrSites = null;                       // Asrsite[]
    conflictAlertFloor = 0;                // int
}

export class Geomap {
    id = null;          // string
    name = null;        // string
    labelLine1 = null;  // string
    labelLine2 = null;  // string
    filterMenu = null;  // Filtermenu[]
    bcgMenu = null;     // string[]
    videoMapIds = null; // string[]
}

export class Filtermenu {
    id = null;         // string
    labelLine1 = null; // string
    labelLine2 = null; // string
}

export class Beaconcodebank {
    id = null;       // string
    category = null; // string
    priority = null; // string
    subset = null;   // int?
    start = 0;       // int
    end = 0;         // int
}

export class Neighboringstarsconfiguration {
    id = null;                    // string
    facilityId = null;            // string
    starsId = null;               // string
    singleCharacterStarsId = null; // string
    twoCharacterStarsId = null;   // object
    fieldELetter = null;          // string
    fieldEFormat = null;          // string
}

export class Asrsite {
    id = null;       // string
    asrId = null;    // string
    location = null; // Location
    range = 0;       // int
    ceiling = 0;     // int
}

export class Location {
    lat = 0; // float
    lon = 0; // float
}

export class Facility {
    id = null;                       // string
    type = null;                     // string
    name = null;                     // string
    childFacilities = null;          // Facility[]
    eramConfiguration = null;        // object
    edstConfiguration = null;        // object
    starsConfiguration = null;       // Starsconfiguration?
    towerCabConfiguration = null;    // Towercabconfiguration?
    asdexConfiguration = null;       // Asdexconfiguration?
    tdlsConfiguration = null;        // Tdlsconfiguration?
    flightStripsConfiguration = null; // Flightstripsconfiguration?
    positions = null;                // Position[]
    neighboringFacilityIds = null;   // string[]
    nonNasFacilityIds = null;        // object[]
    toString() {
        return this.id;
    }
}

export class Starsconfiguration {
    areas = null;                    // Area[]
    internalAirports = null;         // string[]
    beaconCodeBanks = null;          // Beaconcodebank[]
    rpcs = null;                     // object[]
    primaryScratchpadRules = null;   // Primaryscratchpadrule[]
    secondaryScratchpadRules = null; // object[]
    rnavPatterns = null;             // string[]
    allow4CharacterScratchpad = false; // bool
    starsHandoffIds = null;          // Starshandoffid[]
    videoMapIds = null;              // string[]
    mapGroups = null;                // Mapgroup[]
}

export class Area {
    id = null;                          // string
    name = null;                        // string
    visibilityCenter = null;            // Visibilitycenter
    surveillanceRange = 0;              // int
    ssaAirports = null;                 // string[]
    towerListConfigurations = null;     // Towerlistconfiguration[]
    ldbBeaconCodesInhibited = false;    // bool
    pdbGroundSpeedInhibited = false;    // bool
    displayRequestedAltInFdb = false;   // bool
    useVfrPositionSymbol = false;       // bool
    showDestinationDepartures = false;  // bool
    showDestinationSatelliteArrivals = false; // bool
    showDestinationPrimaryArrivals = false;   // bool
}

export class Visibilitycenter {
    lat = 0; // float
    lon = 0; // float
}

export class Towerlistconfiguration {
    id = null;        // string
    airportId = null; // string
    range = 0;        // int
}

export class Primaryscratchpadrule {
    id = null;            // string
    airportIds = null;    // string[]
    searchPattern = null; // string
    minAltitude = null;   // int?
    maxAltitude = null;   // int?
    template = null;      // string
}

export class Starshandoffid {
    id = null;         // string
    facilityId = null; // string
    handoffNumber = 0; // int
}

export class Mapgroup {
    id = null;    // string
    mapIds = null; // int?[]
    tcps = null;  // string[]
}

export class Towercabconfiguration {
    videoMapId = null;              // string
    defaultRotation = 0;            // int
    defaultZoomRange = 0;           // int
    aircraftVisibilityCeiling = 0;  // int
    towerLocation = null;           // Towerlocation
}

export class Towerlocation {
    lat = 0; // float
    lon = 0; // float
}

export class Asdexconfiguration {
    videoMapId = null;             // string
    defaultRotation = 0;           // int
    defaultZoomRange = 0;          // int
    targetVisibilityRange = 0;     // int
    targetVisibilityCeiling = 0;   // int
    fixRules = null;               // Fixrule[]
    useDestinationIdAsFix = false; // bool
    runwayConfigurations = null;   // object[]
    positions = null;              // Position[]
    defaultPositionId = null;      // string
    towerLocation = null;          // Towerlocation
}

export class Fixrule {
    id = null;            // string
    searchPattern = null; // string
    fixId = null;         // string
}

export class Position {
    id = null;         // string
    name = null;       // string
    runwayIds = null;  // object[]
    toString() {
        return this.name;
    }
}

export class Tdlsconfiguration {
    mandatorySid = false;        // bool
    mandatoryClimbout = false;   // bool
    mandatoryClimbvia = false;   // bool
    mandatoryInitialAlt = false; // bool
    mandatoryDepFreq = false;    // bool
    mandatoryExpect = false;     // bool
    mandatoryContactInfo = false; // bool
    mandatoryLocalInfo = false;  // bool
    sids = null;                 // Sid[]
    climbouts = null;            // Climbout[]
    climbvias = null;            // object[]
    initialAlts = null;          // Initialalt[]
    depFreqs = null;             // Depfreq[]
    expects = null;              // Expect[]
    contactInfos = null;         // Contactinfo[]
    localInfos = null;           // Localinfo[]
    defaultSidId = null;         // string
    defaultTransitionId = null;  // object
}

export class Sid {
    name = null;        // string
    id = null;          // string
    transitions = null; // Transition[]
}

export class Transition {
    name = null;              // string
    id = null;                // string
    firstRoutePoint = null;   // object
    defaultExpect = null;     // string
    defaultClimbout = null;   // object
    defaultClimbvia = null;   // object
    defaultInitialAlt = null; // string
    defaultDepFreq = null;    // object
    defaultContactInfo = null; // string
    defaultLocalInfo = null;  // string
}

export class Climbout {
    id = null;    // string
    value = null; // string
}

export class Initialalt {
    id = null;    // string
    value = null; // string
}

export class Depfreq {
    id = null;    // string
    value = null; // string
}

export class Expect {
    id = null;    // string
    value = null; // string
}

export class Contactinfo {
    id = null;    // string
    value = null; // string
}

export class Localinfo {
    id = null;    // string
    value = null; // string
}

export class Flightstripsconfiguration {
    stripBays = null;                    // Stripbay[]
    externalBays = null;                 // object[]
    displayDestinationAirportIds = false; // bool
    displayBarcodes = false;             // bool
    enableArrivalStrips = false;         // bool
    enableSeparateArrDepPrinters = false; // bool
}

export class Stripbay {
    id = null;          // string
    name = null;        // string
    numberOfRacks = 0;  // int
}

export class Runwayconfiguration {
    id = null;                  // string
    name = null;                // string
    arrivalRunwayIds = null;    // string[]
    departureRunwayIds = null;  // string[]
    holdShortRunwayPairs = null; // object[]
}

export class Climbvia {
    id = null;    // string
    value = null; // string
}

export class Externalbay {
    facilityId = null; // string
    bayId = null;      // string
}

export class Videomap {
    id = null;                   // string
    name = null;                 // string
    tags = null;                 // string[]
    shortName = null;            // string
    sourceFileName = null;       // string
    lastUpdatedAt = null;        // DateTime
    starsBrightnessCategory = null; // string
    starsId = null;              // int?
    starsAlwaysVisible = false;  // bool
    tdmOnly = false;             // bool
}

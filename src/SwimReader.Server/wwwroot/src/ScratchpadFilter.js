// Ported 1:1 from _source/ScratchpadFilter.cs
// namespace DGScope

export class ScratchpadFilter {
    ScratchpadValue = null;                              // string
    ScratchpadNum = 1;                                   // int
    ScratchpadFilterType = ScratchpadFilterType.Exclusion; // ScratchpadFilterType

    Match(aircraft) { // bool Match(Aircraft aircraft)
        if (aircraft == null) return false;
        switch (this.ScratchpadNum) {
            case 1:
                if (aircraft.Scratchpad === this.ScratchpadValue) return true;
                return false;
            case 2:
                if (aircraft.Scratchpad2 === this.ScratchpadValue) return true;
                return false;
            default:
                return false;
        }
    }

    toString() {
        return this.ScratchpadValue;
    }
}

export const ScratchpadFilterType = Object.freeze({
    Exclusion: 0,
    Ineligible: 1,
});

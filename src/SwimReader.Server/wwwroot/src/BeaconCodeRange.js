// Ported 1:1 from _source/BeaconCodeRange.cs
// namespace DGScope
// Convert.ToString(x, 8) / Convert.ToInt32(s, 8) are base-8 (octal) conversions
// -> Number.prototype.toString(8) / parseInt(s, 8).

export class BeaconCodeRange {
    #start = 0;    // int
    #end = null;   // int?

    get Begin() { // string
        return this.#start.toString(8).padStart(4, '0'); // Convert.ToString(start,8).PadLeft(4,'0')
    }
    set Begin(value) {
        this.#start = parseInt(value, 8); // Convert.ToInt32(value, 8)
    }

    get End() { // string?
        if (this.#end == null) {
            return null;
        }
        return this.#end.toString(8).padStart(4, '0'); // Convert.ToString(end.Value,8).PadLeft(4,'0')
    }
    set End(value) {
        if (!(value == null || value === "")) { // !string.IsNullOrEmpty(value)
            this.#end = parseInt(value, 8); // Convert.ToInt32(value, 8)
        } else {
            this.#end = null;
        }
    }

    toString() {
        if (this.#end == null) {
            return this.Begin;
        }
        return this.Begin + " - " + this.End;
    }

    IsInRange(squawk) { // bool
        const beacon = {}; // out int beacon
        if (!this.#TryParse(squawk, beacon)) {
            return false;
        }
        if (this.#end == null) {
            return beacon.value === this.#start;
        }
        return beacon.value >= this.#start && beacon.value <= this.#end;
    }

    #TryParse(squawk, beacon_int /* out int */) { // private bool
        beacon_int.value = 0;
        if (squawk == null) {
            return false;
        }
        let m = squawk.match(/[0-7]{4}/); // Regex.Match(squawk, "[0-7]{4}")
        if (m == null) { // !m.Success
            return false;
        }
        beacon_int.value = parseInt(m[0], 8); // Convert.ToInt32(m.Value, 8)
        return true;
    }
}

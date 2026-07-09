// Ported 1:1 from _source/STARS/ClockPhase.cs
// namespace DGScope.STARS
// using Newtonsoft.Json;  -> [JsonObject] dropped
// [Serializable()]
// [TypeConverter(typeof(ExpandableObjectConverter))]
// [JsonObject]
export class ClockPhase {
    static #timer = null;      // System.Threading.Timer  (mapped to setTimeout re-arm shim)
    static #phase = 0;         // int
    static #phasecount = 0;    // int
    PhaseSequence = undefined; // Sequence
    Interval1 = 2.0;           // double
    Interval2 = 1.5;           // double
    Interval3 = 2.0;           // double
    Interval4 = 1.5;           // double
    Interval5 = 0.0;           // double
    Interval6 = 0.0;           // double

    // [Browsable(false)]
    get Phase() { // int
        if (ClockPhase.#timer == null) {
            // new Timer(new TimerCallback(cbPhaseAdvance), null, 0, (int)(Interval1 * 1000));
            // Timer shim: fire after 0ms, callback re-arms via setTimeout (mirrors timer.Change).
            ClockPhase.#phase = 0;
            ClockPhase.#phasecount = 0;
            ClockPhase.#timer = setTimeout(() => this.#cbPhaseAdvance(null), 0);
        }
        return ClockPhase.#phase;
    }

    #cbPhaseAdvance(state) {
        switch (true) {
            // case Sequence.ONE_TWO_ONE_THREE when phasecount == 0:
            case this.PhaseSequence === Sequence.ONE_TWO_ONE_THREE && ClockPhase.#phasecount === 0:
                ClockPhase.#phase = 1;
                ClockPhase.#phasecount = 1;
                // timer.Change((int)(Interval2 * 1000), (int)(Interval2 * 1000));
                ClockPhase.#timer = setTimeout(() => this.#cbPhaseAdvance(null), (this.Interval2 * 1000) | 0);
                break;
            // case Sequence.ONE_TWO_ONE_THREE when phasecount == 1:
            case this.PhaseSequence === Sequence.ONE_TWO_ONE_THREE && ClockPhase.#phasecount === 1:
                ClockPhase.#phase = 0;
                ClockPhase.#phasecount = 2;
                // timer.Change((int)(Interval3 * 1000), (int)(Interval3 * 1000));
                ClockPhase.#timer = setTimeout(() => this.#cbPhaseAdvance(null), (this.Interval3 * 1000) | 0);
                break;
            // case Sequence.ONE_TWO_ONE_THREE when phasecount == 2:
            case this.PhaseSequence === Sequence.ONE_TWO_ONE_THREE && ClockPhase.#phasecount === 2:
                ClockPhase.#phase = 2;
                ClockPhase.#phasecount = 3;
                // timer.Change((int)(Interval4 * 1000), (int)(Interval4 * 1000));
                ClockPhase.#timer = setTimeout(() => this.#cbPhaseAdvance(null), (this.Interval4 * 1000) | 0);
                break;
            // case Sequence.ONE_TWO_ONE_THREE when phasecount == 3:
            case this.PhaseSequence === Sequence.ONE_TWO_ONE_THREE && ClockPhase.#phasecount === 3:
                ClockPhase.#phase = 0;
                ClockPhase.#phasecount = 0;
                // timer.Change((int)(Interval1 * 1000), (int)(Interval1 * 1000));
                ClockPhase.#timer = setTimeout(() => this.#cbPhaseAdvance(null), (this.Interval1 * 1000) | 0);
                break;
        }
    }
}

export const Sequence = Object.freeze({
    ONE_TWO_ONE_THREE: 0,
});

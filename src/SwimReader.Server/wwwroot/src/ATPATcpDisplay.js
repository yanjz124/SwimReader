// Ported 1:1 from _source/ATPATcpDisplay.cs
// namespace DGScope
import { ATPAStatus } from "./ATPA.js";

export class ATPATCPDisplay {
    TCP = null;                      // string
    ConeType = ATPAStatus.Alert;     // ATPAStatus

    toString() {
        return this.TCP + " - " + this.ConeType;
    }
}

// Ported 1:1 from _source/STARS/TCP.cs
// namespace DGScope.STARS
// [Serializable()]
// [TypeConverter(typeof(ExpandableObjectConverter))]
export class TCP {
    Symbol = null;                    // string
    Name = null;                      // string
    HomeLocation = null;              // GeoPoint
    DCBMapList = new Array(36).fill(0); // int[] = new int[36]

    toString() {
        return this.Symbol + "(" + this.Name + ")";
    }
}

// Ported 1:1 from _source/VideoMap.cs
// namespace DGScope

export class VideoMap {
    Number = 0;      // int
    // [JsonIgnore] [Browsable(false)]
    VertexBuffer = 0; // int
    Name = null;      // string
    Mnemonic = null;  // string
    // [Browsable(false)]
    Visible = false;  // bool
    Category = MapCategory.A;   // MapCategory
    Lines = [];       // List<Line>

    getHashCode() { // override int GetHashCode()
        return this.Number;
    }
    equals(obj) { // override bool Equals(object obj)
        let otherVideoMap = (obj instanceof VideoMap) ? obj : null; // obj as VideoMap
        if (otherVideoMap != null) {
            return this.Number === otherVideoMap.Number; // Number.Equals(otherVideoMap.Number)
        }
        return false;
    }
    toString() {
        return this.Number + ": " + this.Name;
    }
}

export const MapCategory = Object.freeze({
    A: 0,
    B: 1,
});

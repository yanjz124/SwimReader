// Shim for System.Drawing value types used by DGScope.
// Faithful 1:1 reproduction of the .NET struct members (X/Y, Width/Height, …).
// Members are added here only as the port actually references them — no invention.

// System.Drawing.Color — ARGB, 0..255 per channel. FromArgb overloads dispatched by arg count.
export class Color {
    A = 255; R = 0; G = 0; B = 0;
    constructor(a = 255, r = 0, g = 0, b = 0) { this.A = a; this.R = r; this.G = g; this.B = b; }
    // Color.FromArgb(argb) | (r,g,b) | (a,r,g,b)
    static FromArgb(...args) {
        if (args.length === 1) {
            const v = args[0] >>> 0;
            return new Color((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
        }
        if (args.length === 3) return new Color(255, args[0], args[1], args[2]);
        // (alpha, red, green, blue) — note: OpenTK/GDI FromArgb(int a, Color) also exists; unused here.
        return new Color(args[0], args[1], args[2], args[3]);
    }
    ToArgb() { return ((this.A << 24) | (this.R << 16) | (this.G << 8) | this.B) | 0; }
    // canvas rgba() string
    toCanvasRgba() { return `rgba(${this.R},${this.G},${this.B},${this.A / 255})`; }

    // Named colors used by DGScope (System.Drawing.Color.*). Grow as referenced.
    static get Transparent() { return new Color(0, 255, 255, 255); }
    static get Black() { return new Color(255, 0, 0, 0); }
    static get White() { return new Color(255, 255, 255, 255); }
    static get Lime() { return new Color(255, 0, 255, 0); }
    static get Green() { return new Color(255, 0, 128, 0); }
    static get Red() { return new Color(255, 255, 0, 0); }
    static get Yellow() { return new Color(255, 255, 255, 0); }
    static get Cyan() { return new Color(255, 0, 255, 255); }
    static get Blue() { return new Color(255, 0, 0, 255); }
    static get Orange() { return new Color(255, 255, 165, 0); }
    static get Gray() { return new Color(255, 128, 128, 128); }
    static get Magenta() { return new Color(255, 255, 0, 255); }
    static get DarkGray() { return new Color(255, 169, 169, 169); }
}

// System.Drawing.StringFormat + related enums (text layout). Translated to canvas
// textAlign/textBaseline where used (see DCBButton.PaintText).
export const StringAlignment = Object.freeze({ Near: 0, Center: 1, Far: 2 });
export const StringFormatFlags = Object.freeze({ DirectionRightToLeft: 0x0001, DirectionVertical: 0x0002, NoWrap: 0x1000, LineLimit: 0x2000, NoClip: 0x4000 });
export class StringFormat {
    Alignment = StringAlignment.Near;     // horizontal
    LineAlignment = StringAlignment.Near; // vertical
    FormatFlags = 0;
}

// System.Drawing.ContentAlignment (GDI flag values).
export const ContentAlignment = Object.freeze({
    TopLeft: 1, TopCenter: 2, TopRight: 4,
    MiddleLeft: 16, MiddleCenter: 32, MiddleRight: 64,
    BottomLeft: 256, BottomCenter: 512, BottomRight: 1024,
});

// System.Windows.Forms.Padding (used via Control.Padding).
export class Padding {
    Left = 0; Top = 0; Right = 0; Bottom = 0;
    constructor(all = 0) { this.Left = all; this.Top = all; this.Right = all; this.Bottom = all; }
    static get Empty() { return new Padding(0); }
    get All() { return this.Left; }
    set All(v) { this.Left = v; this.Top = v; this.Right = v; this.Bottom = v; }
}

export class PointF {
    X = 0.0; // float
    Y = 0.0; // float
    constructor(x = 0.0, y = 0.0) { this.X = x; this.Y = y; }
}

// System.Drawing.Point (integer)
export class Point {
    X = 0; // int
    Y = 0; // int
    constructor(x = 0, y = 0) { this.X = x; this.Y = y; }
}

// System.Drawing.Size (integer)
export class Size {
    Width = 0;  // int
    Height = 0; // int
    constructor(width = 0, height = 0) { this.Width = width; this.Height = height; }
    get IsEmpty() { return this.Width === 0 && this.Height === 0; }
}

// System.Drawing.Rectangle (integer). Ctor overloads: (x,y,w,h) | (Point location, Size size).
export class Rectangle {
    X = 0; Y = 0; Width = 0; Height = 0;
    constructor(a, b, c, d) {
        if (c === undefined) { // Rectangle(Point location, Size size)
            this.X = a ? a.X : 0; this.Y = a ? a.Y : 0;
            this.Width = b ? b.Width : 0; this.Height = b ? b.Height : 0;
        } else {
            this.X = a; this.Y = b; this.Width = c; this.Height = d;
        }
    }
    get Left() { return this.X; }
    get Top() { return this.Y; }
    get Right() { return this.X + this.Width; }
    get Bottom() { return this.Y + this.Height; }
    get Location() { return new Point(this.X, this.Y); }
    get Size() { return new Size(this.Width, this.Height); }
    Contains(pt) { return this.X <= pt.X && pt.X < this.X + this.Width && this.Y <= pt.Y && pt.Y < this.Y + this.Height; }
}

// System.Drawing.GraphicsUnit
export const GraphicsUnit = Object.freeze({ World: 0, Display: 1, Pixel: 2, Point: 3, Inch: 4, Document: 5, Millimeter: 6 });

// System.Drawing.Font. DGScope uses new Font(family, emSize) and new Font(family, emSize, GraphicsUnit).
// (My FontFamily is the family NAME string; C# Font.FontFamily.Name -> Font.FontFamily here.)
export class Font {
    FontFamily = null;        // string family name
    Size = 0;                 // float em size
    Style = 0;                // FontStyle (settable; used by TransparentLabel outline path)
    Unit = GraphicsUnit.Point; // GraphicsUnit
    constructor(family = null, size = 0, unit = GraphicsUnit.Point) { this.FontFamily = family; this.Size = size; this.Unit = unit; }
    get Name() { return this.FontFamily; }
    // Canvas font string. NOTE: em size is in points; 1pt≈1.333px — kept 1:1 for now.
    toCanvasFont() { return `${this.Size}px ${this.FontFamily}`; }
}

export class SizeF {
    Width = 0.0;  // float
    Height = 0.0; // float
    constructor(width = 0.0, height = 0.0) { this.Width = width; this.Height = height; }
}

export class RectangleF {
    X = 0.0;      // float
    Y = 0.0;      // float
    Width = 0.0;  // float
    Height = 0.0; // float
    // RectangleF(PointF location, SizeF size)
    constructor(location = new PointF(), size = new SizeF()) {
        this.X = location.X; this.Y = location.Y;
        this.Width = size.Width; this.Height = size.Height;
    }
    get Left() { return this.X; }                 // float
    get Top() { return this.Y; }                  // float
    get Right() { return this.X + this.Width; }   // float
    get Bottom() { return this.Y + this.Height; } // float
    // bool Contains(PointF pt)
    Contains(pt) {
        return this.X <= pt.X && pt.X < this.X + this.Width &&
               this.Y <= pt.Y && pt.Y < this.Y + this.Height;
    }
}

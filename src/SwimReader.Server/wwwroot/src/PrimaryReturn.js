// Ported 1:1 from _source/PrimaryReturn.cs
// namespace DGScope
// Was `: System.Windows.Forms.Control, IScreenObject`. Ported STANDALONE (IScreenObject = duck-typed):
// Control members used (Size/Width/Height/BackColor/Parent/Visible/IsDisposed) become own fields;
// GDI Bitmap+Graphics line -> OffscreenCanvas; window-only bits stubbed. Parent stays null in the
// browser (RadarWindow draws returns via GL/TargetImage, not WinForms child positioning).
import { Color, Point, Size, SizeF, PointF, RectangleF } from "./_shims/SystemDrawing.js";
import { Stopwatch } from "./_shims/Diagnostics.js";

export class PrimaryReturn { // class PrimaryReturn : Control, IScreenObject
    Parent = null;       // Control.Parent (null in browser)
    Visible = true;      // Control.Visible
    IsDisposed = false;  // Control.IsDisposed
    #baseSize = new Size(); // base.Size

    #_location = new PointF(); // PointF _location
    get NewLocation() { return this.LocationF; } // PointF { get => LocationF; set { } }
    set NewLocation(value) { }
    get LocationF() { return this.#_location; } // PointF
    set LocationF(value) {
        this.#_location = value;
        if (this.Parent != null)
            this.Location = new Point(Math.trunc(((this.Parent.ClientSize.Width / 2) * this.#_location.X) + 1) - Math.trunc(this.Size.Width / 2), this.Parent.ClientSize.Height - Math.trunc(((this.Parent.ClientSize.Height / 2) * this.#_location.Y) + 1) - Math.trunc(this.Size.Height / 2));
    }

    ShapeWidth = 0.0;  // float { get; set; }
    ShapeHeight = 0.0; // float { get; set; }

    // new Size Size (hides Control.Size)
    get Size() { return this.#baseSize; }
    set Size(value) {
        this.#baseSize = value;
        if (this.Parent != null)
            this.SizeF = new SizeF((this.Size.Width / (this.Parent.ClientSize.Width / 2)), (this.Size.Height / (this.Parent.ClientSize.Height / 2)));
    }
    #_sizef = new SizeF(); // SizeF _sizef
    get SizeF() { return this.#_sizef; } // SizeF
    set SizeF(value) {
        this.#_sizef = value;
        if (this.Parent != null)
            this.#baseSize = new Size(Math.trunc(this.SizeF.Width * (this.Parent.ClientSize.Width / 2)), Math.trunc(this.SizeF.Height * (this.Parent.ClientSize.Height / 2)));
    }
    get BoundsF() { // RectangleF
        return new RectangleF(new PointF(this.LocationF.X - (this.SizeF.Width / 2), this.LocationF.Y - (this.SizeF.Height / 2)), new SizeF(this.SizeF.Width, this.SizeF.Height));
    }
    Shape = TargetShape.Rectangle; // TargetShape { get; set; }
    ParentAircraft = null;         // Aircraft { get; set; }
    Angle = 0;                     // double { get; set; }
    #initialColor = Color.Lime;    // private Color initialColor = Color.Lime
    Length = 20;                   // int { get; set; }
    Fading = true;                 // bool { get; set; }
    // override Color ForeColor (fade based on Intensity)
    get ForeColor() {
        if (!this.Fading) {
            return this.#initialColor;
        }
        if (this.Intensity >= 1)
            return this.#initialColor;
        if (this.Intensity <= 0)
            return Color.Transparent;
        if (Number.isNaN(this.Intensity))
            return this.#initialColor;
        //return Color.FromArgb((int)(initialColor.R * Intensity * Intensity), ...);
        let newcolor = Color.FromArgb(Math.trunc(Math.pow(this.#initialColor.A, this.Intensity)), Math.trunc(this.#initialColor.R), Math.trunc(this.#initialColor.G), Math.trunc(this.#initialColor.B));
        return newcolor;
    }
    set ForeColor(value) {
        this.#initialColor = value;
    }

    #Stopwatch = new Stopwatch(); // Stopwatch Stopwatch = new Stopwatch()
    #intensity;                   // double intensity
    get Intensity() { // double
        if (!this.Fading)
            return 1;
        return (this.#intensity - this.#Stopwatch.ElapsedMilliseconds / (this.FadeTime * 1000));
    }
    set Intensity(value) {
        this.#intensity = value;
        this.#Stopwatch.Restart();
    }

    constructor() {
        // SetStyle(SupportsTransparentBackColor/UserPaint/DoubleBuffer); BackColor = Transparent  -> WinForms, no-op
        this.#intensity = 1;
    }

    FadeTime = 0; // double { get; set; }

    LastDrawnScreenCenter = null;   // GeoPoint { get; set; }
    LastDrawnRange = 0;             // int { get; set; }
    LastDrawnScreenRotation = 0;    // double { get; set; }
    GeoLocation = null;             // GeoPoint { get; set; }

    // CreateParams / OnPaintBackground / OnPaint  -> WinForms window bits (stubbed)
    Fade(milliseconds) { }

    _backBuffer = null; // Bitmap -> OffscreenCanvas
    // new int Width / Height (hide Control.Width/Height)
    get Width() { return this.TargetImage().width; }
    set Width(value) { this.#baseSize = new Size(value, this.#baseSize.Height); } // private set -> base.Width
    get Height() { return this.TargetImage().height; }
    set Height(value) { this.#baseSize = new Size(this.#baseSize.Width, value); }

    TargetImage() { // Bitmap -> OffscreenCanvas
        if (this.IsDisposed)
            return null;
        let angle = this.Angle * Math.PI / 180;
        let len = this.Length;
        let x = Math.cos(angle) * len / 2;
        let y = Math.sin(angle) * len / 2;
        let _width = Math.trunc(Math.abs(x)) + 6;
        let _height = Math.trunc(Math.abs(y)) + 6;
        let backBuffer = new OffscreenCanvas(_width, _height);
        {
            let g = backBuffer.getContext("2d");
            // Pen(ForeColor, 3)
            g.strokeStyle = this.ForeColor.toCanvasRgba();
            g.lineWidth = 3;
            let x1 = (_width / 2) + x;
            let x2 = (_width / 2) - x;
            let y1 = (_height / 2) + y;
            let y2 = (_height / 2) - y;
            g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); // g.DrawLine(pen, x1,y1,x2,y2)
        }
        return backBuffer;
    }

    PaintTarget() {
        if (this.IsDisposed)
            return;
        this._backBuffer = this.TargetImage();
        this.Width = this._backBuffer.width;
        this.Height = this._backBuffer.height;
        // using (Graphics g = CreateGraphics()) { if (Visible) g.DrawImageUnscaled(_backBuffer,0,0); }
        //  -> WinForms self-paint; in the browser RadarWindow composites via GL, so this is a no-op.
    }

    Dispose() {
        // _backBuffer.Dispose() -> GC; base.Dispose()
        this.IsDisposed = true;
    }
}

export const TargetShape = Object.freeze({
    Rectangle: 0,
    Circle: 1,
});

// Ported 1:1 from _source/TransparentLabel.cs
// namespace DGScope
// Was `: System.Windows.Forms.Control`. Ported STANDALONE: the Control members it uses
// (ForeColor/Font/Text/Size/Width/Height/Padding/RightToLeft/AutoSize) become own fields;
// window-specific bits (SetStyle/CreateParams/CreateGraphics/TabStop/OnPaint*/Dispose) are
// stubbed. GDI Bitmap+Graphics text -> OffscreenCanvas measureText/fillText. Screen DPI -> 96.
import { Color, Font, Size, SizeF, PointF, RectangleF, Padding, ContentAlignment, StringFormat } from "./_shims/SystemDrawing.js";
import { RightToLeft } from "./_shims/WinForms.js";

// static caches (module scope, matching the C# private statics)
const CachedStringFormat = new StringFormat();
let cachedScreenDpiX = 0;
let cachedScreenDpiY = 0;
let dpiCached = false;

let _flashtimer = null;
let flashOn = true;
function FlashTimer() { // static System.Timers.Timer FlashTimer  -> setInterval shim
    if (_flashtimer == null) {
        // new System.Timers.Timer(750); Start(); Elapsed += toggle
        if (typeof setInterval !== "undefined") {
            _flashtimer = setInterval(() => { flashOn = flashOn ? false : true; }, 750);
            if (_flashtimer && _flashtimer.unref) _flashtimer.unref(); // don't keep Node alive
        } else {
            _flashtimer = 0;
        }
    }
    return _flashtimer;
}

// Graphics.MeasureString(text, font) -> OffscreenCanvas measureText (used only inside methods).
function measureString(text, font) {
    const c = new OffscreenCanvas(1, 1).getContext("2d");
    c.font = font.toCanvasFont();
    const m = c.measureText(text ?? "");
    const w = m.width;
    const h = (m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) || (font.Size * 1.3);
    return new SizeF(w, h);
}

/// <summary>A label that can be transparent.</summary>
export class TransparentLabel {
    get FlashOn() { // bool
        FlashTimer(); // _ = FlashTimer;
        return flashOn;
    }
    Flashing = false; // bool { get; set; }

    #foreColor = Color.Black; // base.ForeColor backing
    // override Color ForeColor
    get ForeColor() {
        if (!this.Flashing || this.FlashOn) {
            return this.#foreColor;
        }
        else {
            return this.#foreColor;
            // return Color.FromArgb((int)(base.ForeColor.A * 0.5), ...);  // unreachable in source
        }
    }
    set ForeColor(value) {
        // C# compares Color structs by value; reproduce with ARGB equality.
        if (this.#foreColor && value && this.#foreColor.ToArgb() === value.ToArgb())
            return;
        this.#foreColor = value;
        this.Redraw = true;
    }

    get DrawColor() { // Color
        if (!this.Flashing || this.FlashOn) {
            return this.#foreColor;
        }
        else {
            return Color.FromArgb(Math.trunc(this.#foreColor.A * 1.0), Math.trunc(this.#foreColor.A * 0.5), Math.trunc(this.#foreColor.A * 0.5), Math.trunc(this.#foreColor.A * 0.5));
        }
    }
    get InBoundsF() { return this.LocationF.X > -1 && this.LocationF.X < 1 && this.LocationF.Y > -1 && this.LocationF.Y < 1; }

    constructor() {
        // TabStop = false; SetStyle(UserPaint | DoubleBuffer, false);  -> WinForms window setup, no-op
    }

    // protected override CreateParams / OnPaintBackground / OnTextChanged -> window bits
    OnTextChanged(e) { this.Redraw = true; }

    _backBuffer = null;   // Bitmap -> OffscreenCanvas
    TextureID = 0;        // int { get; set; }
    LocationF = new PointF();  // PointF { get; set; }
    NewLocation = new PointF(); // PointF { get; set; }
    SizeF = new SizeF();  // SizeF { get; set; }
    ParentAircraft = null; // Aircraft { get; set; }
    AutoSize = false;      // Control.AutoSize (set via initializers e.g. { AutoSize = true })
    Padding = Padding.Empty; // Control.Padding
    get BoundsF() { return new RectangleF(new PointF(this.LocationF.X, this.LocationF.Y), new SizeF(this.SizeF.Width, this.SizeF.Height)); }

    ForceRedraw() { this.Redraw = true; }

    // Control.Size / Width / Height
    #size = new Size();
    get Size() { return this.#size; }
    set Size(v) { this.#size = v; }
    get Width() { return this.#size.Width; }
    set Width(v) { this.#size = new Size(v, this.#size.Height); }
    get Height() { return this.#size.Height; }
    set Height(v) { this.#size = new Size(this.#size.Width, v); }

    /// <summary>Measures Text/Font and sets Size/SizeF immediately. Returns scaled SizeF.</summary>
    Measure(pixelScale) { // SizeF
        if (this.Text == null || this.Text === "") {
            this.Size = new Size(0, 0);
            this.SizeF = new SizeF(0, 0);
            return this.SizeF;
        }
        if (!dpiCached) {
            cachedScreenDpiX = 96; cachedScreenDpiY = 96; // CreateGraphics().DpiX -> 96
            dpiCached = true;
        }
        let size = measureString(this.Text, this.Font); // graphics.MeasureString(...)
        let w = Math.trunc(size.Width + this.Padding.Left + this.Padding.Right + 1);
        let h = Math.trunc(size.Height + this.Padding.Top + this.Padding.Bottom + 1);
        this.Size = new Size(w, h);
        this.SizeF = new SizeF(w * pixelScale, h * pixelScale);
        return this.SizeF;
    }

    NewTextBitmap(outline = false) { // Bitmap -> OffscreenCanvas
        if (!this.Redraw) {
            return this._backBuffer;
        }
        let point = new PointF(this.Padding.Left, this.Padding.Top);

        if (this.Text == null || this.Text.length === 0) {
            this._backBuffer = new OffscreenCanvas(1, 1);
            return this._backBuffer;
        }
        if (!dpiCached) { cachedScreenDpiX = 96; cachedScreenDpiY = 96; dpiCached = true; }

        let size = measureString(this.Text, this.Font);
        this.Size = new Size(Math.trunc(size.Width + this.Padding.Left + this.Padding.Right + 1), Math.trunc(size.Height + this.Padding.Top + this.Padding.Bottom + 1));
        let innerW = this.Size.Width - (this.Padding.Left + this.Padding.Right);
        let innerH = this.Size.Height - (this.Padding.Top + this.Padding.Bottom);
        let nb = new OffscreenCanvas(Math.max(1, innerW), Math.max(1, innerH));
        {
            let graphics = nb.getContext("2d");
            graphics.font = this.Font.toCanvasFont();
            graphics.textBaseline = "top";
            if (outline) {
                // GraphicsPath.AddString + DrawPath(Pen black,2) + FillPath(white)
                graphics.lineWidth = 2; graphics.strokeStyle = Color.Black.toCanvasRgba();
                graphics.strokeText(this.Text, point.X, point.Y);
                graphics.fillStyle = Color.White.toCanvasRgba();
                graphics.fillText(this.Text, point.X, point.Y);
            }
            else {
                graphics.fillStyle = Color.White.toCanvasRgba(); // SolidBrush(Color.White)
                graphics.fillText(this.Text, point.X, point.Y);
            }
        }
        this._backBuffer = nb;
        this.Redraw = false;
        return this._backBuffer;
    }
    Redraw = true; // bool { get; private set; } = true

    TextBitmap(outline) { // Bitmap -> OffscreenCanvas
        if (!this.Redraw) {
            return this._backBuffer;
        }
        let size = measureString(this.Text, this.Font); // graphics.MeasureString(Text, Font)
        this.Width = Math.trunc(size.Width);
        this.Height = Math.trunc(size.Height);
        this._backBuffer = new OffscreenCanvas(this.Width + 1, this.Height + 1);
        {
            let graphics = this._backBuffer.getContext("2d");
            graphics.font = this.Font.toCanvasFont();
            graphics.textBaseline = "top";
            // first figure out the top
            let top = 0;
            switch (this.#textAlign) {
                case ContentAlignment.MiddleLeft:
                case ContentAlignment.MiddleCenter:
                case ContentAlignment.MiddleRight:
                    top = (this.Height - size.Height) / 2;
                    break;
                case ContentAlignment.BottomLeft:
                case ContentAlignment.BottomCenter:
                case ContentAlignment.BottomRight:
                    top = this.Height - size.Height;
                    break;
            }
            let left = -1;
            switch (this.#textAlign) {
                case ContentAlignment.TopLeft:
                case ContentAlignment.MiddleLeft:
                case ContentAlignment.BottomLeft:
                    if (this.RightToLeft === RightToLeft.Yes)
                        left = this.Width - size.Width;
                    else
                        left = -1;
                    break;
                case ContentAlignment.TopCenter:
                case ContentAlignment.MiddleCenter:
                case ContentAlignment.BottomCenter:
                    left = (this.Width - size.Width) / 2;
                    break;
                case ContentAlignment.TopRight:
                case ContentAlignment.MiddleRight:
                case ContentAlignment.BottomRight:
                    if (this.RightToLeft === RightToLeft.Yes)
                        left = -1;
                    else
                        left = this.Width - size.Width;
                    break;
            }
            if (outline) {
                graphics.lineWidth = 1; graphics.strokeStyle = Color.Black.toCanvasRgba();
                graphics.strokeText(this.text, 0, 0); // AddString at (0,0) + DrawPath(Pens.Black)
            }
            graphics.fillStyle = Color.White.toCanvasRgba(); // SolidBrush(Color.White)
            graphics.fillText(this.Text, left, top);
        }
        this.Redraw = false;
        return this._backBuffer;
    }

    text; // string
    get Text() { return this.text; }
    set Text(value) {
        if (value === this.text)
            return;
        this.text = value;
        this.Redraw = true;
    }

    #rightToLeft = RightToLeft.Inherit; // base.RightToLeft backing
    get RightToLeft() { return this.#rightToLeft; }
    set RightToLeft(value) { this.#rightToLeft = value; }

    #font = new Font("", 1); // private Font font = new Font("",1)
    get Font() { return this.#font; }
    set Font(value) { this.#font = value; }

    #textAlign = ContentAlignment.TopLeft; // private ContentAlignment textAlign
    get TextAlign() { return this.#textAlign; }
    set TextAlign(value) {
        if (value !== this.#textAlign)
            this.Redraw = true;
        this.#textAlign = value;
    }

    CenterOnPoint(Point) {
        this.LocationF = new PointF(Point.X - this.SizeF.Width / 2, Point.Y - this.SizeF.Height / 2);
    }
}

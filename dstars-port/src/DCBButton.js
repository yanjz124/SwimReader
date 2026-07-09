// Ported 1:1 from _source/DCBButton.cs
// namespace DGScope
// using OpenTK.Graphics.OpenGL (GL shim), System.Drawing(.Imaging/.Drawing2D)
import { DCBMenuItem } from "./DCBMenu.js";
import { Color, Point, Rectangle, StringFormat, StringAlignment, StringFormatFlags } from "./_shims/SystemDrawing.js";
import {
    GL, PrimitiveType, EnableCap, TextureTarget, TextureParameterName,
    PixelInternalFormat, PixelFormat, PixelType, TextureMagFilter, TextureMinFilter, TextureWrapMode,
} from "./_shims/GL.js";
import { EventHandler, EventArgs } from "./_shims/DotNetEvent.js";
import { RadarWindow } from "./RadarWindow.js";
import { Cursor } from "./_shims/WinForms.js";

export class DCBButton extends DCBMenuItem {
    #bordersize = 3;             // int
    #internalrectangle;          // Rectangle
    #drawnvertically = false;    // bool
    #drawnhorizontally = false;  // bool
    #textureID = 0;              // int
    #drawntext;                  // string
    get #enabled() { return this.Enabled && !this.Disabled; } // bool enabled => Enabled && !Disabled
    #drawnfont;                  // Font

    Click = new EventHandler();  // event EventHandler
    Active = false;              // bool { get; set; }
    BackColorActive = Color.Green;              // Color
    BackColorInactive = Color.FromArgb(0, 80, 0); // Color
    BackColorDisabled = Color.FromArgb(0, 40, 0); // Color
    ForeColor = Color.White;                    // Color
    ForeColorDwell = Color.Yellow;              // Color
    ForeColorDisabled = Color.DarkGray;         // Color
    #font_field = null;
    get Font() { return this.#font_field; }     // override Font { get; set; }
    set Font(value) { this.#font_field = value; }
    StringFormat = Object.assign(new StringFormat(), {
        Alignment: StringAlignment.Center, LineAlignment: StringAlignment.Center,
        FormatFlags: StringFormatFlags.NoWrap | StringFormatFlags.NoClip,
    });
    Text = null;   // string { get; set; }
    Value = null;  // object { get; set; }

    PaintText() { // private void
        if (this.DrawnBounds.Size.IsEmpty)
            return;
        // Bitmap + Graphics.DrawString -> OffscreenCanvas + fillText (StringFormat center/center).
        const img = new OffscreenCanvas(this.DrawnBounds.Width, this.DrawnBounds.Height);
        {
            const graphics = img.getContext("2d");
            // SmoothingMode.AntiAlias / CompositingQuality.HighQuality -> canvas default AA
            graphics.fillStyle = Color.White.toCanvasRgba(); // SolidBrush(Color.White)
            if (this.Font) graphics.font = this.Font.toCanvasFont();
            graphics.textAlign = "center";   // StringAlignment.Center
            graphics.textBaseline = "middle"; // LineAlignment.Center
            graphics.fillText(this.Text ?? "",
                this.#internalrectangle.X + this.#internalrectangle.Width / 2,
                this.#internalrectangle.Y + this.#internalrectangle.Height / 2);
        }
        GL.BindTexture(TextureTarget.Texture2D, this.#textureID);
        // LockBits/Scan0 (BGRA) -> upload the canvas directly.
        GL.TexImage2D(TextureTarget.Texture2D, 0, PixelInternalFormat.Rgba, img.width, img.height, 0,
            PixelFormat.Bgra, PixelType.UnsignedByte, img);
        GL.TexParameter(TextureTarget.Texture2D, TextureParameterName.TextureMagFilter, TextureMagFilter.Nearest);
        GL.TexParameter(TextureTarget.Texture2D, TextureParameterName.TextureMinFilter, TextureMinFilter.Nearest);
        GL.TexParameter(TextureTarget.Texture2D, TextureParameterName.TextureWrapS, TextureWrapMode.ClampToEdge);
        GL.TexParameter(TextureTarget.Texture2D, TextureParameterName.TextureWrapT, TextureWrapMode.ClampToEdge);

        GL.BindTexture(TextureTarget.Texture2D, 0);
        // img.UnlockBits(data) -> n/a
        this.#drawntext = this.Text;
        this.#drawnfont = this.Font;
    }

    Draw(location, vertical, brightness) { // override void Draw(Point, bool, int)
        let width = this.RotateIfVertical && vertical ? this.Height : this.Width;
        let height = this.RotateIfVertical && vertical ? this.Width : this.Height;
        let drawactive = this.Active !== (this.#mousePressed && this.#mouseInside);
        this.#internalrectangle = new Rectangle(0, 0, width, height);
        this.DrawnBounds = new Rectangle(location.X + this.Left, location.Y + this.Top, width, height);
        GL.PushMatrix();
        GL.Translate(this.Left, this.Top, 0);

        GL.Begin(PrimitiveType.Polygon);
        GL.Color4(!drawactive ? RadarWindow.AdjustedColor(Color.DarkGray, brightness) : Color.Black);
        GL.Vertex2(0, 0);
        GL.Vertex2(width, 0);
        GL.Vertex2(width - this.#bordersize, this.#bordersize);
        GL.Vertex2(this.#bordersize, this.#bordersize);
        GL.Vertex2(this.#bordersize, height - this.#bordersize);
        GL.Vertex2(0, height);
        GL.End();

        GL.Begin(PrimitiveType.Polygon);
        GL.Color4(drawactive ? RadarWindow.AdjustedColor(Color.DarkGray, brightness) : Color.Black);
        GL.Vertex2(width, height);
        GL.Vertex2(width, 0);
        GL.Vertex2(width - this.#bordersize, this.#bordersize);
        GL.Vertex2(width - this.#bordersize, height - this.#bordersize);
        GL.Vertex2(this.#bordersize, height - this.#bordersize);
        GL.Vertex2(0, height);
        GL.End();
        GL.Begin(PrimitiveType.Polygon);
        if (this.#enabled)
            GL.Color4(drawactive ? RadarWindow.AdjustedColor(this.BackColorActive, brightness) : RadarWindow.AdjustedColor(this.BackColorInactive, brightness));
        else
            GL.Color4(RadarWindow.AdjustedColor(this.BackColorDisabled, brightness));
        GL.Vertex2(this.#bordersize, this.#bordersize);
        GL.Vertex2(width - this.#bordersize, this.#bordersize);
        GL.Vertex2(width - this.#bordersize, height - this.#bordersize);
        GL.Vertex2(this.#bordersize, height - this.#bordersize);
        GL.End();

        GL.Enable(EnableCap.Texture2D);
        if (this.#textureID === 0) {
            this.#textureID = GL.GenTexture();
        }
        if (this.#drawnhorizontally === vertical || this.#drawnvertically !== vertical || this.#drawntext !== this.Text || this.#drawnfont !== this.Font) {
            this.PaintText();
            this.#drawnvertically = vertical;
            this.#drawnhorizontally = !vertical;
        }
        GL.BindTexture(TextureTarget.Texture2D, this.#textureID);
        GL.Begin(PrimitiveType.Quads);
        if (this.#enabled)
            GL.Color3(this.#mouseInside ? RadarWindow.AdjustedColor(this.ForeColorDwell, brightness) : RadarWindow.AdjustedColor(this.ForeColor, brightness));
        else
            GL.Color3(RadarWindow.AdjustedColor(this.ForeColorDisabled, brightness));
        GL.TexCoord2(0, 0);
        GL.Vertex2(0, 0);
        GL.TexCoord2(1, 0);
        GL.Vertex2(this.DrawnBounds.Width, 0);
        GL.TexCoord2(1, 1);
        GL.Vertex2(this.DrawnBounds.Width, this.DrawnBounds.Height);
        GL.TexCoord2(0, 1);
        GL.Vertex2(0, this.DrawnBounds.Height);
        GL.End();
        GL.BindTexture(TextureTarget.Texture2D, 0);
        GL.Disable(EnableCap.Texture2D);

        GL.PopMatrix();
    }
    #mouseInside = false;  // bool
    #mousePressed = false; // bool
    // public new bool Enabled (hides base; clears mouse state when disabled)
    get Enabled() { return super.Enabled; }
    set Enabled(value) {
        if (!value) {
            this.#mouseInside = false;
            this.#mousePressed = false;
        }
        super.Enabled = value;
    }
    Disabled = false; // bool { get; set; }
    MouseMove(position) { // override
        if (!this.#enabled) return;
        if (this.DrawnBounds.Contains(position)) {
            this.#mouseInside = true;
        }
        else {
            this.#mouseInside = false;
        }
    }
    MouseDown() { // override
        if (!this.#enabled) return;
        if (this.#mouseInside) {
            this.#mousePressed = true;
        }
    }
    MouseUp() { // override
        if (!this.#enabled) return;
        if (this.#mouseInside && this.#mousePressed) {
            this.OnClick(new EventArgs());
        }
        this.#mousePressed = false;
    }
    OnClick(e) { // virtual
        this.Click.Invoke(this, e); // Click?.Invoke(this, e)
    }
}

export class DCBToggleButton extends DCBButton {
    ClickOff = new EventHandler(); // event EventHandler
    ClickOn = new EventHandler();  // event EventHandler
    OnClick(e) { // override
        if (this.Active) {
            this.ClickOff.Invoke(this, e);
        }
        else {
            this.ClickOn.Invoke(this, e);
        }
        super.OnClick(e);
    }
}

export class DCBAdjustmentButton extends DCBButton {
    Down = new EventHandler(); // event EventHandler
    Up = new EventHandler();   // event EventHandler
    #active; // bool active
    OnClick(e) { // override
        this.#active = !this.Active;
        if (this.#active) {
            this.ParentMenu.Enabled = false;
            this.Enabled = true;
            this.Active = true;
        }
        else {
            this.ParentMenu.Enabled = true;
            this.Active = false;
        }
        super.OnClick(e);
    }
    MouseDown() { // override
        if (!this.Active)
            super.MouseDown();
    }
    MouseWheel(delta) {
        if (!this.Active) return;
        if (delta < 0) {
            this.Down.Invoke(this, null);
        }
        else {
            this.Up.Invoke(this, null);
        }
    }
    OnAdjustUp(e) { this.Up.Invoke(this, e); }     // virtual
    OnAdjustDown(e) { this.Down.Invoke(this, e); } // virtual
}

export class DCBSubmenuButton extends DCBButton {
    #windowLocation = new Point(); // Point
    Submenu = null;                // DCBMenu { get; set; }
    Draw(location, vertical, brightness) { // override
        super.Draw(location, vertical, brightness);
        if (!this.Active)
            return;
        if (vertical) {
            this.Submenu.Width = this.DrawnBounds.Width;
        }
        else {
            this.Submenu.Height = this.DrawnBounds.Height;
        }
        if (this.Submenu.Font !== this.Font)
            this.Submenu.Font = this.Font;
        this.Submenu.LayoutButtons(vertical);
        GL.PushMatrix();
        GL.Translate(this.Left, this.Top, 0);
        if (vertical) {
            GL.Translate(0, this.Height, 0);
            this.Submenu.Draw(new Point(location.X + this.Left, location.Y + this.Bottom), vertical, brightness);
        }
        else {
            GL.Translate(this.Width, 0, 0);
            this.Submenu.Draw(new Point(location.X + this.Right, location.Y + this.Top), vertical, brightness);
        }
        let newpoint = new Point(this.#windowLocation.X + this.Submenu.DrawnBounds.Location.X, this.#windowLocation.Y + this.Submenu.DrawnBounds.Location.Y);
        Cursor.Clip = new Rectangle(newpoint, this.Submenu.DrawnBounds.Size);

        GL.PopMatrix();
        this.Submenu.SubmenuButton = this;
    }
    MouseDown() { // override
        super.MouseDown();
        if (this.Active) {
            this.Submenu.MouseDown();
        }
    }
    MouseUp() { // override
        super.MouseUp();
        if (this.Active) {
            this.Submenu.MouseUp();
        }
    }
    MouseMove(position) { // override
        super.MouseMove(position);
        if (this.Active) {
            this.Submenu.MouseMove(position);
        }
    }
    OnClick(e) { // override
        this.Active = !this.Active;
        if (this.Active) {
            this.ParentMenu.Enabled = false;
        }
        else {
            this.ParentMenu.Enabled = true;
            Cursor.Clip = new Rectangle();
        }
        super.OnClick(e);
    }
    SetScreenLocation(point) {
        this.#windowLocation = point;
    }
}

export class DCBActionButton extends DCBButton {
    OnClick(e) { // override
        this.Active = !this.Active;
        if (this.Active) {
            this.ParentMenu.Enabled = false;
            this.Enabled = true;
        }
        else {
            this.ParentMenu.Enabled = true;
        }
        super.OnClick(e);
    }
    ActionDone() {
        this.Active = false;
        this.ParentMenu.Enabled = true;
    }
}

export class DCBRadioButton extends DCBButton {
    OtherButtons = null; // List<DCBRadioButton> { get; set; }
}

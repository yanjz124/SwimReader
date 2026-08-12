// Ported 1:1 from _source/DCB.cs
// namespace DGScope
// using OpenTK (Matrix4/Vector4 shim), OpenTK.Graphics.OpenGL (GL shim), System.Drawing
import { Font, Point, Color } from "./_shims/SystemDrawing.js";
import { GL, PrimitiveType } from "./_shims/GL.js";
import { Vector4 } from "./_shims/OpenTK.js";
import { RadarWindow } from "./RadarWindow.js";

// internal class DCB
export class DCB {
    #activemenu;                        // DCBMenu activemenu
    #font = new Font("Consolas", 10);   // Font font = new Font("Consolas", 10)
    Location = DCBLocation.Top;         // DCBLocation { get; set; } = DCBLocation.Top
    Size = 80;                          // int { get; set; } = 80
    get Vertical() { // bool
        return (this.Location === DCBLocation.Left || this.Location === DCBLocation.Right);
    }

    Visible = false;                    // bool { get; set; }
    get ActiveMenu() { return this.#activemenu; } // DCBMenu
    set ActiveMenu(value) {
        this.#activemenu = value;
        this.#activemenu.Font = this.#font;
    }
    get Font() { return this.#font; } // Font
    set Font(value) {
        this.#font = value;
        if (this.#activemenu != null)
            this.#activemenu.Font = this.#font;
    }
    Items = []; // List<DCBMenuItem> { get; set; }

    Draw(width, height, pixelTransform, brightness) { // void Draw(int, int, ref Matrix4, int)
        if (!this.Visible) return;
        let vec = new Vector4(0, 0, 0, 1);
        vec.mulEq(pixelTransform); // vec *= pixelTransform;
        GL.PushMatrix();
        GL.MultMatrix(pixelTransform); // GL.MultMatrix(ref pixelTransform)
        GL.PushMatrix();
        let drawloc = new Point(0, 0);
        if (this.Location === DCBLocation.Bottom) {
            GL.Translate(0, height - this.Size, 0);
            drawloc = new Point(0, height - this.Size);
        }
        else if (this.Location === DCBLocation.Right) {
            GL.Translate(width - this.Size, 0, 0);
            drawloc = new Point(width - this.Size, 0);
        }
        else {
            drawloc = new Point(0, 0);
        }

        if (this.Vertical) {
            this.ActiveMenu.Width = this.Size;
        }
        else {
            this.ActiveMenu.Height = this.Size;
        }
        this.ActiveMenu.Location = new Point(0, 0);
        GL.Begin(PrimitiveType.Polygon);
        GL.Color4(RadarWindow.AdjustedColor(Color.FromArgb(0, 35, 15), brightness));
        if (this.Vertical) {
            GL.Vertex2(0, 0);
            GL.Vertex2(this.Size, 0);
            GL.Vertex2(this.Size, height);
            GL.Vertex2(0, height);
        }
        else {
            GL.Vertex2(0, 0);
            GL.Vertex2(0, this.Size);
            GL.Vertex2(width, this.Size);
            GL.Vertex2(width, 0);
        }
        GL.End();
        this.ActiveMenu.Draw(drawloc, this.Vertical, brightness);
        GL.PopMatrix();
        GL.PopMatrix();
    }
}

export const DCBLocation = Object.freeze({
    Top: 0,
    Bottom: 1,
    Left: 2,
    Right: 3,
});

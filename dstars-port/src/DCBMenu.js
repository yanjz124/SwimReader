// Ported 1:1 from _source/DCBMenu.cs
// namespace DGScope
// using OpenTK.Graphics.OpenGL; (GL shim), System.Drawing (Point/Size/Rectangle/Font shims)
import { Point, Size, Rectangle } from "./_shims/SystemDrawing.js";
import { GL } from "./_shims/GL.js";

// abstract class DCBMenuItem
// (defined before DCBMenu because DCBMenu extends it — JS evaluates `extends` at load.)
export class DCBMenuItem {
    get Top() { return this.Location.Y; }               // int
    set Top(value) { this.Location = new Point(this.Location.X, value); }
    get Left() { return this.Location.X; }              // int
    set Left(value) { this.Location = new Point(value, this.Location.Y); }
    get Bottom() { return this.Bounds.Bottom; }         // int
    get Right() { return this.Bounds.Right; }           // int
    get Width() { return this.Size.Width; }             // int
    set Width(value) { this.Size = new Size(value, this.Size.Height); }
    get Height() { return this.Size.Height; }           // int
    set Height(value) { this.Size = new Size(this.Size.Width, value); }
    Location = new Point();  // Point { get; set; }
    get Bounds() { return new Rectangle(this.Location, this.Size); } // Rectangle
    Size = new Size();       // Size { get; set; }
    #enabled = true;         // Enabled { get; set; } = true  (backing so DCBMenu can hide via super)
    get Enabled() { return this.#enabled; }
    set Enabled(value) { this.#enabled = value; }
    ParentMenu = null;       // DCBMenu
    #rotateIfVertical = false; // RotateIfVertical { get; set; }
    get RotateIfVertical() { return this.#rotateIfVertical; }
    set RotateIfVertical(value) { this.#rotateIfVertical = value; }
    // abstract Font { get; set; }
    get Font() { throw new Error("abstract"); }
    set Font(value) { throw new Error("abstract"); }
    DrawnBounds = new Rectangle(); // Rectangle { get; set; }
    Draw(location, vertical, brightness) { throw new Error("abstract"); } // abstract void Draw(Point, bool, int)
    MouseMove(position) { throw new Error("abstract"); }                  // abstract void MouseMove(Point)
    MouseDown() { }  // virtual
    MouseUp() { }    // virtual
}

// internal class DCBMenu : DCBMenuItem
export class DCBMenu extends DCBMenuItem {
    #laidoutvertical;   // bool
    #laidouthorizontal; // bool
    #font;              // Font
    Buttons = [];       // protected List<DCBMenuItem> { get; set; }
    SubmenuButton = null; // DCBSubmenuButton { get; set; }  (only referenced; not constructed here)

    AddButton(button) {
        this.Buttons.push(button);
        button.ParentMenu = this;
        this.#laidouthorizontal = false;
        this.#laidoutvertical = false;
        button.Font = this.#font;
    }
    RemoveButton(button) {
        const i = this.Buttons.indexOf(button); if (i >= 0) this.Buttons.splice(i, 1); // Buttons.Remove(button)
        button.ParentMenu = null;
        this.#laidouthorizontal = false;
        this.#laidoutvertical = false;
    }
    ClearButtons() {
        this.Buttons.forEach(x => x.ParentMenu = null);
        this.Buttons.length = 0; // Buttons.Clear()
        this.#laidouthorizontal = false;
        this.#laidoutvertical = false;
    }
    // new bool RotateIfVertical { get => true; }  (hides base)
    get RotateIfVertical() { return true; }
    // new bool Enabled (hides base; cascades to buttons)
    get Enabled() { return super.Enabled; }
    set Enabled(value) {
        if (super.Enabled === value) {
            return;
        }
        super.Enabled = value;
        this.Buttons.forEach(x => x.Enabled = value);
    }
    // override Font
    get Font() { return this.#font; }
    set Font(value) {
        this.Buttons.forEach(x => x.Font = value);
        this.#font = value;
    }
    Draw(location, vertical, brightness) { // override void Draw(Point location, bool vertical, int brightness)
        this.LayoutButtons(vertical);
        GL.PushMatrix();
        GL.Translate(this.Left, this.Top, 0);
        let newloc = new Point(location.X + this.Left, location.Y + this.Top);
        this.DrawnBounds = new Rectangle(newloc.X, newloc.Y, this.Width, this.Height);
        for (let i = this.Buttons.length - 1; i >= 0; i--) {
            let button = this.Buttons[i];
            button.Draw(newloc, vertical, brightness);
        }
        GL.PopMatrix();
    }
    OnClick(clickedPoint) { // protected void OnClick(Point clickedPoint)
        let clicked = this.Buttons.filter(x => x.DrawnBounds.Contains(clickedPoint)); // Where(...).ToList()
        if (clicked.length === 0)
            return;
        //else
        //    clicked.ForEach(x => x.OnClick(diff));
    }
    LayoutButtons(vertical) {
        if (this.#laidoutvertical === vertical && this.#laidouthorizontal !== vertical)
            return;
        let top = 0;
        let left = 0;
        let width = 0;
        for (const button of this.Buttons) {
            let rotate = button.RotateIfVertical && vertical;
            let height = rotate ? button.Width : button.Height;
            if (!vertical && top + height > this.Height) {
                top = 0;
                left += width;
            }
            width = rotate ? button.Height : button.Width;
            button.Top = top;
            button.Left = left;
            top += height;
            if (button.Bottom > this.Height) {
                this.Height = button.Bottom;
            }
            if (button.Right > this.Width) {
                this.Width = button.Right;
            }
        }

        this.#laidoutvertical = vertical;
        this.#laidouthorizontal = !vertical;
    }
    MouseMove(position) { // override
        let diff = new Point(position.X - this.DrawnBounds.X, position.Y - this.DrawnBounds.Y);
        this.Buttons.forEach(x => x.MouseMove(position));
    }
    MouseDown() { // override
        this.Buttons.forEach(x => x.MouseDown());
    }
    MouseUp() { // override
        this.Buttons.forEach(x => x.MouseUp());
    }
}

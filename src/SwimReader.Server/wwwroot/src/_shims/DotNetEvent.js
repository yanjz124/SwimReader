// Shim for C# events (`event EventHandler<T>`), invocation (`handler?.Invoke(sender, args)`),
// and subscription (`+=` / `-=`).
//   C#: public event EventHandler<T> X;   X?.Invoke(this, args);   obj.X += handler;
//   JS: X = new EventHandler();            this.X.Invoke(this, args); obj.X.add(handler);
// The shim's Invoke no-ops when there are no subscribers, matching `?.Invoke` on a null event.

export class EventHandler {
    #handlers = [];
    add(h) { this.#handlers.push(h); }                                   // +=
    remove(h) { const i = this.#handlers.indexOf(h); if (i >= 0) this.#handlers.splice(i, 1); } // -=
    Invoke(sender, args) { for (const h of this.#handlers.slice()) h(sender, args); }
}

// System.EventArgs
export class EventArgs {
    static Empty; // set below
}
EventArgs.Empty = new EventArgs();

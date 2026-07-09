// Shim for System.Collections.ObjectModel.ObservableCollection<T> and the
// System.Collections.Specialized change-notification types DGScope relies on.
// RadarWindow.Aircraft is an ObservableCollection whose CollectionChanged event
// wires per-aircraft handlers in Initialize(). Extends Array so all the existing
// LINQ-style reads (forEach/filter/…) keep working unchanged.
import { EventHandler } from "./DotNetEvent.js";

// System.Collections.Specialized.NotifyCollectionChangedAction
export const NotifyCollectionChangedAction = Object.freeze({ Add: 0, Remove: 1, Replace: 2, Move: 3, Reset: 4 });

// System.Collections.Specialized.NotifyCollectionChangedEventArgs (only the members DGScope reads)
export class NotifyCollectionChangedEventArgs {
    Action;   // NotifyCollectionChangedAction
    NewItems; // IList (Array | null)
    OldItems; // IList (Array | null)
    constructor(action, newItems = null, oldItems = null) {
        this.Action = action; this.NewItems = newItems; this.OldItems = oldItems;
    }
}

export class ObservableCollection extends Array {
    // NOTE: `extends Array` — when the engine does map/slice it calls the constructor with a
    // single numeric length; pass that straight through so those operations don't break.
    constructor(...args) {
        if (args.length === 1 && typeof args[0] === "number") super(args[0]);
        else { super(); for (const it of args) this.push(it); }
    }
    CollectionChanged = new EventHandler(); // event NotifyCollectionChangedEventHandler

    Add(item) {
        this.push(item);
        this.CollectionChanged.Invoke(this, new NotifyCollectionChangedEventArgs(NotifyCollectionChangedAction.Add, [item]));
    }
    Remove(item) {
        const i = this.indexOf(item);
        if (i < 0) return false;
        this.splice(i, 1);
        this.CollectionChanged.Invoke(this, new NotifyCollectionChangedEventArgs(NotifyCollectionChangedAction.Remove, null, [item]));
        return true;
    }
    RemoveAt(index) {
        const item = this[index];
        this.splice(index, 1);
        this.CollectionChanged.Invoke(this, new NotifyCollectionChangedEventArgs(NotifyCollectionChangedAction.Remove, null, [item]));
    }
    Clear() {
        this.length = 0;
        this.CollectionChanged.Invoke(this, new NotifyCollectionChangedEventArgs(NotifyCollectionChangedAction.Reset));
    }
    Contains(item) { return this.includes(item); }
    get Count() { return this.length; }
}

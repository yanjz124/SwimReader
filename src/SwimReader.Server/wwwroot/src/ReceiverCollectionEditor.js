// Ported from _source/ReceiverCollectionEditor.cs
// namespace DGScope.Receivers
// public class ReceiverCollectionEditor : CollectionEditor — a WinForms property-grid collection
// editor. LoadReceivers() scans "DGScope.*.dll" via reflection (DirectoryInfo/Assembly.LoadFrom/
// GetTypes) to discover Receiver subtypes. There is no filesystem/assembly reflection in the
// browser and no property grid, so this is STUBBED (config-editor UI, not needed to render the
// scope). A real port would use a static registry of receiver classes.
export class ReceiverCollectionEditor {
    #types = []; // List<Type>
    constructor(type) {
        // base(type); LoadReceivers();  -> reflection over DGScope.*.dll not possible in browser
    }
    CreateNewItemTypes() { // override Type[]
        return this.#types; // no discoverable receiver types -> []
    }
}

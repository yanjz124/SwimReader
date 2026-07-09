// Ported (STUB) from _source/RuntimeServiceProvider.cs.
// WinForms property-grid infrastructure: IServiceProvider + ITypeDescriptorContext, used to host
// modal UITypeEditors (IWindowsFormsEditorService) at runtime. There is no property grid in the
// browser, so this is a minimal stub matching the interface members other code reads.
export class RuntimeServiceProvider { // : IServiceProvider, ITypeDescriptorContext
    // IServiceProvider
    GetService(serviceType) { return null; } // IWindowsFormsEditorService not available in browser
    // ITypeDescriptorContext
    OnComponentChanged() { }
    get Container() { return null; }
    OnComponentChanging() { return true; }
    get Instance() { return null; }
    get PropertyDescriptor() { return null; }
}

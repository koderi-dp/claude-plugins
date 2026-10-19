; csharp outline query: each pattern captures the definition as @item.<kind>
; and its identifier as @name.

(namespace_declaration name: (_) @name) @item.namespace
(file_scoped_namespace_declaration name: (_) @name) @item.namespace

(class_declaration name: (identifier) @name) @item.class
(struct_declaration name: (identifier) @name) @item.struct
(record_declaration name: (identifier) @name) @item.record
(interface_declaration name: (identifier) @name) @item.interface
(enum_declaration name: (identifier) @name) @item.enum

(method_declaration name: (identifier) @name) @item.method
(constructor_declaration name: (identifier) @name) @item.constructor
(property_declaration name: (identifier) @name) @item.property

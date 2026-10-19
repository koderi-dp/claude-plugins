; rust outline query: each pattern captures the definition as @item.<kind>
; and its identifier as @name.

(function_item name: (identifier) @name) @item.fn
(function_signature_item name: (identifier) @name) @item.fn

(struct_item name: (type_identifier) @name) @item.struct
(enum_item name: (type_identifier) @name) @item.enum
(trait_item name: (type_identifier) @name) @item.trait
(mod_item name: (identifier) @name) @item.mod
(type_item name: (type_identifier) @name) @item.type
(const_item name: (identifier) @name) @item.const
(static_item name: (identifier) @name) @item.static

(macro_definition name: (identifier) @name) @item.macro

; the real impl name is computed from the type/trait fields in extract.rs
(impl_item type: (_) @name) @item.impl

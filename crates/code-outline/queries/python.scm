; python outline query: each pattern captures the definition as @item.<kind>
; and its identifier as @name. Decorators sit on the parent
; decorated_definition, which extract.rs uses for the range.

(class_definition name: (identifier) @name) @item.class

; The async pattern comes first so it wins when both match the same node.
(function_definition "async" name: (identifier) @name) @item.async_def
(function_definition name: (identifier) @name) @item.def

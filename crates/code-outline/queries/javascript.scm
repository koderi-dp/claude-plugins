; javascript outline query: each pattern captures the definition as
; @item.<kind> and its identifier as @name.

(function_declaration name: (identifier) @name) @item.function
(generator_function_declaration name: (identifier) @name) @item.function

(class_declaration name: (identifier) @name) @item.class

(method_definition
  name: (_) @name
  (#not-eq? @name "constructor")) @item.method
(method_definition
  name: (property_identifier) @name
  (#eq? @name "constructor")) @item.constructor

; const f = () => {} / const f = function () {}
(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: [(arrow_function) (function_expression)])) @item.function
(variable_declaration
  (variable_declarator
    name: (identifier) @name
    value: [(arrow_function) (function_expression)])) @item.function

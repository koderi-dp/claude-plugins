; typescript outline query (also used for TSX). The TS grammar extends JS, so
; this repeats the JS patterns, with type_identifier where TS names classes.

(function_declaration name: (identifier) @name) @item.function
(generator_function_declaration name: (identifier) @name) @item.function
(function_signature name: (identifier) @name) @item.function

(class_declaration name: (type_identifier) @name) @item.class
(abstract_class_declaration name: (type_identifier) @name) @item.class

(method_definition
  name: (_) @name
  (#not-eq? @name "constructor")) @item.method
(method_definition
  name: (property_identifier) @name
  (#eq? @name "constructor")) @item.constructor

; overload signatures and abstract methods, class members only (interface
; members are not outlined)
(class_body
  (method_signature
    name: (_) @name
    (#not-eq? @name "constructor")) @item.method)
(class_body
  (method_signature
    name: (property_identifier) @name
    (#eq? @name "constructor")) @item.constructor)
(class_body
  (abstract_method_signature name: (_) @name) @item.method)

(interface_declaration name: (type_identifier) @name) @item.interface
(type_alias_declaration name: (type_identifier) @name) @item.type
(enum_declaration name: (identifier) @name) @item.enum
(internal_module name: (_) @name) @item.namespace
(module name: (_) @name) @item.namespace

; const f = () => {} / const f = function () {}
(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: [(arrow_function) (function_expression)])) @item.function
(variable_declaration
  (variable_declarator
    name: (identifier) @name
    value: [(arrow_function) (function_expression)])) @item.function

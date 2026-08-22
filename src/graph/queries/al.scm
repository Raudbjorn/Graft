; AL (Business Central) tags — standard tree-sitter tags convention
; (@definition.<kind> + @name + @reference.call). Vendored for graft's
; generic breadth tier, alongside a vendored tree-sitter-al.wasm (there is
; no published npm grammar bundle for AL yet, unlike the other breadth-tier
; languages here — see graph/wasm/README.md).
;
; Every AL object header shares one `name` field regardless of object type
; (grammar.js's plainObject/implementingObject/extendingObject helpers), so
; each line below differs only in the wrapping node type and the @definition
; kind it maps to. `table`/`tableextension` -> struct (a data record type);
; `enum`/`enumextension` -> enum; `interface` -> interface; everything else
; (page/codeunit/report/query/xmlport/controladdin/permissionset/profile/
; entitlement and their *extension/*customization variants) -> class, the
; closest generic bucket for a named container of properties/procedures.
;
; Table fields, page controls, actions, and other constructs nested inside
; the grammar's generic `named_block` are NOT tagged as separate definitions
; here — v1 scope is object + procedure/trigger/event symbols and call
; edges, not full property/layout fidelity (see tree-sitter-al's README).
; Code inside a trigger/procedure nested arbitrarily deep in a named_block
; (e.g. a page action's OnAction trigger) is still correctly attributed to
; that trigger/procedure as its own @definition.method, so call-edge
; extraction is unaffected by that scope limit.

(table_declaration name: [(identifier) (quoted_identifier)] @name) @definition.struct
(tableextension_declaration name: [(identifier) (quoted_identifier)] @name) @definition.struct

(interface_declaration name: [(identifier) (quoted_identifier)] @name) @definition.interface

(enum_declaration name: [(identifier) (quoted_identifier)] @name) @definition.enum
(enumextension_declaration name: [(identifier) (quoted_identifier)] @name) @definition.enum

(page_declaration name: [(identifier) (quoted_identifier)] @name) @definition.class
(pageextension_declaration name: [(identifier) (quoted_identifier)] @name) @definition.class
(pagecustomization_declaration name: [(identifier) (quoted_identifier)] @name) @definition.class
(codeunit_declaration name: [(identifier) (quoted_identifier)] @name) @definition.class
(report_declaration name: [(identifier) (quoted_identifier)] @name) @definition.class
(reportextension_declaration name: [(identifier) (quoted_identifier)] @name) @definition.class
(query_declaration name: [(identifier) (quoted_identifier)] @name) @definition.class
(xmlport_declaration name: [(identifier) (quoted_identifier)] @name) @definition.class
(controladdin_declaration name: [(identifier) (quoted_identifier)] @name) @definition.class
(permissionset_declaration name: [(identifier) (quoted_identifier)] @name) @definition.class
(permissionsetextension_declaration name: [(identifier) (quoted_identifier)] @name) @definition.class
(profile_declaration name: [(identifier) (quoted_identifier)] @name) @definition.class
(profileextension_declaration name: [(identifier) (quoted_identifier)] @name) @definition.class
(entitlement_declaration name: [(identifier) (quoted_identifier)] @name) @definition.class

(procedure_declaration name: [(identifier) (quoted_identifier)] @name) @definition.method
(trigger_declaration name: [(identifier) (quoted_identifier)] @name) @definition.method
(event_declaration name: [(identifier) (quoted_identifier)] @name) @definition.method

(call_expression
  function: [
    (identifier) @name
    (field_access field: (identifier) @name)
    (field_access field: (quoted_identifier) @name)
  ]) @reference.call

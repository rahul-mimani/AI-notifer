Create a new file src/parser/DtoExtractor.ts that extracts Java DTO class definitions and their fields from Java source using web-tree-sitter. Types are defined in src/types.ts (currently open) — import DtoType and DtoField and produce values conforming to them exactly. Follow the same code style, error handling, and tree-walking approach as src/parser/RestExtractor.ts (also open).
Class shape:
Export a class DtoExtractor with:

Constructor: constructor(parser: Parser) where Parser is imported from web-tree-sitter. Store the parser as a private field.
Method: extract(sourceCode: string, filePath: string): DtoType[] — synchronous, returns an array. Never throws; on any error return [].

Imports:
typescriptimport { Parser, Node as SyntaxNode } from 'web-tree-sitter';
import { DtoType, DtoField } from '../types';
(If the exported name for a syntax node differs in the installed web-tree-sitter version, use whatever the package actually exports, matching what RestExtractor.ts did.)
Extraction rules:

Parse sourceCode with this.parser.parse(sourceCode). If the parse returns null or has errors on the root, return [].
Extract the file's package name from any package_declaration node at the top of the tree. Store as packageName (e.g. "com.example.cdu.dto"). If no package declaration, packageName = "".
Walk the tree looking for both class_declaration and record_declaration nodes at the top level (nested classes may be skipped for v1). For each such node, emit one DtoType.
For each class or record:

fqName: if packageName is non-empty, produce ${packageName}.${simpleName}; else just simpleName. simpleName comes from the name field of the declaration node.
file: use the filePath argument verbatim.
line: 1-indexed line number of the declaration (startPosition.row + 1).
fields: extract per rules below.


For class_declaration fields — iterate field_declaration nodes inside the class body (class_body node):

Skip constants: if the field's modifiers contain both the static and final keywords, skip it. Check modifiers node children for these keyword tokens.
For each remaining field, extract:

name: the identifier of the variable_declarator. A single field_declaration may declare multiple variables (private String a, b;) — emit one DtoField per declarator.
type: the declared type as source text. Read node.text on the type node. Preserve generic parameters verbatim (List<String>, Map<String, Integer>).
required: true if any of these annotations is present on the field: @NotNull, @NonNull, or @JsonProperty(required=true) / @JsonProperty(required = true). Match against both marker_annotation and annotation node types. Otherwise false.
nullable: true if @Nullable is present on the field; else !required.




For record_declaration — treat each record component as a field:

The record's formal parameters (record header) list each component with a name and type.
name: component name.
type: component type as source text.
required: true (record components are non-nullable positional args by convention).
nullable: false.
Ignore any annotations on record components for v1 (still emit each as a field).


Aggregate all DtoType entries from all top-level classes and records in the file into a flat array and return.

Implementation guidance:

Reuse the same walk(node, visitor) recursive helper pattern from RestExtractor.ts for tree traversal. If you extracted it into a shared helper there, just re-implement the same shape here (keeping each extractor self-contained for the hackathon).
Key node types for Java grammar you'll encounter: package_declaration, class_declaration, record_declaration, class_body, field_declaration, variable_declarator, modifiers, annotation, marker_annotation, annotation_argument_list, element_value_pair, type_identifier, generic_type, identifier, string_literal.
Use node.childForFieldName('name') where the grammar exposes named fields (class name, method name, variable declarator name). Use namedChildren for general traversal.
When checking annotation names, remember annotations may appear as either marker_annotation (no args, like @NotNull) or annotation (with args, like @JsonProperty(required=true)). Extract the annotation's name via its name field.
For @JsonProperty(required=true), walk the annotation's annotation_argument_list for an element_value_pair with name required and value true. String comparison on node.text is fine.
When getting a field's type text, be careful: in Java grammar, a field_declaration has a type field and one or more variable_declarator children. The type applies to all declarators.

Error handling:

Wrap the outermost logic in a try/catch. On exception, console.warn with the file path and error message, then return [].

Do not:

Do not use tree-sitter query strings.
Do not use fs or other Node.js APIs beyond what's imported.
Do not process nested classes for v1 — only top-level class_declaration and record_declaration.
Do not throw. Return [] on any failure.

Output format for a returned DtoType (example, for reference):
typescript{
  fqName: "com.example.cdu.dto.CustomerResponse",
  file: "customer-dto.java",
  line: 6,
  fields: [
    { name: "id", type: "String", nullable: false, required: true },
    { name: "name", type: "String", nullable: true, required: false },
    { name: "phone", type: "String", nullable: true, required: false },
    { name: "email", type: "String", nullable: false, required: true }
  ]
}
Note: the VERSION constant (static final) is excluded per rule 5. Confirm your extractor produces exactly this output for the fixture at test/fixtures/customer-dto.java.
Complete the file. Write clean, readable code. Add brief comments only where tree-walking or annotation parsing is non-obvious.
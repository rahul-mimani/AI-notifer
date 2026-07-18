Create a new file src/parser/RestExtractor.ts that extracts Spring REST endpoint definitions from Java source using the web-tree-sitter library. Types are defined in src/types.ts (currently open) — import RestEndpoint from there and produce values conforming to that type exactly.
Class shape:
Export a class RestExtractor with:

Constructor: constructor(parser: Parser) where Parser is imported from web-tree-sitter. Store the parser as a private field.
Method: extract(sourceCode: string, filePath: string): RestEndpoint[] — synchronous, returns an array. Never throws; on any error (parse failure, unexpected tree shape) return [].

Imports:
typescriptimport { Parser, Node as SyntaxNode } from 'web-tree-sitter';
import { RestEndpoint } from '../types';
(If the exported name for a syntax node differs in the installed web-tree-sitter version, use whatever the package actually exports and comment the choice.)
Extraction rules:

Parse sourceCode with this.parser.parse(sourceCode). If the parse returns null or has errors on the root, return [].
Walk the tree looking for class_declaration nodes. For each class:

Check its modifiers/annotations for @RestController or @Controller. Match against both marker_annotation (no args) and annotation (with args). If neither is present, skip the class.
Look for a class-level @RequestMapping(...) annotation. Extract its path argument as basePath. Handle these forms: @RequestMapping("/x"), @RequestMapping(value="/x"), @RequestMapping(path="/x"). If absent or empty, basePath = "".


Within each qualifying class, walk method_declaration nodes inside the class body. For each method:

Find HTTP-mapping annotations. Match any of: @GetMapping, @PostMapping, @PutMapping, @DeleteMapping, @PatchMapping, or @RequestMapping(method=RequestMethod.X, ...).
Skip the method if none is present.


For each mapping annotation, determine:

method: GetMapping → "GET", PostMapping → "POST", PutMapping → "PUT", DeleteMapping → "DELETE", PatchMapping → "PATCH". For @RequestMapping, read the method argument: RequestMethod.GET → "GET", etc. If method is absent on @RequestMapping, default to "GET".
methodPath: extract the string argument of the annotation. Handle @GetMapping("/x"), @GetMapping(value="/x"), @GetMapping(path="/x"). If absent, methodPath = "". Strip surrounding quotes.
path: concatenate basePath + methodPath. Do not modify {id} style variables — leave them raw. Do not deduplicate slashes; simple string concatenation is fine (assume inputs are well-formed).


For each method, extract:

requestType: iterate the method's formal_parameters. If any parameter has an @RequestBody annotation, capture that parameter's type name as a string (e.g. "CustomerRequest"). Return the first such match. If none, requestType = null.
responseType: read the method's declared return type. If the type is void, use "void". If the type is ResponseEntity<T>, extract T as the response type. Otherwise use the type name verbatim (e.g. "CustomerResponse", "List<Customer>").
authAnnotation: if the method has @PreAuthorize(...) or @Secured(...), capture the full annotation source text (including @ and arguments) as a string. If neither is present, omit this field entirely from the returned object (do not set it to undefined or null — omit it).
line: the 1-indexed line number of the method declaration. Tree-sitter uses 0-indexed startPosition.row; add 1.
file: use the filePath argument verbatim.
id: format ${method}:${path} (raw path, no normalization here).


Aggregate all endpoints from all qualifying classes in the file into a single flat array and return.

Implementation guidance:

Do not use tree-sitter query strings. Walk the tree manually with a recursive helper function walk(node: SyntaxNode, visitor: (n: SyntaxNode) => void) that visits each node depth-first.
Use node.type to identify node kinds. Key node types for Java grammar: class_declaration, class_body, method_declaration, formal_parameters, formal_parameter, annotation, marker_annotation, annotation_argument_list, element_value_pair, string_literal, modifiers, type_identifier, generic_type, void_type, identifier.
Use node.text to get the source text of a node. Use node.childForFieldName('name') for named fields where available (e.g. method_declaration has name, type, parameters, body fields).
When extracting annotation string arguments, remember string_literal node text includes the surrounding quotes — strip them.
Wrap the outermost logic in a try/catch. On exception, log to console.warn with the file path and error message, then return [].

Do not:

Do not use tree-sitter query strings (.query(...)).
Do not use fs — the caller provides source code as a string.
Do not import from fs, path, or Node.js built-ins other than what's strictly needed.
Do not throw. Return [] on any failure.
Do not invent tree-sitter API surfaces. If unsure between node.children and node.namedChildren, prefer namedChildren for traversal but access all children when scanning for annotations (annotations may be unnamed children of modifiers).

Output format for a returned endpoint (example, for reference):
typescript{
  id: "GET:/api/v1/customer/{id}",
  method: "GET",
  path: "/api/v1/customer/{id}",
  requestType: null,
  responseType: "CustomerResponse",
  file: "rest-provider.java",
  line: 9
}
Complete the file. Write clean, readable code. Add brief comments only where the tree-sitter walking is non-obvious.
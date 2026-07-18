Create a new file src/parser/HttpCallSiteExtractor.ts that extracts consumer-side outbound HTTP call sites from Java source using web-tree-sitter. Types are defined in src/types.ts (currently open) — import HttpCallSite and UsedField and produce values conforming to them exactly. Follow the same code style, error handling, and tree-walking approach as src/parser/RestExtractor.ts and src/parser/BeanExtractor.ts (both open).
Class shape:
Export a class HttpCallSiteExtractor with:

Constructor: constructor(parser: Parser). Store the parser as a private field.
Method: extract(sourceCode: string, filePath: string): HttpCallSite[] — synchronous. Never throws; on any error return [].

Imports:
typescriptimport { Parser, Node as SyntaxNode } from 'web-tree-sitter';
import { HttpCallSite, UsedField } from '../types';

Detection: three HTTP client patterns
Detect and emit one HttpCallSite per matching call. The three patterns are handled separately.
Pattern A — RestTemplate method calls
Match method_invocation nodes where:

The object field is an identifier whose declared type is RestTemplate, OR the identifier name equals restTemplate (case-insensitive contains resttemplate) as a fallback heuristic when type info isn't easily resolvable.
The name field is one of: getForObject, getForEntity, postForObject, postForEntity, exchange, put, delete.

For each match, extract:

method:

getForObject / getForEntity → "GET"
postForObject / postForEntity → "POST"
put → "PUT"
delete → "DELETE"
exchange → look at the second argument. If it's HttpMethod.GET / HttpMethod.POST / etc, extract the method literal. If unresolvable, default to "GET".


url: the first argument. See "URL extraction rules" below.
responseType: for getForObject / postForObject / put / delete, this is the argument ending in .class (typically the last argument). Extract the simple class name — e.g. CustomerResponse.class → "CustomerResponse". For getForEntity / postForEntity, same rule (still a .class argument). For exchange, look for a .class argument or a ParameterizedTypeReference<T> — best effort, extract T if a ParameterizedTypeReference literal is present, else the .class name, else "Object".

Pattern B — WebClient fluent chains
Match method_invocation chains that start with a method named get, post, put, or delete called on an object whose type is WebClient, or via a builder pattern. The chain ends with .bodyToMono(SomeType.class) or .bodyToFlux(SomeType.class) or .retrieve().
Practically:

Walk method_invocation nodes. When you find a bodyToMono or bodyToFlux call, walk backward through its receiver chain to find a .uri(...) call and an earlier .get() / .post() / etc that identifies the HTTP method.
method: from the earlier get()/post()/put()/delete() in the chain (uppercased).
url: the argument of the .uri(...) call. Use URL extraction rules.
responseType: the class argument of .bodyToMono(...) or .bodyToFlux(...).

If the chain is malformed or the pieces can't be found, skip the call.
Pattern C — @FeignClient interfaces
Match interface_declaration or class_declaration nodes with a @FeignClient annotation. Extract:

feignUrl: the url attribute value if present; else the name attribute value; else "unknown".
Iterate method declarations inside the interface. For each method annotated with any of @GetMapping, @PostMapping, @PutMapping, @DeleteMapping, @PatchMapping, or @RequestMapping:

method: from the annotation, same rules as RestExtractor.
path: from the annotation's path/value argument.
url: feignUrl + path — used only for provider extraction below; the path itself is stored as path.
responseType: the method's return type as source text. If Mono<T> / Flux<T> / ResponseEntity<T>, extract T.
usedFields: empty array [] (Feign interfaces don't have field-access sites).




URL extraction rules
An HTTP call's URL argument can be one of several node shapes. Handle these and normalize into a path string:

String literal — "http://cdu-service/customer/{id}" or "/customer/{id}":

Strip quotes.
If the URL contains ://, split off the scheme and host — the path is everything from the first / after the host.
Convert {anyName} segments to {} (this matches the normalizer format).


String concatenation — "http://cdu-service/customer/" + id:

The URL node is a binary_expression with operator +.
Walk left-to-right through the chain: for each operand, if it's a string_literal, keep its content; if it's any other expression (identifier, method call, etc), replace with {}.
Then apply the scheme/host stripping and path normalization above.
Example: "http://cdu-service/customer/" + id + "/items" → literal parts joined as "http://cdu-service/customer/{}/items", then stripped to /customer/{}/items.


String.format — String.format("http://cdu-service/customer/%s", id):

The URL node is a method_invocation with name format on String.
Take the first string argument as the template.
Replace every %s, %d, %f, %x, %b, %c, or any % + single letter format specifier with {}.
Then apply the scheme/host stripping.


Variable reference — the URL is a bare identifier like url:

Attempt to trace back to the variable's declaration within the same method's scope. Look for a local_variable_declaration with variable_declarator matching the identifier name.
If the initializer is a string literal, concatenation, or String.format, apply rules 1-3.
If not found or fully dynamic (initialized from another variable, method call, etc), skip this call site.


Fully dynamic — anything else (method return value, complex expression, ternary, etc): skip the call site entirely.

After extracting the path:

provider: extract from the URL. If the original URL contained ://<host>/..., provider is the host (e.g. "cdu-service"). For Feign, use the feignUrl value (or name attribute if feignUrl was the name). If no host is present (a bare path like /customer/{}), set provider to "unknown".
path: the normalized path string.
Strip any trailing / from path unless the path is / itself.


usedFields extraction (Patterns A and B only)
After finding an HTTP call, identify the variable the result was assigned to:

If the call is inside a local_variable_declaration like CustomerResponse response = restTemplate.getForObject(...), the variable name is the declarator's name (response).
If the call is a statement expression (result not assigned), usedFields = [].
For WebClient chains, the assignment applies to the terminal .bodyToMono(...) node's declarator.

Once you have the response variable name:

Within the enclosing method body only, find every access of the form <respVar>.<fieldName> (Tree-sitter node type: field_access, with object = identifier matching respVar, field = an identifier).
Also find getter calls of the form <respVar>.get<FieldName>() (Tree-sitter node type: method_invocation, name starting with get). Convert getPhone → phone by lowercasing the first letter after get.
Deduplicate by field name.
For each unique field access, emit { path: "response.<fieldName>", confidence: 'declared' }. Always use the literal string "response" as the prefix in the path, regardless of the actual variable name — this is the canonical form the matcher will use later.


Aggregation

Walk the entire file to find calls in all three patterns.
Emit one HttpCallSite per successful match.
Set file = filePath and line = 1-indexed line of the HTTP call node (for Pattern C, the line of the method declaration on the Feign interface).
Return the flat array.


Implementation guidance:

Reuse the same walk(node, visitor) recursive helper pattern.
Java grammar node types you'll use: method_invocation, argument_list, binary_expression, string_literal, identifier, field_access, local_variable_declaration, variable_declarator, interface_declaration, class_declaration, annotation, marker_annotation, annotation_argument_list, element_value_pair.
For Pattern B (WebClient chains), the receiver chain in Tree-sitter is a nested method_invocation tree — the object field of each method_invocation points to the previous call in the chain.
Enclosing method: to find the enclosing method for a call node, walk up the parent chain until you hit a method_declaration or constructor_declaration. Use its body for usedFields scoping.
Use node.text for reading source. Use node.childForFieldName(...) where fields are named (Java grammar names: method_invocation.object, method_invocation.name, method_invocation.arguments, variable_declarator.name, variable_declarator.value, field_access.object, field_access.field).

Error handling:

Wrap outer logic in try/catch. On exception, console.warn and return [].
Individual call-site failures inside the loop should be caught locally so one bad call doesn't abort the whole file.

Do not:

Do not use tree-sitter query strings.
Do not use fs or Node built-ins beyond imports.
Do not attempt to resolve types across files.
Do not emit call sites where the URL is fully dynamic and unresolvable.
Do not throw. Return [] on any failure.


Expected output for the provided fixture (test/fixtures/pou-http-caller.java):
Should return exactly two HttpCallSite entries:
typescript[
  {
    provider: "cdu-service",
    method: "GET",
    path: "/customer/{}",
    responseType: "CustomerResponse",
    usedFields: [
      { path: "response.phone", confidence: "declared" }
    ],
    file: "pou-http-caller.java",
    line: 13
  },
  {
    provider: "cdu-service",
    method: "POST",
    path: "/customer",
    responseType: "CustomerResponse",
    usedFields: [],
    file: "pou-http-caller.java",
    line: 17
  }
]
Note: the GET call site tracks the variable url back to String url = "http://cdu-service/customer/" + id (via Pattern A's URL rule 4 → concatenation → rule 2). The POST call site uses a direct string literal argument.
Complete the file. Write clean, readable code. Add brief comments only where the tree-walking, URL tracing, or usedFields scoping is non-obvious.
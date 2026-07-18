Modify the existing `src/parser/RestExtractor.ts` (currently open) to correctly handle three cases that the current implementation misses in real Spring codebases:

1. **`@RequestMapping` with named arguments** (`value =`, `method =`, `consumes =`, etc.) — not just the shortcut `@GetMapping`/`@PostMapping` annotations.
2. **Methods with multiple annotations** before the mapping annotation (like `@Operation`, `@ApiResponses`, then `@RequestMapping`).
3. **Interface declarations** as endpoint hosts, including class-level `@RequestMapping` for a base path on the interface.

The extractor already works for `@RestController` classes with shortcut annotations on methods. **Do not regress that behavior.** The changes below extend the extractor without changing the public interface.

## Concrete pattern this must handle

The extractor MUST correctly extract 3 endpoints from this file:

```java
package com.scb.cdu.api;

import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.*;

@RequestMapping("/domain/document")
public interface DomainAPI {

    @Operation(summary = "Upload the document")
    @ApiResponses(value = { @ApiResponse(responseCode = "200") })
    @RequestMapping(value ="/upload", method = RequestMethod.POST, consumes = { MediaType.MULTIPART_FORM_DATA_VALUE })
    public UploadDocumentResponse uploadDocument(@Valid @RequestPart("file") MultipartFile file, @Valid @RequestPart("request") UploadDocumentRequest request);

    @Operation(summary = "Tag the document")
    @RequestMapping(value ="/tag", method = RequestMethod.POST)
    public TagDocumentResponse tagDocument(@RequestPart(value = "file", required = false) MultipartFile file, @Valid @RequestPart("request") TagDocumentRequest request);

    @RequestMapping(value ="/getSuggestedDocTypeList", method = RequestMethod.POST, consumes = { MediaType.APPLICATION_JSON_VALUE })
    public CduDocTypeListResponse getSuggestedDocTypeList(@Validated({Default.class, DomainValidation.class}) @RequestBody CduDocTypeListRequest request);
}
```

Expected output (3 endpoints):
- `POST /domain/document/upload` with `requestType: UploadDocumentRequest`, `responseType: UploadDocumentResponse`
- `POST /domain/document/tag` with `requestType: TagDocumentRequest`, `responseType: TagDocumentResponse`
- `POST /domain/document/getSuggestedDocTypeList` with `requestType: CduDocTypeListRequest`, `responseType: CduDocTypeListResponse`

## Change 1 — recognize `@RequestMapping` as a mapping annotation, robustly

The extractor already has a list of "mapping annotation" names: `GetMapping`, `PostMapping`, `PutMapping`, `DeleteMapping`, `PatchMapping`, `RequestMapping`. Confirm all six are recognized. If `RequestMapping` is currently only recognized at the class level (as a base path source), it must ALSO be recognized as a method-level mapping annotation.

Add or update an internal helper:

```typescript
function isMappingAnnotationName(name: string): boolean {
  return [
    'GetMapping', 'PostMapping', 'PutMapping', 'DeleteMapping', 'PatchMapping',
    'RequestMapping'
  ].includes(name);
}
```

When looking for a mapping annotation on a method, iterate ALL annotations on that method (via `modifiers` node or the leading annotation nodes) and pick the FIRST one whose name is in the list above. Do NOT stop at the first annotation seen — a method may have `@Operation`, `@ApiResponses`, `@Override`, then finally `@RequestMapping`. Skip past non-mapping annotations.

## Change 2 — parse `@RequestMapping` named arguments correctly

The current code likely handles simple forms like `@GetMapping("/x")` or `@RequestMapping(value="/x")`. It must also handle:

```java
@RequestMapping(value ="/upload", method = RequestMethod.POST, consumes = { MediaType.MULTIPART_FORM_DATA_VALUE })
```

Named-argument parsing rules:

- The `annotation_argument_list` contains one or more children. For annotations with named args, these are `element_value_pair` nodes.
- Each `element_value_pair` has a `key` (an identifier node) and a `value` (any expression node).
- Iterate ALL `element_value_pair` children. For each, read the `key` identifier's text.
- **path**: look for a pair with key `"value"` or `"path"`. The pair's value should be a `string_literal`. Extract its content (strip the surrounding quotes).
- **method**: look for a pair with key `"method"`. The pair's value is typically a `field_access` node with source text like `RequestMethod.POST` or just `POST`. Extract the last dot-segment as the method name. Uppercase the result.
- **other args** (`consumes`, `produces`, `headers`, `params`): ignore. Do not fail parsing when they appear.
- If the annotation has a single unnamed argument that is a `string_literal`, treat that as the value (e.g. `@RequestMapping("/upload")` or `@GetMapping("/x")` — the shortcut annotations continue to work this way).

For the `method` value handling — the tree-sitter node for `RequestMethod.POST` is typically `field_access` with `object` = `RequestMethod` identifier and `field` = `POST` identifier. It could also be just an `identifier` if imported. Robust extraction:

```typescript
function extractMethodValueText(valueNode: SyntaxNode): string {
  // Take the last identifier segment. Works for RequestMethod.POST, POST, X.Y.POST, etc.
  const text = valueNode.text.trim();
  const parts = text.split('.');
  return parts[parts.length - 1].toUpperCase();
}
```

If the `method` argument is missing entirely on `@RequestMapping`, default to `"GET"` (matches Spring's behavior).

For the shortcut annotations, HTTP method is derived from the annotation name as before: `GetMapping` → `"GET"`, etc.

## Change 3 — extract from `interface_declaration` nodes

Extend the top-level walk to also visit `interface_declaration` nodes. For each interface:

- Do NOT require any class-level annotation. An interface with any method-level mapping annotation qualifies as an endpoint host.
- Support class-level `@RequestMapping(...)` on the interface as the base path (same rules as for classes). Use the same argument parser from Change 2.
- Iterate `method_declaration` children in the interface body (Java grammar node type is still `method_declaration` for interface methods — they just have no `method_declaration.body`).
- For each method, apply the same mapping annotation search + argument parsing as for class methods.
- Skip the interface if none of its methods has a mapping annotation.

**Do not fail if an interface has methods without annotations** — those are just non-REST interface methods (like default methods, or helper contracts). Skip them silently.

## Change 4 — deduplicate results by endpoint id (first-wins)

Before returning from `extract`, deduplicate the accumulated endpoints by `endpoint.id`. Process order: class_declaration nodes first, then interface_declaration nodes. First-wins ensures that if a class re-declares the annotation (defensively), the class's line number is preserved. If only the interface has it, the interface's line number is used.

Implementation:

```typescript
const seen = new Map<string, RestEndpoint>();
for (const ep of allEndpoints) {
  if (!seen.has(ep.id)) {
    seen.set(ep.id, ep);
  }
}
return Array.from(seen.values());
```

## Change 5 — path composition and normalization

For the `path` field on each RestEndpoint:

- Compute `path = basePath + methodPath`.
- If both are non-empty and neither has a leading/trailing slash issue, simple concatenation is fine.
- If `basePath` ends with `/` and `methodPath` starts with `/`, avoid the double slash: strip one.
- If `basePath` is empty, the result is just `methodPath`.
- If `methodPath` is empty, the result is just `basePath`.

For `id`: format as `${method}:${path}` using the raw (post-composition) path. Normalization is applied later by the matcher.

## Change 6 — request/response type extraction from interface methods

For interface methods, the request/response type extraction is identical to class methods:

- **requestType**: iterate `formal_parameters`. If any parameter has `@RequestBody` or `@RequestPart` (for multipart), capture that parameter's type name.
  - Important: `@RequestPart("request") UploadDocumentRequest request` should capture `UploadDocumentRequest` as the requestType. Look for `@RequestPart` in addition to `@RequestBody`.
  - If both `@RequestBody` and `@RequestPart` are present in the same method, prefer `@RequestBody`. If multiple `@RequestPart` params exist, take the one whose name argument is `"request"` (a Spring convention); if no such match, take the first one that is NOT a `MultipartFile`.
  - Skip `MultipartFile` parameters — those are file uploads, not request DTOs.
- **responseType**: the method's declared return type as source text. Unwrap `ResponseEntity<T>` to `T`. Use `"void"` if the return type is `void`.
- Interface methods have no body (`;` instead of `{}`) — this is fine, we only need the signature.

## Change 7 — preserve existing behavior

Do not change:

- Public class name `RestExtractor` or its constructor signature.
- Public method signature `extract(sourceCode: string, filePath: string): RestEndpoint[]`.
- The tree-walking helper `walk(node, visitor)`.
- The outer try/catch — extractor still returns `[]` on parse failure.
- Handling of `@RestController` and `@Controller` on classes.
- Existing tests (`RestExtractor` behavior on the fixture `test/fixtures/rest-provider.java` must remain identical).

## Suggested internal refactor

Since we now have two kinds of "endpoint hosts" (annotated classes and interfaces), refactor internally to reduce duplication:

```typescript
interface EndpointHost {
  hostNode: SyntaxNode;           // class_declaration or interface_declaration
  hostType: 'class' | 'interface';
  basePath: string;
  bodyNode: SyntaxNode | null;    // class_body or interface_body
}

function collectEndpointHosts(root: SyntaxNode): EndpointHost[]
function extractEndpointsFromHost(host: EndpointHost, filePath: string): RestEndpoint[]
```

`collectEndpointHosts` traverses the root, finding `class_declaration` nodes with `@RestController`/`@Controller` AND `interface_declaration` nodes with at least one method-annotated with a mapping annotation. It resolves `basePath` from any class-level `@RequestMapping` (using the named-arg parser).

`extractEndpointsFromHost` iterates methods inside `host.bodyNode`, finds the first mapping annotation per method, parses its args, and emits a RestEndpoint.

Then the top-level `extract` method does:

```typescript
const hosts = collectEndpointHosts(rootNode);
const all: RestEndpoint[] = [];
for (const host of hosts) {
  all.push(...extractEndpointsFromHost(host, filePath));
}
// Dedup by id, class-first order preserves class precedence
const seen = new Map<string, RestEndpoint>();
for (const ep of all) if (!seen.has(ep.id)) seen.set(ep.id, ep);
return Array.from(seen.values());
```

Sort `hosts` so all `class` entries come before `interface` entries.

## Do not

- Do not use tree-sitter query strings.
- Do not fail if arg parsing encounters an unknown arg name — just skip it.
- Do not fail if the `method` arg value node type is unexpected — attempt `.text.split('.').pop()` as a fallback.
- Do not extract endpoints from methods that have zero mapping annotations. `@Override` alone is NOT a mapping annotation and must not trigger extraction.
- Do not extract from abstract classes with no mapping annotations on their methods.
- Do not process nested classes or nested interfaces (top-level only).
- Do not attempt cross-file inheritance resolution. If a class extends an interface in a different file and neither the class methods nor the class have their own mapping annotations, that class produces zero endpoints — the interface file (processed separately) will produce them.
- Do not throw. Return `[]` on any unexpected error at the outermost level.

## Expected behavior after fix

For the pattern shown at the top of this prompt (the DomainAPI interface + a DomainController that just implements it), running the extractor on:

- `DomainAPI.java` returns 3 endpoints, all with method POST, paths `/domain/document/upload`, `/domain/document/tag`, `/domain/document/getSuggestedDocTypeList`.
- `DomainController.java` returns 0 endpoints (no annotations on class methods, and the class-level `@RestController` alone without any annotated methods produces nothing).

The final SurfaceSet after both files are processed contains 3 unique endpoints.

Complete the modification. Preserve JSDoc comments and code style. If refactoring into `collectEndpointHosts` / `extractEndpointsFromHost` makes the code cleaner, do that; otherwise inline is fine as long as all three cases (class shortcut, class `@RequestMapping`, interface with mixed annotations) are covered.
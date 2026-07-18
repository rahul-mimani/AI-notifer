Modify the existing `src/parser/RestExtractor.ts` (currently open) to also extract REST endpoints from Java interface declarations, not just class declarations. This fixes a bug where controllers that extend an interface (with mapping annotations on the interface methods) are missed entirely.

## The bug this fixes

Consider a common Spring pattern where the API contract lives on an interface:

```java
public interface CustomerApi {
    @GetMapping("/customer/{id}")
    CustomerResponse getCustomer(@PathVariable String id);

    @PostMapping("/customer")
    CustomerResponse createCustomer(@RequestBody CustomerRequest req);
}

@RestController
@RequestMapping("/api/v1")
public class CustomerController implements CustomerApi {
    @Override
    public CustomerResponse getCustomer(String id) { return null; }

    @Override
    public CustomerResponse createCustomer(CustomerRequest req) { return null; }
}
```

The current extractor sees `@RestController` on the class, walks its methods, finds no `@GetMapping`/`@PostMapping` annotations (they're inherited from the interface), and skips them. Result: both endpoints missing from the manifest.

## The fix — three changes

### Change 1 — walk interface_declaration too

Extend the existing walk to also visit `interface_declaration` nodes at the top level. For each interface:

- Do NOT require any class-level annotation (no `@RestController` check on interfaces). Interfaces don't get that annotation, but their methods have the mapping annotations by convention, which is enough to identify them as REST surface.
- Handle a class-level `@RequestMapping("/base")` on the interface the same way as on a class — capture as `basePath`. Interfaces can legitimately declare a base path.
- Iterate the interface's methods. Java grammar node type inside an `interface_declaration` body is typically `method_declaration` (same as classes — interface methods are just method_declaration without a body). Walk them the same way.
- For each method with a mapping annotation, extract fields exactly as for class methods: HTTP method, path (basePath + methodPath), requestType from `@RequestBody`, responseType from return type, authAnnotation, line, file, id.

### Change 2 — deduplicate by id

Some codebases redundantly annotate BOTH the interface method AND the implementing class method with the same `@GetMapping`. Without dedup, we'd emit two identical endpoints.

After collecting all endpoints from all classes and interfaces in the file:
- Build a `Map<string, RestEndpoint>` keyed by `endpoint.id`.
- For each extracted endpoint, if the id is not in the map, add it. If it IS in the map, skip (first-wins).
- Return the map's values as the final array.

Iteration order: process class_declaration nodes first, then interface_declaration nodes. This makes the class-level entry win when there's a conflict — its line number and file point at the actual runtime handler, which is more useful for debugging than the interface declaration.

### Change 3 — annotation matching helper (already present, verify)

The existing helper that matches annotation names (like `@GetMapping`, `@RestController`) should work unchanged for interface methods — it operates on annotation nodes regardless of whether they sit inside a class or an interface. No changes needed there.

## Implementation notes

- Do NOT extract from ALL interfaces indiscriminately. Only extract from an interface if at least one of its methods has a mapping annotation. This filters out ordinary Java interfaces (Repositories, Services, etc.) that happen to be in the same file.
- The `RestExtractor.extract` public method signature does not change.
- Return type is still `RestEndpoint[]`.
- Preserve all existing behavior for class_declaration extraction — do not regress the class-only case.
- Continue to skip nested classes and nested interfaces (top-level only, per v1 scope).
- Keep the existing try/catch outer wrapper. Return `[]` on any parse failure.

## What to preserve verbatim

Do not modify:
- The constructor signature (still takes `Parser`).
- The public method signature (`extract(sourceCode, filePath)`).
- The imports (unless you need to import a new tree-sitter node type name — but standard node types don't need explicit imports).
- The overall try/catch structure and error handling philosophy.
- The `walk` recursive helper.

## Suggested edit shape

Refactor the extractor so its main loop first collects all "endpoint host" declarations (classes annotated with @RestController/@Controller, PLUS interfaces with any method-level mapping annotation), then for each host runs the same per-method extraction logic. Something like:

```typescript
interface EndpointHost {
  node: SyntaxNode;              // class_declaration or interface_declaration
  basePath: string;
  authAnnotationDefault?: string; // if any class/interface-level auth annotation applies
}

function collectHosts(root: SyntaxNode): EndpointHost[]
function extractEndpointsFromHost(host: EndpointHost, filePath: string): RestEndpoint[]
```

Then:

```typescript
const hosts = collectHosts(tree.rootNode);
const allEndpoints: RestEndpoint[] = [];
for (const host of hosts) {
  allEndpoints.push(...extractEndpointsFromHost(host, filePath));
}

// Dedup by id (first-wins)
const seen = new Map<string, RestEndpoint>();
for (const ep of allEndpoints) {
  if (!seen.has(ep.id)) {
    seen.set(ep.id, ep);
  }
}
return Array.from(seen.values());
```

The order of hosts in the collected array determines dedup precedence. Ensure classes come before interfaces in the array.

## Expected behavior after fix

For a file containing the pattern shown at the top of this prompt:

- 2 endpoints returned: `GET:/api/v1/customer/{id}` and `POST:/api/v1/customer`.
- The `line` field on each endpoint should point at the interface's method declaration (since only the interface has the annotation). This is the correct behavior — the annotation IS the surface declaration.
- If the class also had the annotations, the line would point at the class methods instead (first-wins with class-first ordering).

For a file containing only an ordinary interface with no mapping annotations, the extractor should return `[]` — no false positives for non-REST interfaces.

For a file containing only a `@RestController` class with method-level annotations (the existing working case), behavior is unchanged.

Do the fix. Preserve JSDoc comments and code style. Complete the file.
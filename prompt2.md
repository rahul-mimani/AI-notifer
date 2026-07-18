Two independent bugs in the extractor pipeline need fixing:

## Bug 1 — package name never extracted

All three extractors (`RestExtractor`, `DtoExtractor`, `BeanExtractor`) are supposed to extract the file's `package` declaration and prepend it to class/interface names to produce fully-qualified names (FQNs). Currently, EVERY extracted DTO's `fqName` is just the simple class name (no dots), and every bean's `type` is the simple class name. This means the file-level `package_declaration` node is never being read successfully — the code silently falls back to the "no package" branch.

## Bug 2 — a specific interface file (`DomainAPI.java`) produces zero endpoints

The regex fallback for interface `@RequestMapping` extraction was added but is not producing results for real interfaces. Either it's not wired in, not called from the main `extract` method, or it's silently failing on the specific pattern.

## The fix — a shared, regex-based package extractor + hardened interface wiring

### Step 1 — create a new shared utility module

Create `src/parser/SourceUtils.ts` with these exports:

```typescript
/**
 * Extracts the package name from Java source code using a regex.
 * Robust to whitespace and comments around the declaration.
 * Returns "" if no package declaration is found (default package).
 */
export function extractPackageName(sourceCode: string): string {
  // Match: package <dotted.name>;
  // Allow leading whitespace, comments before it, multi-line comments.
  const match = sourceCode.match(/^\s*(?:\/\*[\s\S]*?\*\/\s*)*(?:\/\/.*\n\s*)*package\s+([\w.]+)\s*;/m);
  return match ? match[1] : '';
}

/**
 * Extracts simple-to-FQN mapping from import statements.
 * `import com.x.Y;` → { "Y": "com.x.Y" }
 * `import static com.x.Y.Z;` → ignored (static imports don't help type resolution).
 * `import com.x.*;` → ignored (wildcard imports can't resolve to specific FQNs).
 */
export function extractImports(sourceCode: string): Map<string, string> {
  const map = new Map<string, string>();
  const importRegex = /^\s*import\s+((?!static\s)[\w.]+)\s*;/gm;
  let m;
  while ((m = importRegex.exec(sourceCode)) !== null) {
    const fqn = m[1];
    if (fqn.endsWith('*')) continue;
    const parts = fqn.split('.');
    const simple = parts[parts.length - 1];
    map.set(simple, fqn);
  }
  return map;
}

/**
 * Resolves a simple type name to its FQN using imports and the current package.
 * If the type appears in `imports`, returns the imported FQN.
 * If the type has dots (already qualified), returns it verbatim.
 * If neither, returns `${currentPackage}.${simpleName}` (assumes same package).
 * If currentPackage is empty, returns the simple name.
 */
export function resolveTypeName(
  simpleName: string,
  imports: Map<string, string>,
  currentPackage: string
): string {
  const trimmed = simpleName.trim();
  // Handle generics — resolve only the outer type, keep params verbatim.
  const genericMatch = trimmed.match(/^([\w.]+)(<.*>)$/);
  if (genericMatch) {
    const outer = genericMatch[1];
    const params = genericMatch[2];
    return resolveTypeName(outer, imports, currentPackage) + params;
  }
  if (trimmed.includes('.')) return trimmed;
  const imported = imports.get(trimmed);
  if (imported) return imported;
  if (currentPackage) return `${currentPackage}.${trimmed}`;
  return trimmed;
}

/**
 * Compute 1-indexed line number for a character position in the source.
 */
export function lineForPosition(source: string, pos: number): number {
  let line = 1;
  for (let i = 0; i < pos && i < source.length; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}
```

### Step 2 — update the three extractors to use `extractPackageName`

In `src/parser/DtoExtractor.ts`, `src/parser/BeanExtractor.ts`, and `src/parser/RestExtractor.ts`:

- Add import: `import { extractPackageName, extractImports, resolveTypeName } from './SourceUtils';`
- At the top of each `extract*` method, before any tree-sitter walking:
  ```typescript
  const packageName = extractPackageName(sourceCode);
  const imports = extractImports(sourceCode);
  ```
- Replace ALL existing logic that tries to determine the package name from the tree-sitter walk with `packageName` from the helper. Do not remove the tree-sitter walking for the class/interface bodies — only replace the package-name determination step.
- Where the extractor currently constructs an `fqName` or a bean `type`, use:
  ```typescript
  const fqName = packageName ? `${packageName}.${simpleName}` : simpleName;
  ```
- Where an extractor resolves an injected/referenced type name (in `BeanExtractor.extractInjections` and `RestExtractor` for `@RequestBody` types), use `resolveTypeName(rawTypeText, imports, packageName)` to get the FQN.

### Step 3 — ensure the RestExtractor regex fallback is actually wired

In `src/parser/RestExtractor.ts`, verify the public `extract` method has this exact structure:

```typescript
public extract(sourceCode: string, filePath: string): RestEndpoint[] {
  const treeSitterEndpoints = this.extractWithTreeSitter(sourceCode, filePath);
  const regexEndpoints = this.extractInterfaceEndpointsViaRegex(sourceCode, filePath);
  
  console.debug(
    `RestExtractor ${filePath}: tree-sitter=${treeSitterEndpoints.length}, regex-fallback=${regexEndpoints.length}`
  );
  
  const seen = new Map<string, RestEndpoint>();
  for (const ep of treeSitterEndpoints) if (!seen.has(ep.id)) seen.set(ep.id, ep);
  for (const ep of regexEndpoints) if (!seen.has(ep.id)) seen.set(ep.id, ep);
  return Array.from(seen.values());
}
```

If the tree-sitter logic is currently inline in `extract`, extract it into a new private method `extractWithTreeSitter(sourceCode, filePath): RestEndpoint[]` first. Then wire both into the public `extract` as shown.

The `console.debug` line is CRITICAL — it's how we diagnose whether the regex is running per-file. Keep it in.

### Step 4 — harden the regex fallback for the DomainAPI case

The existing regex fallback pattern may miss the interface if the interface line has an `@RequestMapping("/domain/document")` attached. Verify the interface regex handles this specific case:

```java
@RequestMapping("/domain/document")
public interface DomainAPI {
```

The regex must match:
- Optional class-level `@RequestMapping(...)` (with any arg form: `"x"`, `value="x"`, `path="x"`)
- Optional modifiers (`public`, `abstract`)
- The keyword `interface`
- The interface name
- Optional `extends` clause (may span multiple lines with commas and generics)
- The opening `{`

Update the interface regex:

```typescript
private interfacePattern = new RegExp(
  // Optional class-level @RequestMapping — capture path
  '(?:@RequestMapping\\s*\\(\\s*(?:(?:value|path)\\s*=\\s*)?"([^"]*)"[^)]*\\)\\s*)?' +
  // Optional other class-level annotations (e.g. @Validated, @Tag) — skip past them
  '(?:@\\w+(?:\\s*\\([^)]*\\))?\\s*)*' +
  // Optional modifiers
  '(?:public\\s+|abstract\\s+)*' +
  // interface keyword and name
  'interface\\s+(\\w+)' +
  // Optional generic params and extends clause (may span lines)
  '(?:\\s*<[^{]*?>)?' +
  '(?:\\s+extends\\s+[^{]+?)?' +
  // Opening brace
  '\\s*\\{',
  'gs'
);
```

The `s` flag lets `.` match newlines, so multi-line `extends` clauses work.

Also: some real interfaces have a `@Validated` or `@Tag` annotation between `@RequestMapping` and `interface`. The `(?:@\\w+(?:\\s*\\([^)]*\\))?\\s*)*` addition skips these.

### Step 5 — add strong logging so we can see what's happening in production

Add a top-level log at the start of each extractor's public method:

```typescript
public extract(sourceCode: string, filePath: string): RestEndpoint[] {
  const hasInterface = /\binterface\s+\w+/.test(sourceCode);
  const hasRequestMapping = /@RequestMapping/.test(sourceCode);
  const packageName = extractPackageName(sourceCode);
  
  if (hasInterface && hasRequestMapping) {
    console.log(
      `RestExtractor: processing interface+@RequestMapping file: ${filePath}, package="${packageName}"`
    );
  }
  
  // ... existing logic
}
```

This gives us a per-file confirmation in the console that (a) the file is reaching the extractor, (b) the package was detected. If we see this line for DomainAPI.java but still get 0 endpoints, the problem is definitively in the regex or tree-sitter walking, not in file discovery or package extraction.

### Step 6 — verify the walker in GeneratePipeline is finding DomainAPI.java

Add one diagnostic log to `src/pipeline/GeneratePipeline.ts` inside the file walking logic:

```typescript
const files = await walkJavaFiles(searchRoot);
console.log(`GeneratePipeline: walked ${searchRoot}, found ${files.length} .java files`);
const apiFiles = files.filter(f => f.includes('DomainAPI') || f.includes('/api/'));
if (apiFiles.length > 0) {
  console.log(`GeneratePipeline: found API files: ${apiFiles.slice(0, 5).join(', ')}`);
} else {
  console.warn(`GeneratePipeline: NO API files found in walk. Skip rules may be filtering too aggressively.`);
}
```

If this log shows 0 API files, the walker is filtering `/api/` folders — check the skip rules in `walkJavaFiles` and make sure `api` is NOT in the skip list. Some codebases use directory names like `api`, `internal`, etc. that might collide with the skip rules.

## Expected outcomes

After applying the fix and reloading:

**In the debug console, you should see:**

```
GeneratePipeline: walked /path/to/CDU/src/main/java, found N .java files
GeneratePipeline: found API files: /path/to/CDU/src/main/java/com/scb/cdu/api/DomainAPI.java, ...
...
RestExtractor: processing interface+@RequestMapping file: <relative-path>/DomainAPI.java, package="com.scb.cdu.api"
RestExtractor <relative-path>/DomainAPI.java: tree-sitter=0, regex-fallback=3
```

The third line is the "aha" — it tells us the regex fallback fired and found 3 endpoints. If regex-fallback is 0 in this log, the regex is bugged and we need to debug the pattern directly.

**In the new store.md:**

```bash
grep -A 3 "fqName:" /path/to/CDU/store.md | head -20
```

Should now show FQNs with dots (`com.scb.cdu.dto.CustomerResponse`, etc.).

```bash
grep "DomainAPI" /path/to/CDU/store.md
```

Should show at least the 3 endpoints from DomainAPI (as `id: POST:/domain/document/upload`, etc.). DomainAPI itself may or may not appear depending on whether it's also being extracted as a DTO — but the endpoints are what matter.

## Preserve existing behavior

- Do not modify types in `src/types.ts`.
- Do not change any public method signatures.
- Do not remove the try/catch outer wrappers on extractors.
- Do not remove existing JSDoc comments.
- Do not modify the store writer, diff engine, matcher, or any downstream component.

## Do not

- Do not import from `LmClient`, `Prompts`, or any non-parser module.
- Do not use synchronous `fs` calls (extractors don't touch fs at all — source code is passed as a string).
- Do not throw. Return `[]` on any error.
- Do not remove the `console.debug` and `console.log` lines added in this fix — they're your only diagnostic surface in production.

Complete all four file modifications.
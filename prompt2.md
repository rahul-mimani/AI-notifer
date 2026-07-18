Add strategic debug logging to trace a single Java file through the extractor pipeline. The goal: pinpoint the exact step where processing of `DomainAPI.java` (an interface with `@RequestMapping` on methods) drops off and produces zero endpoints. Do not add any logic changes — only logging. Do not modify types, behavior, or control flow.

Files to modify:
1. `src/pipeline/GeneratePipeline.ts` — log file walk and per-file handoff.
2. `src/parser/RestExtractor.ts` — log per-file entry, tree-sitter walk decisions, and per-endpoint emission.

The logs are strategically labeled with a prefix (`[DIAG]`) so they're easy to grep in the console. They log a lot of information but only when triggered by a "file of interest" — a file whose name contains `Api.java`, `API.java`, or `Controller.java`, or whose path contains `/api/`. This keeps the noise manageable while still capturing the interesting cases.

## Change 1 — `src/pipeline/GeneratePipeline.ts`

Locate the `walkJavaFiles` call and the loop that processes each file. Add these logs:

**After `walkJavaFiles` returns:**

```typescript
console.log(`[DIAG] GeneratePipeline: workspaceRoot = ${workspaceRoot}`);
console.log(`[DIAG] GeneratePipeline: walked to find files, total = ${files.length}`);

const filesOfInterest = files.filter(f =>
  /Api\.java$/i.test(f) || /Controller\.java$/i.test(f) || /\/api\//.test(f)
);
console.log(`[DIAG] GeneratePipeline: files of interest (interfaces/controllers/api dirs) = ${filesOfInterest.length}`);
for (const f of filesOfInterest.slice(0, 20)) {
  console.log(`[DIAG]   ${f}`);
}
if (filesOfInterest.length > 20) {
  console.log(`[DIAG]   ... and ${filesOfInterest.length - 20} more`);
}
```

**Inside the per-file processing loop, right before calling extractors:**

```typescript
const isFileOfInterest =
  /Api\.java$/i.test(filePath) ||
  /Controller\.java$/i.test(filePath) ||
  /\/api\//.test(filePath);

if (isFileOfInterest) {
  console.log(`[DIAG] GeneratePipeline: about to extract from ${relPath}`);
  console.log(`[DIAG]   source length = ${src.length} bytes`);
  console.log(`[DIAG]   source first 200 chars: ${src.substring(0, 200).replace(/\n/g, '\\n')}`);
}
```

**After the extractor calls, log the counts:**

```typescript
if (isFileOfInterest) {
  const restCount = surface.provides.endpoints.filter(e => e.file === relPath).length;
  const dtoCount = surface.provides.dtos.filter(d => d.file === relPath).length;
  const beanCount = surface.provides.beans.filter(b => b.file === relPath).length;
  console.log(`[DIAG] GeneratePipeline: extracted from ${relPath} → REST=${restCount}, DTO=${dtoCount}, Bean=${beanCount}`);
}
```

Note: these counts are computed by filtering the accumulated `surface` arrays for entries whose `file` matches the relative path. This is a simple way to see how many entries each file contributed without changing the extractor API.

Preserve the existing per-file try/catch around extractor calls. The logs go INSIDE the try block for the pre-extraction log, and the post-extraction log too.

Also add one log inside the catch block:

```typescript
} catch (err) {
  console.warn(`GeneratePipeline: extractor failed on ${relPath}: ${(err as Error).message}`);
  if (isFileOfInterest) {
    console.error(`[DIAG] GeneratePipeline: file of interest FAILED: ${relPath}`);
    console.error(`[DIAG]   error: ${(err as Error).message}`);
    console.error(`[DIAG]   stack: ${(err as Error).stack}`);
  }
}
```

## Change 2 — `src/parser/RestExtractor.ts`

At the top of the public `extract` method, before any tree-sitter parsing:

```typescript
public extract(sourceCode: string, filePath: string): RestEndpoint[] {
  const isFileOfInterest =
    /Api\.java$/i.test(filePath) ||
    /Controller\.java$/i.test(filePath) ||
    /\/api\//.test(filePath);
  
  if (isFileOfInterest) {
    console.log(`[DIAG] RestExtractor.extract ENTERED: ${filePath}`);
    console.log(`[DIAG]   hasInterface = ${/\binterface\s+\w+/.test(sourceCode)}`);
    console.log(`[DIAG]   hasClass = ${/\bclass\s+\w+/.test(sourceCode)}`);
    console.log(`[DIAG]   hasRequestMapping = ${/@RequestMapping/.test(sourceCode)}`);
    console.log(`[DIAG]   hasRestController = ${/@RestController/.test(sourceCode)}`);
  }
  
  // ... existing logic
}
```

**Around the tree-sitter parse call:**

```typescript
let tree;
try {
  tree = this.parser.parse(sourceCode);
} catch (err) {
  if (isFileOfInterest) {
    console.error(`[DIAG] RestExtractor: parser.parse THREW on ${filePath}: ${(err as Error).message}`);
  }
  return [];
}

if (!tree || !tree.rootNode) {
  if (isFileOfInterest) {
    console.error(`[DIAG] RestExtractor: parser.parse returned null tree for ${filePath}`);
  }
  return [];
}

if (isFileOfInterest) {
  console.log(`[DIAG] RestExtractor: parsed OK, root type = ${tree.rootNode.type}, child count = ${tree.rootNode.namedChildren.length}`);
  const topLevelTypes = tree.rootNode.namedChildren.map(c => c.type);
  console.log(`[DIAG] RestExtractor: top-level node types: ${topLevelTypes.join(', ')}`);
}
```

The last two logs are the most important. If `topLevelTypes` includes `interface_declaration`, then tree-sitter DID parse the interface — the extractor just isn't handling it. If it does NOT include `interface_declaration`, then the parse failed or the grammar is producing a different node name than we expect.

**Inside the main walking logic, wherever the extractor decides to process a `class_declaration` or `interface_declaration`:**

Add logs at the decision points. Look for the code that checks for `@RestController` on classes and for interface declarations:

```typescript
// Wherever class extraction begins:
if (isFileOfInterest && node.type === 'class_declaration') {
  const className = node.childForFieldName('name')?.text ?? '?';
  console.log(`[DIAG] RestExtractor: examining class_declaration "${className}"`);
  const hasController = /* whatever the existing check is */;
  console.log(`[DIAG]   has @RestController or @Controller: ${hasController}`);
}

// Wherever interface extraction begins:
if (isFileOfInterest && node.type === 'interface_declaration') {
  const interfaceName = node.childForFieldName('name')?.text ?? '?';
  console.log(`[DIAG] RestExtractor: examining interface_declaration "${interfaceName}"`);
}
```

If your extractor's structure is `collectEndpointHosts` + `extractEndpointsFromHost`, put the interface log at the top of `collectEndpointHosts` for each interface node it visits.

**At the point where per-method mapping annotations are searched:**

```typescript
if (isFileOfInterest) {
  console.log(`[DIAG]   examining method "${methodName}"`);
  console.log(`[DIAG]     annotations found on method: ${annotationsList.map(a => a.name).join(', ')}`);
  console.log(`[DIAG]     mapping annotation matched: ${mappingAnnotation?.name ?? 'NONE'}`);
}
```

Where `annotationsList` is however the extractor enumerates the method's annotations. If it's not stored in a variable yet, just enumerate them on the fly for the log:

```typescript
if (isFileOfInterest) {
  const annos: string[] = [];
  // ... walk the method's modifiers/annotations children and push each annotation's name
  console.log(`[DIAG]   examining method "${methodName}", annotations: ${annos.join(', ')}`);
}
```

**At the final endpoint emission (or non-emission) per method:**

```typescript
if (isFileOfInterest) {
  if (endpoint) {
    console.log(`[DIAG]   emitting endpoint: ${endpoint.id}`);
  } else {
    console.log(`[DIAG]   NOT emitting (reason: no mapping annotation found on method)`);
  }
}
```

**At the end of `extract`, before the return statement:**

```typescript
if (isFileOfInterest) {
  console.log(`[DIAG] RestExtractor.extract EXITING ${filePath}: returning ${endpoints.length} endpoints`);
  for (const ep of endpoints) {
    console.log(`[DIAG]   - ${ep.id} at line ${ep.line}`);
  }
}
```

## What NOT to change

- Do not add regex-based extraction. This is diagnostic only.
- Do not modify types.
- Do not modify control flow — every log statement is a pure side effect.
- Do not modify DtoExtractor or BeanExtractor for this round. Keep the surface area small so we can read the logs.
- Do not remove existing warnings, JSDoc comments, or error handling.

## After applying

Reload the extension window (`Cmd/Ctrl+R`), run Generate on CDU, then in the debug console:

1. Look for the block `[DIAG] GeneratePipeline: files of interest ...` — this tells you how many API/Controller/interface files the walker found.
2. Search for the file you care about, e.g. `DomainAPI.java`. You should see a chain of `[DIAG]` lines for that file:
   - The GeneratePipeline "about to extract" log.
   - The RestExtractor "ENTERED" log with the four boolean flags.
   - The RestExtractor "parsed OK" log with top-level node types.
   - The examining `class_declaration` / `interface_declaration` logs.
   - The per-method examining logs.
   - The final "EXITING" log with the count of extracted endpoints.

Wherever the chain breaks off, that's where the bug is. Common patterns:

- If ENTERED log appears but no "parsed OK" → tree-sitter parse failed. The grammar might not handle something in the file.
- If "parsed OK" appears but top-level types don't include `interface_declaration` → tree-sitter is naming the node differently than expected (rare but possible in older grammar versions).
- If interface_declaration is seen but no per-method examination logs → the interface body walk is broken.
- If per-method logs appear but "mapping annotation matched: NONE" → the annotation name matching is broken (maybe fully-qualified `@org.springframework.web.bind.annotation.RequestMapping` isn't being recognized).
- If mapping annotation IS matched but "NOT emitting" → argument parsing is failing.

The console output is the truth. Paste it back and we'll know exactly what to fix.

Complete both file modifications.
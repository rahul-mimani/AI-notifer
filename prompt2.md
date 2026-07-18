Create a new file `src/llm/Prompts.ts` that centralizes the LLM prompt templates used by the extension. This module is pure — it takes structured domain data and returns fully-formed prompt strings ready to be passed to `LmClient.complete` or `LmClient.completeJson`. It performs no I/O and calls no LLM itself.

Types are defined in `src/types.ts` (currently open). `LmClient` is in `src/llm/LmClient.ts` (also open) — do not import from it, but the shape of prompts you generate must match what `LmClient` expects (plain strings).

---

## Exports

Export these from this module:

```typescript
export const PROMPT_VERSION = '1.0.0';

export function buildStoreProsePrompt(surfaceSet: SurfaceSet, repoName: string): string;
export function buildImpactNarrativePrompt(record: ImpactRecord): string;
export function buildMigrationSuggestionPrompt(record: ImpactRecord, callSiteCode: string): string;
```

That's it — no class, no default export, three named functions plus a constant.

**Imports:**

```typescript
import { SurfaceSet, ImpactRecord, RestEndpoint, BeanDefinition } from '../types';
```

---

## `PROMPT_VERSION`

A hard-coded version string. Rev this manually when prompt content changes materially — the cache uses prompt content as the key, but if you materially change what a prompt asks for, you may want to invalidate old cache entries by bumping this and including it in cache keys upstream.

```typescript
export const PROMPT_VERSION = '1.0.0';
```

---

## `buildStoreProsePrompt`

**Signature:**
```typescript
export function buildStoreProsePrompt(surfaceSet: SurfaceSet, repoName: string): string
```

**Purpose:** Generates the prompt that asks the LLM to write the human-readable prose section of `store.md`. This becomes the `<!-- BEGIN AI-PROSE -->` block content.

**Structure the returned prompt in this order:**

1. **Framing line.**
   ```
   You are documenting a Spring Boot service named ${repoName}.
   ```

2. **Extracted surface summary — compact bullets.** Enumerate the endpoints and beans in compact form. Skip DTOs (they're internal detail, not surface prose worth documenting).

   Format the endpoints as one line each:
   ```
   - ${endpoint.method} ${endpoint.path} → ${endpoint.responseType}
   ```

   For beans:
   ```
   - ${bean.name} (${bean.type}) with methods: ${methodNames.join(', ')}
   ```
   Where `methodNames` is the list of `bean.publicMethods.map(m => m.name)`. If a bean has no public methods, use `"(no public methods)"` instead of an empty list.

   Precede each list with a subheading:
   ```
   
   ENDPOINTS:
   <bullets>
   
   BEANS:
   <bullets>
   ```

   If either list is empty, still include the subheading and write `(none)` beneath it. This tells the LLM the surface was extracted and is genuinely empty, versus omitted.

3. **Instructions block.** Ask the LLM to write markdown with specific sections and constraints:

   ```
   
   Write a concise markdown document describing this service. Use exactly these sections in this order:
   
   ## Overview
   A 2-3 sentence description of what this service does, inferred from the endpoints and beans above. Do not speculate about business context beyond what the surface reveals.
   
   ## Endpoints
   One line per endpoint. Format: `- \`${method} ${path}\` — <one-line description of likely purpose>`. Base the description on the path and response type. Do not invent request/response semantics not implied by the surface.
   
   ## Beans
   One line per bean. Format: `- \`${beanName}\` — <one-line description of its role>`. If the bean has no public methods, note it as an internal collaborator.
   
   Constraints:
   - Output only the markdown content. No preamble, no explanation, no code fences around the whole thing.
   - Do not add sections beyond the three specified.
   - Do not fabricate details. If the surface is minimal, keep the prose minimal.
   - Do not include the repo name in a top-level # header. Start with `## Overview`.
   ```

**Do not use interpolated backticks inside the instructions block** in a way that would break the outer template literal — you'll need to escape them (e.g. `\`${method} ${path}\``) or use string concatenation for those specific lines.

**Example output (for reference — for a repo with 2 endpoints and 1 bean):**

```
You are documenting a Spring Boot service named CDU.

ENDPOINTS:
- GET /api/v1/customer/{id} → CustomerResponse
- POST /api/v1/customer → CustomerResponse

BEANS:
- customerService (com.example.cdu.service.CustomerService) with methods: getById, updatePhone

Write a concise markdown document describing this service. Use exactly these sections in this order:

## Overview
[...instructions as above...]
```

---

## `buildImpactNarrativePrompt`

**Signature:**
```typescript
export function buildImpactNarrativePrompt(record: ImpactRecord): string
```

**Purpose:** Generates the prompt that asks the LLM to write a 2-3 sentence narrative explaining an impact to the consumer owner. The LLM's response goes into `record.narrative`.

**Structure the returned prompt:**

1. **Framing.**
   ```
   You are writing a 2-3 sentence impact notification for a Spring Boot developer whose service consumes another service and may be affected by a change.
   ```

2. **The change — structured details.** Emit these fields in labeled form:
   ```
   
   CHANGE:
   - Kind: ${record.changeEvent.kind}
   - Surface: ${record.changeEvent.surfaceId}
   - Severity: ${record.changeEvent.severity}
   - Before: ${JSON.stringify(record.changeEvent.before)}
   - After: ${JSON.stringify(record.changeEvent.after)}
   ${record.changeEvent.riskFlags.length > 0 ? `- Risk flags: ${record.changeEvent.riskFlags.join(', ')}` : ''}
   ```

3. **The coupling and consumer's usage.**
   ```
   
   COUPLING: ${record.coupling}
   CONSUMER: ${record.consumer}
   CALL SITE: ${record.callSite.file}:${record.callSite.line}
   USED TARGET: ${record.usedTarget}
   CONFIDENCE: ${record.usedTargetConfidence ?? 'none'}
   ```

4. **The resulting status.**
   ```
   
   STATUS: ${record.status} (reasoning: ${record.reasoning.join(', ')})
   ```

5. **Instructions.**
   ```
   
   Write a 2-3 sentence notification directed at the developer of ${record.consumer}. Requirements:
   - Direct and technical. No hedging phrases like "you might want to" or "please consider".
   - State clearly WHAT changed, WHERE in their code it matters (file:line), and WHAT the effect is.
   - If the confidence is 'inferred' or 'unknown', say the impact "may" or "likely" apply rather than asserting it as fact.
   - If the confidence is 'declared', state the impact as fact.
   - No preamble, no sign-off. Plain text only. No markdown. 2-3 sentences, no more.
   ```

**Do not** include the raw JSON of the whole `ImpactRecord` in the prompt — enumerate the fields explicitly as above so the LLM doesn't get confused by shape variations.

**Do not** include the LLM's own future narrative or migration suggestion in the prompt — those fields on `record` may be undefined at prompt-building time.

---

## `buildMigrationSuggestionPrompt`

**Signature:**
```typescript
export function buildMigrationSuggestionPrompt(record: ImpactRecord, callSiteCode: string): string
```

**Purpose:** Generates the prompt that asks the LLM to suggest a concrete code change to the consumer as a unified diff. The LLM's response goes into `record.migrationSuggestion`.

The `callSiteCode` argument is provided by the caller — typically 5 lines before and 5 lines after the affected call site, read from the consumer file. The caller is responsible for gathering this; this module does not read files.

**Structure the returned prompt:**

1. **Framing.**
   ```
   You are suggesting a code change to a Spring Boot consumer service to adapt to a change in a provider service. Your output must be a unified diff patch, nothing else.
   ```

2. **The change — same block as narrative prompt.** Reuse the same labeled format:
   ```
   
   CHANGE:
   - Kind: ${record.changeEvent.kind}
   - Surface: ${record.changeEvent.surfaceId}
   - Before: ${JSON.stringify(record.changeEvent.before)}
   - After: ${JSON.stringify(record.changeEvent.after)}
   ```

3. **The call site code.** Wrap in a fence so the LLM knows exactly what code to modify:
   ```
   
   CALL SITE (${record.callSite.file}:${record.callSite.line}):
   \`\`\`java
   ${callSiteCode}
   \`\`\`
   ```

4. **Instructions.**
   ```
   
   Suggest the minimum code change to adapt this call site to the provider change. Requirements:
   - Output a unified diff patch in standard format: `--- a/${filepath}`, `+++ b/${filepath}`, `@@ ... @@` hunk headers, `-` lines for removals, `+` lines for additions, unchanged context lines starting with a single space.
   - Use the file path `${record.callSite.file}` in the `---` and `+++` headers.
   - Only modify the call site region shown. Do not invent code changes elsewhere.
   - If the change is a field removal and the consumer reads a now-missing field, suggest either removing the read or adapting to the new provider shape.
   - If the change is a method signature change, adapt the arguments accordingly.
   - Output ONLY the diff. No preamble, no explanation, no code fences around the whole diff (the diff itself uses --- and +++ lines, which is standard).
   ```

**Handling the diff header path:** be aware that `record.callSite.file` may be relative or absolute depending on how the caller populated it. Emit it verbatim — the caller is responsible for path normalization if needed.

---

## Style constraints for all three functions

Every prompt built by this module must follow these rules — they exist to keep LLM output predictable across cache runs and demo dry runs:

- **Deterministic content.** No timestamps, no random IDs, no environment-dependent values. Two invocations with identical inputs must produce identical prompts (this is what makes cache keys stable).
- **No conversational tone in prompts.** Avoid "please", "could you", "would you mind". Direct instructions only.
- **Explicit output format.** Every prompt ends with a clear instruction about output format (plain text, markdown, or diff). Never leave the format ambiguous.
- **Explicit anti-preamble.** Every prompt includes "no preamble" or "no explanation" as instructions. LLMs love to say "Sure, here's the notification:" and this must be suppressed.

---

## Do not

- Do not import from `LmClient` or call any LLM function. This module builds strings.
- Do not read any files. `callSiteCode` is provided as an argument for the migration prompt.
- Do not mutate the input arguments.
- Do not throw. If a field is missing on `record` (should not happen with well-typed input, but defensive), substitute a sensible default like `"(unknown)"` and continue.
- Do not include the `PROMPT_VERSION` constant in the prompt bodies. It's for cache invalidation, not model context.
- Do not use different JSON serialization for `before`/`after` — always `JSON.stringify` with no indent (single-line).
- Do not include any dynamic date, time, or random information in the prompt output.

---

## Skeleton

```typescript
import { SurfaceSet, ImpactRecord, RestEndpoint, BeanDefinition } from '../types';

export const PROMPT_VERSION = '1.0.0';

export function buildStoreProsePrompt(surfaceSet: SurfaceSet, repoName: string): string {
  // ... assemble per spec above
}

export function buildImpactNarrativePrompt(record: ImpactRecord): string {
  // ... assemble per spec above
}

export function buildMigrationSuggestionPrompt(record: ImpactRecord, callSiteCode: string): string {
  // ... assemble per spec above
}
```

Fill in each function per the specifications. Use small local helpers if it improves readability (e.g. a `formatEndpointBullet(endpoint: RestEndpoint): string` helper). Keep them non-exported.

Add JSDoc comments on each exported function explaining what LLM task it drives and what field of the domain object the LLM's response is destined for.

Complete the file.
Create a new file `src/llm/LmClient.ts` that wraps the VS Code Language Model API (`vscode.lm`) for GitHub Copilot's chat models. This is the single point where the extension talks to an LLM. Every LLM call in the rest of the codebase — for `store.md` prose, impact narratives, migration suggestions, cache lookups — goes through this client.

Types are defined in `src/types.ts` (currently open). The correct `vscode.lm` API shape is demonstrated in `src/extension.ts` (also open) — the smoke test command uses exactly the API surface you must replicate here.

---

## Critical: correct `vscode.lm` API shape — do not deviate

The correct API for calling a Copilot chat model in VS Code is exactly:

```typescript
// 1. Select a model
const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
if (models.length === 0) throw new Error('No Copilot chat model available');
const model = models[0];

// 2. Build a message
const message = vscode.LanguageModelChatMessage.User(promptText);

// 3. Send request with a cancellation token
const cts = new vscode.CancellationTokenSource();
const request = await model.sendRequest([message], {}, cts.token);

// 4. Stream response chunks
let response = '';
for await (const chunk of request.text) {
  response += chunk;  // chunk is a string
}
```

**Do NOT invent any of these:**

- `model.chat(...)` — does not exist.
- `model.complete(...)` — does not exist.
- `openai.*`, `anthropic.*` — wrong SDK entirely, this is not the pattern.
- `.chat.completions.create(...)` — this is the OpenAI SDK shape, not vscode.lm.
- `sendMessage(...)` — wrong name.
- `LanguageModelChatMessage.system(...)` in current stable API — use `.User()` only for v1 of this file.
- Streaming via `.on('data', ...)` — the API is an async iterator, not an event emitter.

If your first attempt at any method uses one of the above, stop and look at `src/extension.ts` for the exact pattern. That file already works — replicate its usage.

---

## Class shape

Export a class `LmClient` with the following public surface:

```typescript
export class LmClient {
  async initialize(): Promise<void>;
  async complete(prompt: string, options?: LmCompleteOptions): Promise<string>;
  async completeJson<T>(prompt: string, options?: LmCompleteOptions): Promise<T>;
  getCachePath(): string;
  async preBake(entries: PreBakeEntry[]): Promise<void>;
  static async loadPreBakedCache(bundlePath: string): Promise<void>;
}
```

Also export these supporting types in the same file:

```typescript
export interface LmCompleteOptions {
  cacheKey?: string;
  timeoutMs?: number;  // defaults to 30000
}

export interface PreBakeEntry {
  cacheKey: string;
  response: string;
}
```

**Private state:**

```typescript
private model: vscode.LanguageModelChat | null = null;
```

**Imports:**

```typescript
import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
```

Note: no imports from other project files. This module has no domain dependencies.

---

## Method: `initialize`

```typescript
async initialize(): Promise<void>
```

Behavior:
1. Call `vscode.lm.selectChatModels({ vendor: 'copilot' })`.
2. If the returned array is empty, throw:
   ```typescript
   throw new Error(
     'No Copilot chat model available. Install/sign in to GitHub Copilot and try again.'
   );
   ```
3. Store `models[0]` on `this.model`.
4. If `this.model` is already set (initialize called twice), return early without re-selecting.

This method is called once per extension session, typically from `extension.ts` `activate` (lazily, on first LLM use).

---

## Method: `complete`

```typescript
async complete(prompt: string, options?: LmCompleteOptions): Promise<string>
```

Behavior:

**Step 1 — cache lookup.**

If `options?.cacheKey` is provided:
- Compute cache path: `path.join(this.getCachePath(), `${options.cacheKey}.txt`)`.
- Try to read the file. If it exists, return its contents verbatim (do not call the LLM).
- If it doesn't exist, continue to Step 2. Do not treat missing cache as an error.

**Step 2 — ensure model is initialized.**

If `this.model === null`, call `await this.initialize()`. If that throws, propagate.

**Step 3 — call the LLM with a timeout.**

Build the message and send the request:
```typescript
const message = vscode.LanguageModelChatMessage.User(prompt);
const cts = new vscode.CancellationTokenSource();
const request = await this.model!.sendRequest([message], {}, cts.token);
```

Race the streaming against a timeout:
```typescript
const timeoutMs = options?.timeoutMs ?? 30000;
const timeoutPromise = new Promise<never>((_, reject) => {
  setTimeout(() => {
    cts.cancel();
    reject(new Error(`LLM request timed out after ${timeoutMs}ms`));
  }, timeoutMs);
});

const streamPromise = (async () => {
  let response = '';
  for await (const chunk of request.text) {
    response += chunk;
  }
  return response;
})();

const response = await Promise.race([streamPromise, timeoutPromise]);
```

The `cts.cancel()` in the timeout path attempts to signal the underlying LLM call to abort.

**Step 4 — cache write-back.**

If `options?.cacheKey` was provided and the call succeeded:
- Ensure the cache directory exists: `await fs.mkdir(this.getCachePath(), { recursive: true });`
- Write the response: `await fs.writeFile(cachePath, response, 'utf-8');`
- Do not fail the overall call if the write fails — log via `console.warn` and return the response anyway.

**Step 5 — return.**

Return the response string as-is (no trimming, no processing).

**Error handling for `complete`:**

- Timeout → the `Promise.race` throws the timeout error, which propagates to the caller.
- LLM errors (Copilot returned an error, network issue) → let them propagate. The caller (typically a pipeline) is responsible for deciding whether to degrade gracefully.
- Cache read errors (permission denied, etc, other than ENOENT) → log warning, treat as cache miss, continue to LLM call.
- Cache write errors → log warning, still return the response.

---

## Method: `completeJson<T>`

```typescript
async completeJson<T>(prompt: string, options?: LmCompleteOptions): Promise<T>
```

Wraps `complete` for callers that need structured output.

Behavior:

**Step 1 — augment prompt.**

Append this exact suffix to the prompt:
```
\n\nRespond with ONLY valid JSON. No markdown code fences, no prose, no preamble.
```

Call `complete(augmentedPrompt, options)`.

**Step 2 — strip accidental code fences.**

The LLM may still wrap its response in ```` ```json ```` fences despite instructions. Strip them:
- If the response trimmed starts with ```` ```json ```` or ```` ``` ````, remove the opening fence line.
- If it ends with ```` ``` ````, remove the closing fence line.
- Use a robust regex or line-by-line strip — the response might have trailing whitespace or newlines around the fences.

**Step 3 — parse JSON.**

Try `JSON.parse(cleanedResponse)`. Return as `T`.

**Step 4 — retry once on parse failure.**

If `JSON.parse` throws:
- Log warning: `console.warn('LmClient.completeJson: first attempt returned invalid JSON, retrying');`
- Build a retry prompt by appending to the ORIGINAL prompt (not the augmented one, to avoid compounding suffixes):
  ```
  \n\nYour previous response was invalid JSON. Respond with ONLY the JSON object, no fences, no prose. Just the object, starting with { and ending with }.
  ```
- Call `complete(retryPrompt, options)` — note: bypass the cache on retry by passing `{ ...options, cacheKey: undefined }` so the retry actually re-queries the LLM.
- Strip fences again.
- `JSON.parse` again. If this throws too, throw an error with a message including both the raw response and the parse error:
  ```typescript
  throw new Error(
    `LmClient.completeJson: failed to parse JSON after retry. ` +
    `Raw response: ${cleanedResponse.substring(0, 500)}. ` +
    `Parse error: ${(err as Error).message}`
  );
  ```

---

## Method: `getCachePath`

```typescript
getCachePath(): string
```

Returns the absolute path to the extension's cache directory:

```typescript
return path.join(os.homedir(), '.ai-change-impact-notifier', 'cache');
```

Synchronous. Does not create the directory — that's the caller's responsibility (or handled inside `complete`).

---

## Method: `preBake`

```typescript
async preBake(entries: PreBakeEntry[]): Promise<void>
```

Writes cache entries in bulk. Used by `loadPreBakedCache` and can also be called directly.

Behavior:
1. Ensure cache dir exists: `await fs.mkdir(this.getCachePath(), { recursive: true });`
2. For each entry, write `${cachePath}/${entry.cacheKey}.txt` with `entry.response` as content.
3. If any individual write fails, log a warning with the specific cacheKey and continue with the next. Do not abort the whole operation.

---

## Static method: `loadPreBakedCache`

```typescript
static async loadPreBakedCache(bundlePath: string): Promise<void>
```

Loads a bundled cache from a JSON file. Used at extension startup to seed the cache with pre-computed LLM responses for demo reliability.

Behavior:
1. Read the JSON file at `bundlePath`. On ENOENT, silently return (no bundle present is normal, not an error).
2. Parse as `PreBakeEntry[]`. If parse fails, log warning and return.
3. Validate: must be an array. Each entry must have `cacheKey: string` and `response: string`. Skip invalid entries with a warning.
4. Create a temporary `LmClient` instance just to reuse `preBake`:
   ```typescript
   const client = new LmClient();
   await client.preBake(validEntries);
   ```
5. Log a summary: `console.log(\`LmClient: loaded ${validEntries.length} pre-baked cache entries from ${bundlePath}\`);`

Does not throw. All failures are logged and swallowed — the extension should function normally without a bundled cache.

---

## Utility: computing cache keys from prompts (optional helper)

Since callers often want to derive a stable cache key from the prompt content itself, add a static helper:

```typescript
static hashPrompt(prompt: string): string {
  return crypto.createHash('sha256').update(prompt).digest('hex').substring(0, 16);
}
```

Callers can use this to generate cache keys like `narrative-${LmClient.hashPrompt(prompt)}`.

---

## Do not

- Do not use `require(...)` — use ES imports.
- Do not use the OpenAI SDK, Anthropic SDK, or any other LLM library.
- Do not implement retry logic beyond the single JSON-parse retry described. Network retries are the LLM provider's job.
- Do not attempt to detect model capabilities or filter by model name — `selectChatModels({ vendor: 'copilot' })` is enough for v1.
- Do not add rate limiting.
- Do not cache in-memory across calls beyond what the filesystem cache provides.
- Do not throw from `loadPreBakedCache` — it must be safe to call unconditionally at startup.
- Do not import from `../types` or any other project file.
- Do not use `System` or `Assistant` messages in v1 — only `.User(prompt)`.

---

## Skeleton to fill in

```typescript
import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

export interface LmCompleteOptions {
  cacheKey?: string;
  timeoutMs?: number;
}

export interface PreBakeEntry {
  cacheKey: string;
  response: string;
}

export class LmClient {
  private model: vscode.LanguageModelChat | null = null;

  async initialize(): Promise<void> {
    // ... per spec above
  }

  async complete(prompt: string, options?: LmCompleteOptions): Promise<string> {
    // ... per spec above (cache lookup → init → LLM call with timeout → cache write → return)
  }

  async completeJson<T>(prompt: string, options?: LmCompleteOptions): Promise<T> {
    // ... per spec above (augment prompt → complete → strip fences → parse → retry once on failure)
  }

  getCachePath(): string {
    return path.join(os.homedir(), '.ai-change-impact-notifier', 'cache');
  }

  async preBake(entries: PreBakeEntry[]): Promise<void> {
    // ... per spec above
  }

  static async loadPreBakedCache(bundlePath: string): Promise<void> {
    // ... per spec above
  }

  static hashPrompt(prompt: string): string {
    return crypto.createHash('sha256').update(prompt).digest('hex').substring(0, 16);
  }
}
```

Fill in each method body per the specifications above. Preserve the exact API shape shown in the "Critical" section for the `vscode.lm` calls — do not invent alternatives. Add JSDoc comments on each public method explaining its behavior in 2-3 lines. Complete the file.
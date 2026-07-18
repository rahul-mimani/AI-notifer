Create a new file `src/pipeline/GeneratePipeline.ts` that orchestrates the "Generate store.md" command's full flow: walk the workspace, run all extractors, get the git commit, call the LLM for prose, and write the manifest via `StoreWriter`. Also update `src/extension.ts` to register the command and wire it to this pipeline.

Types are defined in `src/types.ts` (currently open). Parsers are in `src/parser/*.ts` (open). Store I/O is in `src/store/StoreWriter.ts` and `src/store/StoreReader.ts` (open). LLM client is in `src/llm/LmClient.ts` (open). Prompt builders are in `src/llm/Prompts.ts` (open). Extension entry is `src/extension.ts` (open).

---

## Part 1 — Create `src/pipeline/GeneratePipeline.ts`

**Exports:**

```typescript
export interface GenerateOptions {
  force?: boolean;
}

export interface GenerateResult {
  storeMdPath: string;
  surfaceCounts: {
    endpoints: number;
    dtos: number;
    beans: number;
    httpCalls: number;
    beanInjections: number;
  };
}

export async function runGenerate(
  workspaceRoot: string,
  lmClient: LmClient,
  wasmPath: string,
  options?: GenerateOptions
): Promise<GenerateResult>;
```

No class needed — this is a single async function.

**Imports:**

```typescript
import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Parser, Language } from 'web-tree-sitter';
import {
  StoreManifest,
  SurfaceSet,
  RestEndpoint,
  DtoType,
  BeanDefinition,
  HttpCallSite,
  BeanInjection,
} from '../types';
import { RestExtractor } from '../parser/RestExtractor';
import { DtoExtractor } from '../parser/DtoExtractor';
import { BeanExtractor } from '../parser/BeanExtractor';
import { HttpCallSiteExtractor } from '../parser/HttpCallSiteExtractor';
import { StoreWriter } from '../store/StoreWriter';
import { StoreReader } from '../store/StoreReader';
import { LmClient } from '../llm/LmClient';
import { buildStoreProsePrompt } from '../llm/Prompts';

const execFileAsync = promisify(execFile);
```

---

### `runGenerate` — steps in order

**Step 1 — Initialize tree-sitter and load Java language.**

```typescript
await Parser.init();
const javaLang = await Language.load(wasmPath);
const parser = new Parser();
parser.setLanguage(javaLang);
```

If `Parser.init()` throws or `Language.load` throws, log the error and rethrow with a clearer message like `"Failed to initialize tree-sitter Java parser: <original error>. Check that resources/tree-sitter-java.wasm exists."` The caller (extension.ts) will surface this to the user.

**Step 2 — Discover Java source files.**

Walk `${workspaceRoot}/src/main/java` recursively for files ending in `.java`. If `src/main/java` doesn't exist, fall back to walking `${workspaceRoot}` entirely and filter for `.java` files, but skip:
- Any path segment named `test`, `tests`, `target`, `build`, `.git`, `node_modules`, or `.idea`.
- Files under any directory whose name starts with `.`.

Implement as a private async function:

```typescript
async function walkJavaFiles(root: string): Promise<string[]>
```

Use `fs.readdir(dir, { withFileTypes: true })` and recurse into directories. Return absolute paths.

If no `.java` files are found, do NOT throw — proceed with an empty `SurfaceSet`. The manifest will still be written, just with empty arrays. This is valid: a repo with no Java code produces an empty surface.

**Step 3 — Instantiate extractors.**

```typescript
const restExtractor = new RestExtractor(parser);
const dtoExtractor = new DtoExtractor(parser);
const beanExtractor = new BeanExtractor(parser);
const httpExtractor = new HttpCallSiteExtractor(parser);
```

**Step 4 — Run extractors on each file, accumulate into a SurfaceSet.**

```typescript
const surface: SurfaceSet = {
  provides: { endpoints: [], dtos: [], beans: [] },
  consumes: { httpCalls: [], beanInjections: [] },
};
```

For each file path:
- Read file content: `const src = await fs.readFile(filePath, 'utf-8');`
- Compute a repo-relative path for storage in the manifest: `path.relative(workspaceRoot, filePath)`. Use this as the `file` field passed to extractors — do not pass absolute paths (they'd leak local user directories into the manifest).
- Run each extractor. Wrap each call in a try/catch so one bad file doesn't abort the whole walk:
  ```typescript
  try {
    surface.provides.endpoints.push(...restExtractor.extract(src, relPath));
    surface.provides.dtos.push(...dtoExtractor.extract(src, relPath));
    surface.provides.beans.push(...beanExtractor.extractProviders(src, relPath));
    surface.consumes.httpCalls.push(...httpExtractor.extract(src, relPath));
    surface.consumes.beanInjections.push(...beanExtractor.extractInjections(src, relPath));
  } catch (err) {
    console.warn(`GeneratePipeline: extractor failed on ${relPath}: ${(err as Error).message}`);
  }
  ```

**Step 5 — Get the current git commit.**

```typescript
let currentCommit: string;
try {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: workspaceRoot });
  currentCommit = stdout.trim();
} catch (err) {
  console.warn(`GeneratePipeline: git rev-parse failed: ${(err as Error).message}. Using placeholder commit.`);
  currentCommit = 'unknown';
}
```

Do NOT fail the whole generate flow if git isn't available. Falling back to `"unknown"` is acceptable — the FreshnessChecker later will treat this as a missing commit and flag consumers accordingly.

**Step 6 — Read existing store.md prose for preservation.**

```typescript
const reader = new StoreReader();
const existing = await reader.read(workspaceRoot);
const existingProse = existing.prose;  // may be null if no existing file
```

We only need the prose. The existing manifest content is discarded — we're regenerating it.

**Step 7 — Call the LLM to generate new prose.**

The prompt is built from the surface set:

```typescript
const repoName = path.basename(workspaceRoot);
const prosePrompt = buildStoreProsePrompt(surface, repoName);
```

Compute a cache key so pre-baked runs work:

```typescript
const cacheKey = `prose-${repoName}-${LmClient.hashPrompt(prosePrompt)}`;
```

Then call the LLM with the cache key. On failure, fall back to existing prose or a placeholder:

```typescript
let prose: string;
try {
  prose = await lmClient.complete(prosePrompt, { cacheKey });
} catch (err) {
  console.warn(`GeneratePipeline: LLM call for prose failed: ${(err as Error).message}. Falling back.`);
  prose = existingProse ?? '_(No description available — LLM call failed. Retry with the Generate command.)_';
}
```

**Step 8 — Build the StoreManifest.**

```typescript
const manifest: StoreManifest = {
  schemaVersion: 1,
  repo: repoName,
  generatedAt: new Date().toISOString(),
  generatedFromCommit: currentCommit,
  provides: surface.provides,
  consumes: surface.consumes,
};
```

**Step 9 — Write the manifest via StoreWriter.**

```typescript
const writer = new StoreWriter();
await writer.write(manifest, prose, workspaceRoot, { force: options?.force });
```

If `StoreWriter.write` throws `StoreMdHasUncommittedChanges`, propagate as-is. The caller in extension.ts will catch it and prompt the user for confirmation.

**Step 10 — Return the result.**

```typescript
return {
  storeMdPath: path.join(workspaceRoot, 'store.md'),
  surfaceCounts: {
    endpoints: surface.provides.endpoints.length,
    dtos: surface.provides.dtos.length,
    beans: surface.provides.beans.length,
    httpCalls: surface.consumes.httpCalls.length,
    beanInjections: surface.consumes.beanInjections.length,
  },
};
```

---

## Part 2 — Update `src/extension.ts`

The existing `src/extension.ts` currently has only the smoke-test command (and possibly the temporary `testLmClient` command from Prompt 13's verification step). Preserve those and add:

1. A shared `LmClient` instance, lazily initialized on first use.
2. A registration for a new command `ai-change-impact-notifier.generate`.

**Add these imports at the top:**

```typescript
import * as path from 'path';
import { LmClient } from './llm/LmClient';
import { runGenerate } from './pipeline/GeneratePipeline';
```

**Inside `activate`, add a shared LmClient managed lazily:**

```typescript
let lmClient: LmClient | null = null;

async function getLmClient(): Promise<LmClient> {
  if (lmClient === null) {
    lmClient = new LmClient();
    await lmClient.initialize();
  }
  return lmClient;
}
```

This ensures we don't force the user to have Copilot available at extension load time — only when they actually run a command that uses it.

**Register the generate command:**

```typescript
const generateCmd = vscode.commands.registerCommand('ai-change-impact-notifier.generate', async () => {
  // 1. Pick workspace folder
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage('AI Impact: Please open a workspace folder first.');
    return;
  }

  let targetFolder: vscode.WorkspaceFolder;
  if (folders.length === 1) {
    targetFolder = folders[0];
  } else {
    const picked = await vscode.window.showQuickPick(
      folders.map((f) => ({ label: f.name, folder: f })),
      { placeHolder: 'Select the repo to generate store.md for' }
    );
    if (!picked) return;
    targetFolder = picked.folder;
  }

  const workspaceRoot = targetFolder.uri.fsPath;
  const wasmPath = path.join(context.extensionPath, 'resources', 'tree-sitter-java.wasm');

  // 2. Progress notification and execution
  try {
    const client = await getLmClient();

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `AI Impact: Generating store.md for ${targetFolder.name}`,
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: 'Extracting surface...' });
        try {
          const result = await runGenerate(workspaceRoot, client, wasmPath);
          progress.report({ message: 'Done.' });
          vscode.window.showInformationMessage(
            `store.md written to ${result.storeMdPath}. ` +
            `Surface: ${result.surfaceCounts.endpoints} endpoints, ` +
            `${result.surfaceCounts.dtos} DTOs, ` +
            `${result.surfaceCounts.beans} beans, ` +
            `${result.surfaceCounts.httpCalls} HTTP calls, ` +
            `${result.surfaceCounts.beanInjections} bean injections.`
          );
        } catch (err: any) {
          if (err.name === 'StoreMdHasUncommittedChanges') {
            const choice = await vscode.window.showWarningMessage(
              `store.md has uncommitted changes. Overwrite?`,
              { modal: true },
              'Overwrite',
              'Cancel'
            );
            if (choice === 'Overwrite') {
              progress.report({ message: 'Overwriting...' });
              const result = await runGenerate(workspaceRoot, client, wasmPath, { force: true });
              vscode.window.showInformationMessage(
                `store.md overwritten at ${result.storeMdPath}.`
              );
            }
          } else {
            throw err;
          }
        }
      }
    );
  } catch (err: any) {
    vscode.window.showErrorMessage(`AI Impact: Generate failed: ${err.message}`);
    console.error(err);
  }
});

context.subscriptions.push(generateCmd);
```

---

## Part 3 — Update `package.json`

Add the new command to `contributes.commands`. Preserve existing entries (smoke test, testLmClient if still present):

```json
{
  "command": "ai-change-impact-notifier.generate",
  "title": "AI Impact: Generate store.md"
}
```

Also add to `activationEvents`:

```json
"onCommand:ai-change-impact-notifier.generate"
```

Do NOT remove existing commands or activation events. Preserve the smoke-test and (if present) testLmClient registrations.

---

## Error handling philosophy for this prompt

- Extractor failures on individual files are non-fatal (log and continue).
- Missing `src/main/java` is non-fatal (fall back to full workspace walk).
- Git errors are non-fatal (fall back to `"unknown"` commit).
- LLM errors are non-fatal (fall back to existing prose or placeholder).
- `StoreMdHasUncommittedChanges` is the ONE case that should propagate — the caller handles it with a confirmation prompt.
- Any other unexpected error propagates and is caught at the command's outer try/catch, surfaced via `showErrorMessage`.

---

## Do not

- Do not require `@types/web-tree-sitter` — use the runtime types the package provides via its own `.d.ts`.
- Do not use `path.relative` with backslash-normalizing logic — the extension may run on Windows. Trust `path.relative` and `path.join` to handle separators correctly.
- Do not use `context.extensionUri.fsPath` — use `context.extensionPath` (a string) for `path.join` compatibility.
- Do not call `runGenerate` at extension activation time. It only runs when the user explicitly invokes the command.
- Do not add configuration schema for the command — no user-facing config in v1.
- Do not persist the LmClient across VS Code sessions (the `lmClient` variable resets on reload — that's fine).
- Do not walk `node_modules` or `target` even if `src/main/java` fallback is triggered.
- Do not include prose in the output beyond what the LLM returns.
- Do not modify the workspace beyond writing `store.md` (no auto-commit, no auto-format).

Complete both files. Write clean, focused code. Add JSDoc comments on `runGenerate` and on the command handler explaining the flow.
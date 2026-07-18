Create a new file `src/pipeline/AnalyzePipeline.ts` that orchestrates the "Analyze impact" command's full flow: extract the provider surface at the working tree and at the git base, diff them into ChangeEvents, correlate against each consumer's store.md, score severity, generate LLM narratives and migration suggestions, and assemble an ImpactReport. Also update `src/extension.ts` to register the command.

Types are defined in `src/types.ts` (currently open). The generate pipeline in `src/pipeline/GeneratePipeline.ts` (open) already implements working-tree extraction — reuse its patterns. Store I/O, diff, matcher, scorer, freshness, LLM client, and prompts are all open.

---

## Part 1 — Create `src/pipeline/AnalyzePipeline.ts`

**Exports:**

```typescript
export interface AnalyzeOptions {
  refreshConsumerManifests?: boolean;  // reserved for future — ignored in v1
}

export async function runAnalyze(
  providerRoot: string,
  consumerRoots: string[],
  lmClient: LmClient,
  wasmPath: string,
  options?: AnalyzeOptions
): Promise<ImpactReport>;
```

No class needed — this is a single async function orchestrating the analyze flow.

**Imports:**

```typescript
import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as crypto from 'crypto';
import { Parser, Language } from 'web-tree-sitter';
import {
  ImpactReport,
  ImpactRecord,
  ChangeEvent,
  ConsumerImpact,
  SurfaceSet,
  StoreManifest,
  UsedField,
  CalledMethod,
  HttpCallSite,
  BeanInjection,
} from '../types';
import { RestExtractor } from '../parser/RestExtractor';
import { DtoExtractor } from '../parser/DtoExtractor';
import { BeanExtractor } from '../parser/BeanExtractor';
import { HttpCallSiteExtractor } from '../parser/HttpCallSiteExtractor';
import { StoreReader } from '../store/StoreReader';
import { DiffEngine } from '../diff/DiffEngine';
import { Matcher } from '../matcher/Matcher';
import { SeverityScorer } from '../severity/SeverityScorer';
import { FreshnessChecker } from '../freshness/FreshnessChecker';
import { LmClient } from '../llm/LmClient';
import { buildImpactNarrativePrompt, buildMigrationSuggestionPrompt } from '../llm/Prompts';

const execFileAsync = promisify(execFile);
```

---

## `runAnalyze` — steps in order

### Step 1 — Initialize tree-sitter

Same as GeneratePipeline:

```typescript
await Parser.init();
const javaLang = await Language.load(wasmPath);
const parser = new Parser();
parser.setLanguage(javaLang);
```

Wrap in a try/catch that rethrows with a clearer message on failure.

### Step 2 — Determine the base ref

Decide what to diff against:

- If the working tree has uncommitted changes to any `.java` file: compare **working tree vs HEAD**. Base is `"HEAD"`, head is `"working-tree"`.
- Else: compare **HEAD vs HEAD~1**. Base is `"HEAD~1"`, head is `"HEAD"`.

Detect via `git diff --name-only HEAD -- "*.java"` in `providerRoot`:

```typescript
let baseRef: string;
let headRef: string;
try {
  const { stdout } = await execFileAsync(
    'git',
    ['diff', '--name-only', 'HEAD', '--', '*.java'],
    { cwd: providerRoot }
  );
  const hasUncommittedJava = stdout.trim().length > 0;
  if (hasUncommittedJava) {
    baseRef = 'HEAD';
    headRef = 'working-tree';
  } else {
    baseRef = 'HEAD~1';
    headRef = 'HEAD';
  }
} catch (err) {
  console.warn(`AnalyzePipeline: git diff detection failed: ${(err as Error).message}. Falling back to HEAD~1 vs HEAD.`);
  baseRef = 'HEAD~1';
  headRef = 'HEAD';
}
```

### Step 3 — Extract the "after" (head) surface

If `headRef === 'working-tree'`, walk the filesystem and read files with `fs.readFile` — the same logic as GeneratePipeline. Reuse or duplicate the `walkJavaFiles` helper.

If `headRef === 'HEAD'`, extract from git at HEAD (see Step 4 algorithm below, using `HEAD` as the ref).

Store as `afterSurface: SurfaceSet`.

### Step 4 — Extract the "before" (base) surface

**This is the trickiest step. Read carefully.**

You need to extract the SurfaceSet from a historical git state (`baseRef`) without mutating the working tree. Do NOT use `git checkout` — that would trash the user's uncommitted work. Use `git show <ref>:<path>` to read historical file contents into memory.

Algorithm:

1. List all `.java` files present at `baseRef`:
   ```typescript
   const { stdout: fileList } = await execFileAsync(
     'git',
     ['ls-tree', '-r', '--name-only', baseRef, '--', '*.java'],
     { cwd: providerRoot }
   );
   const baseFiles = fileList.split('\n').map((l) => l.trim()).filter((l) => l.endsWith('.java'));
   ```

2. Apply the same skip filter as GeneratePipeline (exclude paths containing `test`, `tests`, `target`, `build`, etc.).

3. For each file, get its contents at `baseRef`:
   ```typescript
   const { stdout: fileContent } = await execFileAsync(
     'git',
     ['show', `${baseRef}:${relPath}`],
     { cwd: providerRoot, maxBuffer: 10 * 1024 * 1024 }  // 10MB buffer for large files
   );
   ```
   If this fails (file didn't exist at that ref, or ref is invalid), log a warning and skip that file. Do not abort the whole extraction.

4. Feed `fileContent` and `relPath` into each extractor exactly like GeneratePipeline does. Accumulate into `beforeSurface: SurfaceSet`.

Extract this into a private async function since it's substantial:

```typescript
async function extractSurfaceAtRef(
  providerRoot: string,
  ref: string,
  parser: Parser
): Promise<SurfaceSet>
```

And handle the special case: if `ref === 'working-tree'`, call an equivalent working-tree extractor that uses `fs.readFile` instead of `git show`. Consider unifying with a variant that takes a "read file contents" function as an argument to avoid duplication:

```typescript
type FileReader = (relPath: string) => Promise<string | null>;  // null = skip this file
async function extractSurfaceWithReader(
  files: string[],
  parser: Parser,
  workspaceRoot: string,
  readFile: FileReader
): Promise<SurfaceSet>
```

Then Step 3 and Step 4 both call this helper with different readers.

**Handle the case `baseRef = HEAD~1` not existing:** if the repo has only one commit, `HEAD~1` doesn't resolve. On that failure, treat the before-surface as an empty SurfaceSet (every current surface is "added"). Log a note:
```typescript
console.warn(`AnalyzePipeline: base ref ${baseRef} does not exist (probably a fresh repo). Treating before-surface as empty.`);
```

### Step 5 — Run the diff engine

```typescript
const diffEngine = new DiffEngine();
const changes = diffEngine.diff(beforeSurface, afterSurface);
```

### Step 6 — Compute Level 1 output

Level 1 is the producer-side view: all ChangeEvents plus a naive risk score.

```typescript
let riskScore = 0;
for (const c of changes) {
  if (c.severity === 'breaking') riskScore += 10;
  else if (c.severity === 'potentially_breaking') riskScore += 3;
}
riskScore = Math.min(100, riskScore);
```

Level 1 does NOT call the LLM for narratives — the producer author already knows what they changed. The narratives are per-consumer (Level 2 only). This keeps Level 1 fast and Level 2 relevant.

### Step 7 — For each consumer, correlate and score

Prepare shared instances:

```typescript
const reader = new StoreReader();
const matcher = new Matcher();
const scorer = new SeverityScorer();
const freshnessChecker = new FreshnessChecker();
```

Initialize counters:

```typescript
let consumersScanned = 0;
let consumersUnreadable = 0;
const consumerImpacts: ConsumerImpact[] = [];
```

For each `consumerRoot` in `consumerRoots`:

**7a — Read the manifest.**

```typescript
consumersScanned++;
const readResult = await reader.read(consumerRoot);
if (readResult.manifest === null) {
  consumersUnreadable++;
  console.warn(`AnalyzePipeline: consumer ${consumerRoot} has no readable manifest: ${readResult.error}`);
  continue;
}
const manifest = readResult.manifest;
```

**7b — Check freshness.**

```typescript
const freshness = await freshnessChecker.check(
  consumerRoot,
  manifest.generatedFromCommit,
  manifest.generatedAt
);
```

**7c — Run matchers.**

```typescript
const httpMatches = matcher.matchHttp(changes, manifest);
const beanMatches = matcher.matchBean(changes, manifest);
```

**7d — Score and build ImpactRecords.**

For each `httpMatch`:
- Extract `usedTargetConfidence` from `httpMatch.usedField?.confidence ?? null`.
- Extract `usedTarget` from `httpMatch.usedField?.path ?? httpMatch.callSite.method + ' ' + httpMatch.callSite.path`.
- Score:
  ```typescript
  const scoreResult = scorer.score({
    change: httpMatch.change,
    coupling: 'http',
    usedTargetConfidence,
  });
  ```
- Skip records where `scoreResult.status === 'safe'` and `usedTargetConfidence === null` — they add noise. But KEEP `safe` records where the change was matched but ruled safe by another rule (e.g. additive changes on matched surfaces).
  - Concrete rule: skip only when `scoreResult.reasoning[0] === 'consumer_does_not_use_this_surface'`.
- Build the ImpactRecord:
  ```typescript
  const record: ImpactRecord = {
    recordId: crypto.randomUUID(),
    consumer: manifest.repo,
    changeEvent: httpMatch.change,
    coupling: 'http',
    callSite: { file: httpMatch.callSite.file, line: httpMatch.callSite.line },
    usedTarget,
    usedTargetConfidence,
    status: scoreResult.status,
    reasoning: scoreResult.reasoning,
    manifestFreshness: freshness,
  };
  ```

For each `beanMatch`:
- Similar shape. `usedTargetConfidence` from `beanMatch.calledMethod?.confidence ?? null`.
- `usedTarget` from `beanMatch.calledMethod?.signature ?? beanMatch.injection.providerType`.
- `coupling: 'bean'`, `callSite` from `beanMatch.injection`.

**7e — Generate LLM narratives and migration suggestions.**

For each record with `status === 'breaking'` or `status === 'review_recommended'`:

Generate narrative:
```typescript
const narrativePrompt = buildImpactNarrativePrompt(record);
const narrativeCacheKey = `narrative-${LmClient.hashPrompt(narrativePrompt)}`;
try {
  record.narrative = await lmClient.complete(narrativePrompt, { cacheKey: narrativeCacheKey });
} catch (err) {
  console.warn(`AnalyzePipeline: narrative LLM failed for ${record.recordId}: ${(err as Error).message}`);
  record.narrative = undefined;
}
```

Generate migration suggestion (breaking only, not review_recommended — to bound LLM cost):
```typescript
if (record.status === 'breaking') {
  const callSiteCode = await readCallSiteContext(consumerRoot, record.callSite.file, record.callSite.line);
  const migrationPrompt = buildMigrationSuggestionPrompt(record, callSiteCode);
  const migrationCacheKey = `migration-${LmClient.hashPrompt(migrationPrompt)}`;
  try {
    record.migrationSuggestion = await lmClient.complete(migrationPrompt, { cacheKey: migrationCacheKey });
  } catch (err) {
    console.warn(`AnalyzePipeline: migration LLM failed for ${record.recordId}: ${(err as Error).message}`);
    record.migrationSuggestion = undefined;
  }
}
```

Records with `status === 'safe'` or `status === 'unknown'` do NOT get LLM calls — they're not worth the cost/latency.

**7f — Assemble the ConsumerImpact.**

```typescript
consumerImpacts.push({
  repo: manifest.repo,
  manifest: {
    generatedAt: manifest.generatedAt,
    commit: freshness.commit,
    ageDays: freshness.ageDays,
    driftSinceManifest: {
      javaFilesChanged: freshness.javaFilesChangedSince,
      flag: freshness.flag,
    },
  },
  impacts: <all ImpactRecords for this consumer>,
});
```

### Step 8 — Assemble the ImpactReport

```typescript
const providerName = path.basename(providerRoot);
return {
  meta: {
    provider: providerName,
    base: baseRef,
    head: headRef,
    generatedAt: new Date().toISOString(),
  },
  level1: {
    riskScore,
    changes,
  },
  level2: {
    consumersScanned,
    consumersUnreadable,
    consumers: consumerImpacts,
  },
};
```

---

## Helper: `readCallSiteContext`

A private async function to read a few lines around a call site for the migration prompt.

```typescript
async function readCallSiteContext(
  consumerRoot: string,
  relFile: string,
  line: number,
  contextLines: number = 5
): Promise<string>
```

Behavior:
1. Try to read `path.join(consumerRoot, relFile)`. On ENOENT or any other error, return an empty string.
2. Split content on `\n`. Line indices are 1-based per the caller convention.
3. Extract lines from `Math.max(1, line - contextLines)` to `Math.min(lines.length, line + contextLines)`.
4. Return joined with `\n`.

If reading fails, the migration prompt just gets an empty call site block — the LLM will still produce a reasonable diff based on the change details alone. Do not abort the analyze flow.

---

## Part 2 — Update `src/extension.ts`

Add a registration for `ai-change-impact-notifier.analyze`. Preserve all existing command registrations.

**Add these imports at the top:**

```typescript
import { runAnalyze } from './pipeline/AnalyzePipeline';
```

**Register the analyze command inside `activate`:**

```typescript
const analyzeCmd = vscode.commands.registerCommand('ai-change-impact-notifier.analyze', async () => {
  // 1. Determine provider folder
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage('AI Impact: Please open a workspace with at least one folder.');
    return;
  }

  let providerFolder: vscode.WorkspaceFolder;
  let consumerFolders: vscode.WorkspaceFolder[];

  if (folders.length === 1) {
    // Single folder — treat it as the provider. Look for consumers as sibling folders.
    providerFolder = folders[0];
    consumerFolders = [];
    vscode.window.showInformationMessage(
      'AI Impact: Only one workspace folder found. Add consumer folders to the workspace to analyze cross-repo impact.'
    );
  } else {
    // Multi-root workspace — prompt user to pick provider; rest are consumers.
    const picked = await vscode.window.showQuickPick(
      folders.map((f) => ({ label: f.name, folder: f })),
      { placeHolder: 'Select the provider repo (all others will be treated as consumers)' }
    );
    if (!picked) return;
    providerFolder = picked.folder;
    consumerFolders = folders.filter((f) => f !== providerFolder);
  }

  const providerRoot = providerFolder.uri.fsPath;
  const consumerRoots = consumerFolders.map((f) => f.uri.fsPath);
  const wasmPath = path.join(context.extensionPath, 'resources', 'tree-sitter-java.wasm');

  // 2. Run pipeline with progress
  try {
    const client = await getLmClient();

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `AI Impact: Analyzing ${providerFolder.name}`,
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: 'Extracting surfaces...' });
        const report = await runAnalyze(providerRoot, consumerRoots, client, wasmPath);

        // 3. Save report to .ai-impact/report-<timestamp>.json
        progress.report({ message: 'Saving report...' });
        const reportDir = path.join(providerRoot, '.ai-impact');
        await require('fs/promises').mkdir(reportDir, { recursive: true });
        const reportPath = path.join(reportDir, `report-${Date.now()}.json`);
        await require('fs/promises').writeFile(reportPath, JSON.stringify(report, null, 2), 'utf-8');

        // 4. Summary toast
        const breakingCount = report.level2.consumers
          .flatMap((c) => c.impacts)
          .filter((i) => i.status === 'breaking').length;
        vscode.window.showInformationMessage(
          `Report saved to ${reportPath}. ` +
          `${report.level1.changes.length} producer changes, ` +
          `${report.level2.consumers.length} consumers, ` +
          `${breakingCount} breaking impacts.`
        );
      }
    );
  } catch (err: any) {
    vscode.window.showErrorMessage(`AI Impact: Analyze failed: ${err.message}`);
    console.error(err);
  }
});

context.subscriptions.push(analyzeCmd);
```

Note: the dashboard webview will be added in Prompt 17. For now, we just save the report to a JSON file and show the path in a toast. Users can open the JSON manually to verify correctness.

---

## Part 3 — Update `package.json`

Add the new command to `contributes.commands`:

```json
{
  "command": "ai-change-impact-notifier.analyze",
  "title": "AI Impact: Analyze"
}
```

Add to `activationEvents`:

```json
"onCommand:ai-change-impact-notifier.analyze"
```

Preserve all existing entries.

---

## Error handling philosophy

- Git failures (base ref missing, file not in git at that ref) → log warning, use fallback (empty before-surface, skip file).
- Extractor failures on individual files → log warning, continue.
- Missing consumer manifests → count as `consumersUnreadable`, continue with other consumers.
- LLM failures → the record still exists in the report, just without narrative/migration. UI shows "narrative unavailable" downstream.
- Only truly catastrophic failures (WASM won't load, cannot write report) propagate to the command handler.

---

## Do not

- Do not `git checkout` anything. That would mutate the working tree.
- Do not fetch or push. Only read local git state.
- Do not extract the working tree via `git show :./path` — use plain `fs.readFile` for working tree, `git show <ref>:path` only for historical refs.
- Do not call the LLM for records with `status === 'safe'` or `'unknown'` — bounds cost and latency.
- Do not call the LLM for Level 1 changes — Level 1 is producer-facing and needs no narrative.
- Do not compute the risk score based on LLM output — it's a deterministic function of `changes`.
- Do not treat "no consumers configured" as an error. An empty `consumerRoots[]` produces a valid report with only Level 1 populated.
- Do not use `path.relative` on paths returned by `git ls-tree` — those are already repo-relative.

Complete both files (`AnalyzePipeline.ts` and updates to `extension.ts`). Write focused, well-organized code. Extract private helpers for repeated logic (surface extraction with different readers, call-site context reading, LLM narrative + migration generation). Add JSDoc comments on `runAnalyze` and the command handler explaining the flow.
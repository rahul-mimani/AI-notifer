Add a human-in-the-loop resolution system to the extension. When the parser and LLM together can't fully resolve a consumer-side URL, injected type, or used-field set, the pipeline writes a structured questions file to `.ai-impact/store.answers.json` in the workspace. The user (or a teammate) fills in answers and re-runs Generate. Answered questions become `declared` entries in `store.md`. Unanswered questions are omitted from `store.md` entirely — no LLM guesses in the manifest, no silent skips masking real gaps.

This is a one-command model: `AI Impact: Generate store.md` handles the full lifecycle every run. No separate refresh command.

Types are defined in `src/types.ts` (currently open). LlmAssistedResolver work you did earlier goes into this pipeline unchanged for the deterministic-lookup cases (constant references, property keys). What's new is: (a) LLM output that isn't demonstrably deterministic goes through this human-in-the-loop file instead of the manifest, (b) the file is idempotent across runs, (c) users can commit it so answers travel with the code.

---

## Design principles — preserve these

- **Manifest contains only high-confidence entries.** Every entry in `store.md` is either `declared` (parser-extracted or human-answered) or absent. No `inferred`, no `unknown`, no `low`-confidence entries in the manifest itself.
- **LLM can resolve without asking IF it has concrete provenance.** Finding `Constants.UPLOAD_PATH = "/domain/document/upload"` in the workspace and pointing at the file+line where the value lives = concrete provenance. The LLM did a lookup, not a guess. Auto-resolve with `declared` confidence and record provenance.
- **LLM asks (via the questions file) when it doesn't have concrete provenance.** Guessing based on convention, or reading tea leaves from surrounding code, or interpreting a mapper — these are cases the LLM asks about instead of asserting.
- **Human answers beat everything.** If the user answers a question in the file, that answer wins regardless of what the LLM found later.
- **Skipping is a first-class answer.** Users can mark a question as "not applicable" and it won't be asked again unless the underlying code changes.
- **The answers file is idempotent across runs.** Questions have stable IDs derived from the code they're about, so answered questions stay answered even if unrelated code changes.

---

## Change 1 — new types in `src/types.ts`

Add these interfaces:

```typescript
/**
 * A question the extension is asking the human about a specific unresolved gap.
 * Written to `.ai-impact/store.answers.json`.
 */
export interface ResolutionQuestion {
  /**
   * Stable content-hashed ID derived from the code the question is about.
   * Same code → same ID across runs, so user-provided answers persist.
   */
  id: string;

  /**
   * Kind of gap this question addresses.
   */
  kind: 'url' | 'used_fields' | 'injected_type';

  /**
   * Human-readable question prompt shown at the top of the JSON entry as `question`.
   */
  question: string;

  /**
   * File and line where the gap was detected.
   */
  callSite: {
    file: string;
    line: number;
  };

  /**
   * Raw source-code context (5-10 lines around the gap) for the user's reference.
   */
  sourceContext: string;

  /**
   * LLM's tentative guess for the answer, or null if LLM had no guess.
   * The user can accept the guess by copying it into `answer`, or override it.
   */
  llmGuess: string | string[] | null;

  /**
   * User's answer. When set, this drives store.md.
   * - For 'url' questions: a single string (the resolved path).
   * - For 'used_fields' questions: array of field names.
   * - For 'injected_type' questions: a single FQN string.
   * - null: not yet answered.
   * - "SKIP": explicitly skipped by user, won't be re-asked until source changes.
   */
  answer: string | string[] | null | 'SKIP';

  /**
   * Timestamp of when this question was first raised, in ISO 8601.
   * Preserved across runs so users can prioritize old questions.
   */
  firstRaisedAt: string;
}

/**
 * The full contents of `.ai-impact/store.answers.json`.
 */
export interface AnswersManifest {
  schemaVersion: 1;
  repo: string;
  lastRunAt: string;
  questions: ResolutionQuestion[];
}
```

Extend `HttpCallSite` in `src/types.ts` with an optional field the pipeline uses internally:

```typescript
export interface HttpCallSite {
  // ... existing fields
  /**
   * When set, this call site was raised as a question and either not answered
   * or explicitly skipped. The GeneratePipeline uses this to omit the call
   * site from the final SurfaceSet.
   */
  omittedReason?: 'question_pending' | 'user_skipped';
}
```

Similarly extend `BeanInjection`:

```typescript
export interface BeanInjection {
  // ... existing fields
  omittedReason?: 'question_pending' | 'user_skipped';
}
```

---

## Change 2 — new file `src/store/AnswersStore.ts`

Handles reading, writing, and merging the answers file.

```typescript
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { AnswersManifest, ResolutionQuestion } from '../types';

const ANSWERS_DIR = '.ai-impact';
const ANSWERS_FILENAME = 'store.answers.json';

export class AnswersStore {
  /**
   * Compute a stable ID for a question from the code it's about.
   * The same code produces the same ID, so user answers persist across runs.
   * Uses a content-based hash of the sourceContext + kind.
   */
  static computeQuestionId(kind: string, callSite: { file: string; line: number }, sourceContext: string): string {
    const material = `${kind}|${callSite.file}|${sourceContext}`;
    return crypto.createHash('sha256').update(material).digest('hex').substring(0, 12);
  }

  /**
   * Read the existing answers file. Returns an empty manifest if missing.
   */
  async read(workspaceRoot: string, repoName: string): Promise<AnswersManifest> {
    const filePath = path.join(workspaceRoot, ANSWERS_DIR, ANSWERS_FILENAME);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      if (parsed && parsed.schemaVersion === 1 && Array.isArray(parsed.questions)) {
        return parsed as AnswersManifest;
      }
      console.warn(`AnswersStore: existing file at ${filePath} is malformed, starting fresh`);
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        console.warn(`AnswersStore: read failed: ${err.message}`);
      }
    }
    return {
      schemaVersion: 1,
      repo: repoName,
      lastRunAt: new Date().toISOString(),
      questions: [],
    };
  }

  /**
   * Merge new questions with existing answered ones. Rules:
   * - If a new question has the same ID as an existing one, preserve the existing answer.
   * - If an existing question's ID is not in the new set, drop it (the underlying code changed).
   * - New questions get answer=null and firstRaisedAt=now.
   * Returns the merged manifest.
   */
  merge(existing: AnswersManifest, newQuestions: ResolutionQuestion[], repoName: string): AnswersManifest {
    const existingById = new Map<string, ResolutionQuestion>();
    for (const q of existing.questions) {
      existingById.set(q.id, q);
    }

    const mergedQuestions: ResolutionQuestion[] = [];
    for (const nq of newQuestions) {
      const existingQ = existingById.get(nq.id);
      if (existingQ) {
        // Preserve user answer and firstRaisedAt; update everything else in case source shifted line numbers.
        mergedQuestions.push({
          ...nq,
          answer: existingQ.answer,
          firstRaisedAt: existingQ.firstRaisedAt,
        });
      } else {
        mergedQuestions.push({
          ...nq,
          answer: null,
          firstRaisedAt: new Date().toISOString(),
        });
      }
    }

    return {
      schemaVersion: 1,
      repo: repoName,
      lastRunAt: new Date().toISOString(),
      questions: mergedQuestions,
    };
  }

  /**
   * Write the manifest to disk. Creates the .ai-impact directory if needed.
   */
  async write(workspaceRoot: string, manifest: AnswersManifest): Promise<void> {
    const dirPath = path.join(workspaceRoot, ANSWERS_DIR);
    const filePath = path.join(dirPath, ANSWERS_FILENAME);
    await fs.mkdir(dirPath, { recursive: true });
    const content = JSON.stringify(manifest, null, 2);
    await fs.writeFile(filePath, content, 'utf-8');
  }
}
```

---

## Change 3 — update `LlmAssistedResolver` for two-tier LLM behavior

Modify the existing `src/parser/LlmAssistedResolver.ts` so that each resolution attempt returns one of three outcomes:

- `{ status: 'resolved', value: <resolved>, provenance: <file+line> }` — LLM found concrete evidence. Auto-apply as `declared` with provenance recorded.
- `{ status: 'question', llmGuess: <best-guess or null> }` — LLM couldn't ground the answer. Raise a question for the human.
- `{ status: 'failed', reason: <string> }` — LLM call errored. Raise a question with no guess.

Update the prompt templates in `src/llm/Prompts.ts` so the JSON schema includes a `provenance` field. For URL resolution:

```json
{
  "resolvedPath": "/domain/document/upload",
  "hasProvenance": true,
  "provenance": {
    "file": "src/main/resources/application.properties",
    "line": 12,
    "matchedText": "cdu.upload.endpoint=/domain/document/upload"
  },
  "confidence": "high | medium | low",
  "reason": "one sentence explanation"
}
```

Instruction to the LLM:
- `hasProvenance: true` ONLY if you can point at a specific file and line in the provided context that contains the concrete answer.
- If the answer required guessing based on convention or naming patterns, set `hasProvenance: false` and set `confidence` to `low` or `medium`.
- `high` confidence + `hasProvenance: true` → the pipeline auto-applies.
- Any other combination → the pipeline raises a question.

Update `LlmAssistedResolver.resolveUrls` to return the three-way outcome per call site instead of mutating in place:

```typescript
export interface UrlResolutionOutcome {
  callSite: HttpCallSite;
  status: 'resolved' | 'question' | 'failed';
  resolvedPath?: string;
  provenance?: { file: string; line: number };
  llmGuess?: string;
  reason?: string;
}

async resolveUrls(
  callSites: HttpCallSite[],
  context: ResolverContext
): Promise<UrlResolutionOutcome[]>
```

Similarly for `resolveFields`:

```typescript
export interface FieldResolutionOutcome {
  callSite: HttpCallSite;
  status: 'resolved' | 'question' | 'failed';
  resolvedFields?: string[];
  provenance?: { file: string; line: number };
  llmGuess?: string[];
  reason?: string;
}

async resolveFields(
  callSites: HttpCallSite[],
  context: ResolverContext
): Promise<FieldResolutionOutcome[]>
```

Preserve the caching behavior via `cacheKey`.

---

## Change 4 — extend `ResolverContext` to load `application.properties` and `application.yml`

Add a helper to `src/parser/LlmAssistedResolver.ts` (or a new small module `src/config/PropertiesLoader.ts`):

```typescript
export interface PropertiesFile {
  filePath: string;
  content: string;
  keys: Map<string, { value: string; line: number }>;
}

export async function loadPropertiesFiles(workspaceRoot: string): Promise<PropertiesFile[]> {
  const searchRoots = [
    path.join(workspaceRoot, 'src/main/resources'),
    path.join(workspaceRoot, 'src/test/resources'),  // include for completeness
  ];
  const files: PropertiesFile[] = [];
  for (const searchRoot of searchRoots) {
    try {
      const entries = await fs.readdir(searchRoot);
      for (const entry of entries) {
        if (!entry.startsWith('application')) continue;
        if (!/\.(properties|ya?ml)$/.test(entry)) continue;
        const filePath = path.join(searchRoot, entry);
        const content = await fs.readFile(filePath, 'utf-8');
        const keys = parsePropertiesOrYaml(entry, content);
        files.push({ filePath, content, keys });
      }
    } catch { /* ignore missing directories */ }
  }
  return files;
}
```

The `parsePropertiesOrYaml` function handles both formats:
- `.properties`: line-by-line, `key=value` with optional `#` comments.
- `.yml`/`.yaml`: use the `yaml` package (already installed) and flatten nested keys with `.` separator. So:
  ```yaml
  cdu:
    upload:
      endpoint: /domain/document/upload
  ```
  Produces the key `cdu.upload.endpoint` = `/domain/document/upload`.

Handles Spring profile-specific files too (`application-dev.properties`, etc.) — include all of them, and note the profile in a returned metadata field if needed.

Pass loaded properties into the LLM prompt as part of the resolver context. Update the URL resolution prompt to include a "PROPERTIES CONTEXT" section listing all loaded files with their keys.

---

## Change 5 — update `HttpCallSiteExtractor` to emit resolution hints for `@Value` and property references

The extractor already emits `resolutionHint.needsUrlResolution.rawExpression` for cases where the URL is a bare identifier (like `Constants.UPLOAD_PATH`). Extend this to also detect and emit hints for:

- Fields injected via `@Value("${key.name}")`. When such a field is used as a URL argument, capture the property key `key.name` in the raw expression string.
- Fields injected via `@Value("${key.name:default-value}")`. Capture the key AND the default value.
- URLs built via `UriComponentsBuilder.fromHttpUrl(baseUrl).path("/x/{id}").buildAndExpand(...)`. Extract the `.path()` string and note the base URL variable.

The raw expression string should preserve enough information for the LLM prompt to work with. Example: `@Value:${cdu.upload.endpoint:/default/upload}` clearly signals a property reference with a default.

---

## Change 6 — update `GeneratePipeline` for the one-command flow

Modify `src/pipeline/GeneratePipeline.ts` to sequence: parser → answers file (existing) → LLM auto-resolve → merge answers file → write manifest → write answers file.

New flow:

```typescript
async function runGenerate(
  workspaceRoot: string,
  lmClient: LmClient,
  wasmPath: string,
  options?: GenerateOptions
): Promise<GenerateResult> {
  // 1. Existing setup: parser init, walk files, extract SurfaceSet.
  //    (unchanged)

  // 2. Read existing answers file.
  const answersStore = new AnswersStore();
  const existingAnswers = await answersStore.read(workspaceRoot, repoName);

  // 3. Load application properties (for LLM context).
  const propertiesFiles = await loadPropertiesFiles(workspaceRoot);

  // 4. Identify gaps (call sites and injections with resolutionHint set).
  const urlGaps = surface.consumes.httpCalls.filter(cs => cs.resolutionHint?.needsUrlResolution);
  const fieldGaps = surface.consumes.httpCalls.filter(cs => cs.resolutionHint?.needsFieldResolution);
  // (add injection type gaps if BeanExtractor emits them; skip if not for v1)

  // 5. For each gap, check the answers file first.
  //    If a matching question ID has answer !== null && answer !== "SKIP", use that answer.
  //    Else, run LLM resolution.
  const resolver = new LlmAssistedResolver(lmClient);
  const context: ResolverContext = {
    fileSource: '',  // caller may plumb per-file source; empty for v1
    imports: new Map(),
    knownResponseFields: new Map(),
    propertiesFiles,
  };

  const newQuestions: ResolutionQuestion[] = [];

  // 5a. URL gaps.
  const urlOutcomes = await resolver.resolveUrls(urlGaps, context);
  for (const outcome of urlOutcomes) {
    const questionId = AnswersStore.computeQuestionId(
      'url',
      { file: outcome.callSite.file, line: outcome.callSite.line },
      outcome.callSite.resolutionHint?.needsUrlResolution?.rawExpression ?? ''
    );

    // Check for existing answer.
    const existingQ = existingAnswers.questions.find(q => q.id === questionId);
    if (existingQ?.answer && existingQ.answer !== 'SKIP' && typeof existingQ.answer === 'string') {
      // Apply human answer.
      outcome.callSite.path = existingQ.answer;
      delete outcome.callSite.resolutionHint!.needsUrlResolution;
      // Question stays in the file for audit but is now "answered".
      newQuestions.push({
        ...existingQ,
        // Refresh source context in case it shifted:
        sourceContext: extractSourceContext(outcome.callSite),
      });
      continue;
    }

    if (existingQ?.answer === 'SKIP') {
      // User explicitly skipped; omit from manifest.
      outcome.callSite.omittedReason = 'user_skipped';
      newQuestions.push({
        ...existingQ,
        sourceContext: extractSourceContext(outcome.callSite),
      });
      continue;
    }

    if (outcome.status === 'resolved') {
      // LLM auto-resolved with provenance; apply as declared.
      outcome.callSite.path = outcome.resolvedPath!;
      delete outcome.callSite.resolutionHint!.needsUrlResolution;
      // No question raised — provenance is sufficient. But we DO record it in the file
      // for audit trail under a resolved-questions section.
      newQuestions.push({
        id: questionId,
        kind: 'url',
        question: `What URL does ${outcome.callSite.resolutionHint?.needsUrlResolution?.rawExpression} resolve to?`,
        callSite: { file: outcome.callSite.file, line: outcome.callSite.line },
        sourceContext: extractSourceContext(outcome.callSite),
        llmGuess: outcome.resolvedPath!,
        answer: outcome.resolvedPath!,  // auto-answered by LLM
        firstRaisedAt: new Date().toISOString(),
      });
      continue;
    }

    // LLM failed or couldn't ground the answer — raise a question.
    outcome.callSite.omittedReason = 'question_pending';
    newQuestions.push({
      id: questionId,
      kind: 'url',
      question: `Cannot resolve URL expression "${outcome.callSite.resolutionHint?.needsUrlResolution?.rawExpression}" at ${outcome.callSite.file}:${outcome.callSite.line}. What is the actual URL path?`,
      callSite: { file: outcome.callSite.file, line: outcome.callSite.line },
      sourceContext: extractSourceContext(outcome.callSite),
      llmGuess: outcome.llmGuess ?? null,
      answer: null,
      firstRaisedAt: new Date().toISOString(),
    });
  }

  // 5b. Field gaps.
  //    Same pattern as URL gaps. Use kind='used_fields'.
  //    Answered questions produce usedFields entries with 'declared' confidence.
  //    Skipped questions leave usedFields empty (the call site is emitted but with no fields).
  //    Pending questions cause the call site to be omitted entirely.
  //    Auto-resolved (LLM with provenance) applies fields with 'declared'.

  const fieldOutcomes = await resolver.resolveFields(fieldGaps, context);
  for (const outcome of fieldOutcomes) {
    // ... same shape as URL handling
  }

  // 6. Filter omitted call sites out of the SurfaceSet before writing store.md.
  surface.consumes.httpCalls = surface.consumes.httpCalls.filter(cs => !cs.omittedReason);
  surface.consumes.beanInjections = surface.consumes.beanInjections.filter(bi => !bi.omittedReason);

  // 7. Merge new questions with existing answers file. This preserves user answers
  //    for questions whose IDs recur.
  const mergedAnswers = answersStore.merge(existingAnswers, newQuestions, repoName);

  // 8. Write both files.
  //    a. store.md (existing StoreWriter logic).
  //    b. .ai-impact/store.answers.json.
  await answersStore.write(workspaceRoot, mergedAnswers);

  // 9. Return result with question counts for the UI toast.
  const pendingQuestions = mergedAnswers.questions.filter(q => q.answer === null).length;
  const skippedQuestions = mergedAnswers.questions.filter(q => q.answer === 'SKIP').length;
  const autoResolvedThisRun = mergedAnswers.questions.filter(
    q => q.answer !== null && q.answer !== 'SKIP' && q.firstRaisedAt === /* this run's timestamp */
  ).length;

  return {
    storeMdPath: path.join(workspaceRoot, 'store.md'),
    answersPath: path.join(workspaceRoot, '.ai-impact', 'store.answers.json'),
    surfaceCounts: { /* existing counts */ },
    questionCounts: {
      pending: pendingQuestions,
      skipped: skippedQuestions,
      autoResolvedThisRun,
    },
  };
}
```

Add a helper `extractSourceContext(callSite)` that reads 5 lines before and 5 lines after the callSite file+line and returns as a string. Reuse or extract the existing `readCallSiteContext` from AnalyzePipeline if it fits.

---

## Change 7 — update the command handler in `src/extension.ts`

Modify the toast at the end of `AI Impact: Generate store.md` to reflect the new question counts:

```typescript
const msg = 
  `store.md written to ${result.storeMdPath}. ` +
  `Surface: ${result.surfaceCounts.endpoints} endpoints, ` +
  `${result.surfaceCounts.dtos} DTOs, ${result.surfaceCounts.beans} beans, ` +
  `${result.surfaceCounts.httpCalls} HTTP calls, ` +
  `${result.surfaceCounts.beanInjections} bean injections.`;

if (result.questionCounts.pending > 0) {
  const openChoice = await vscode.window.showInformationMessage(
    `${msg} ${result.questionCounts.pending} unresolved questions at ${result.answersPath}. Open now?`,
    'Open answers file',
    'Dismiss'
  );
  if (openChoice === 'Open answers file') {
    const uri = vscode.Uri.file(result.answersPath);
    await vscode.window.showTextDocument(uri);
  }
} else if (result.questionCounts.autoResolvedThisRun > 0) {
  vscode.window.showInformationMessage(
    `${msg} All resolvable gaps resolved automatically. See ${result.answersPath} for audit trail.`
  );
} else {
  vscode.window.showInformationMessage(msg);
}
```

---

## Change 8 — update `store.md` content to reference the answers file

At the top of the AI-PROSE section, if there are pending questions, add a callout. Modify `StoreWriter` slightly:

Actually don't modify StoreWriter. Instead, have GeneratePipeline pass a prose prefix into the prose string that mentions pending questions. Something like:

```
> Note: N questions in .ai-impact/store.answers.json are pending human review.
> Related consumer usages have been omitted from this manifest until resolved.
```

Only prepend when questionCounts.pending > 0. Otherwise the prose is unchanged.

---

## Do not

- Do not add any `inferred` or `unknown` entries to the manifest. Every field in the manifest is either parser-derived or human-confirmed or LLM-with-concrete-provenance.
- Do not delete unanswered questions from the answers file. They persist across runs until either the underlying code changes (question ID no longer generated) or the user answers/skips.
- Do not run the LLM without a cache key. Use content-hashed keys per question.
- Do not throw. All failures degrade to raising a question with `llmGuess: null`.
- Do not modify the severity scorer.
- Do not modify the matcher (it consumes whatever's in the manifest).
- Do not modify the analyze pipeline.
- Do not commit the LLM's guess as an answer without provenance — the auto-resolve path requires `hasProvenance: true` from the LLM.
- Do not import the yaml package if it's not already installed for the properties/yml parsing. It's already installed for the store writer/reader.
- Do not walk the entire workspace for constants — only files under `src/main/java` and `src/main/resources`.
- Do not attempt Spring profile activation logic. Load ALL `application*.properties` and `application*.yml` files as candidate context; let the LLM pick the most relevant based on the prompt.
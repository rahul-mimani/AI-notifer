Diagnose and fix a bug in `src/pipeline/GeneratePipeline.ts` where human-provided answers in `.ai-impact/store.answers.json` are correctly read but do not appear in the resulting `store.md`. The user answers a question by editing the answers file, re-runs the Generate command, and the answered URL or field set does not show up in the manifest under `consumes.httpCalls`.

Types are in `src/types.ts` (open). The answers store is in `src/store/AnswersStore.ts` (open). The main pipeline is `src/pipeline/GeneratePipeline.ts` (open).

## Two-part fix — do both

### Part 1 — add diagnostic logs so we can see the flow

At the top of `runGenerate` in `src/pipeline/GeneratePipeline.ts`, log the loaded answers:

```typescript
console.log(`[DIAG-ANSWERS] Loaded ${existingAnswers.questions.length} existing questions from answers file`);
const answered = existingAnswers.questions.filter(q => q.answer !== null && q.answer !== 'SKIP');
console.log(`[DIAG-ANSWERS] Of those, ${answered.length} have answers`);
for (const q of answered) {
  console.log(`[DIAG-ANSWERS]   id=${q.id} kind=${q.kind} answer=${JSON.stringify(q.answer)} callSite=${q.callSite.file}:${q.callSite.line}`);
}
```

In the URL-gap loop (where each `outcome` in `urlOutcomes` is processed), inside the loop body, immediately AFTER computing `questionId`:

```typescript
const rawExpr = outcome.callSite.resolutionHint?.needsUrlResolution?.rawExpression ?? '';
const questionId = AnswersStore.computeQuestionId(
  'url',
  { file: outcome.callSite.file, line: outcome.callSite.line },
  rawExpr
);

console.log(`[DIAG-ANSWERS] URL gap at ${outcome.callSite.file}:${outcome.callSite.line}`);
console.log(`[DIAG-ANSWERS]   rawExpression = "${rawExpr}"`);
console.log(`[DIAG-ANSWERS]   computed questionId = ${questionId}`);
const existingQ = existingAnswers.questions.find(q => q.id === questionId);
console.log(`[DIAG-ANSWERS]   existingQ found = ${existingQ ? 'YES' : 'NO'}`);
if (existingQ) {
  console.log(`[DIAG-ANSWERS]   existingQ.answer = ${JSON.stringify(existingQ.answer)}`);
}
```

Then inside the "human answer present" branch, log the application:

```typescript
if (existingQ?.answer && existingQ.answer !== 'SKIP' && typeof existingQ.answer === 'string') {
  console.log(`[DIAG-ANSWERS]   APPLYING answer to callSite.path = "${existingQ.answer}"`);
  outcome.callSite.path = existingQ.answer;
  delete outcome.callSite.resolutionHint?.needsUrlResolution;
  delete outcome.callSite.omittedReason;   // critical — see Part 2
  console.log(`[DIAG-ANSWERS]   After apply: path=${outcome.callSite.path}, omittedReason=${outcome.callSite.omittedReason}, hint=${JSON.stringify(outcome.callSite.resolutionHint)}`);
  // ... existing push to newQuestions
  continue;
}
```

In the field-gap loop, do the same shape of logs. Log the raw expression / responseType, the computed questionId, whether an existing question was found, its answer, and log after applying.

At the point where the surface is filtered before writing store.md, log what's being kept vs dropped:

```typescript
const beforeFilterCalls = surface.consumes.httpCalls.length;
const droppedCalls = surface.consumes.httpCalls.filter(cs => cs.omittedReason);
console.log(`[DIAG-ANSWERS] Filter step: ${beforeFilterCalls} httpCalls before filter, ${droppedCalls.length} to drop`);
for (const dc of droppedCalls) {
  console.log(`[DIAG-ANSWERS]   dropping ${dc.file}:${dc.line} path="${dc.path}" reason=${dc.omittedReason}`);
}
surface.consumes.httpCalls = surface.consumes.httpCalls.filter(cs => !cs.omittedReason);
console.log(`[DIAG-ANSWERS] After filter: ${surface.consumes.httpCalls.length} httpCalls`);
```

Do the same for `beanInjections` if they have `omittedReason` handling.

### Part 2 — apply the most likely fixes

The bug is almost certainly one or more of these three. Fix all three at once — they're small and cheap.

**Fix A — clear `omittedReason` when applying a human answer.**

The pipeline likely sets `omittedReason: 'question_pending'` early as a defensive default when the gap is detected, and the "answer found" branches don't clear it. When the filter step runs, the callSite is dropped because `omittedReason` is still set.

In the URL-gap loop, "human answer present" branch, add:

```typescript
delete outcome.callSite.omittedReason;
```

In the "LLM auto-resolved" branch, same:

```typescript
delete outcome.callSite.omittedReason;
```

In the field-gap loop, do both branches. And any other place where a gap is being marked as resolved (either by human answer or LLM provenance), explicitly clear `omittedReason`.

**Fix B — question ID stability.**

Verify `AnswersStore.computeQuestionId` does NOT include the line number in the hash material. Line numbers shift when unrelated code changes, and if the ID includes the line, a small edit invalidates every answer.

Open `src/store/AnswersStore.ts`. If `computeQuestionId` looks like this:

```typescript
static computeQuestionId(kind, callSite, sourceContext) {
  const material = `${kind}|${callSite.file}|${callSite.line}|${sourceContext}`;  // BAD - includes line
  // ...
}
```

Change to:

```typescript
static computeQuestionId(kind, callSite, sourceContext) {
  const material = `${kind}|${callSite.file}|${sourceContext}`;  // GOOD - no line
  // ...
}
```

Also verify: the `sourceContext` passed to `computeQuestionId` from the pipeline should be the RAW EXPRESSION or a small identifying signature, NOT the full 10-line context (which might change if surrounding code shifts). If the pipeline passes the full context, change it to pass just the raw expression string for URL gaps, and `responseType + responseVarName` for field gaps.

Specifically, in the URL-gap loop, the third argument to `computeQuestionId` should be the rawExpression:

```typescript
const questionId = AnswersStore.computeQuestionId(
  'url',
  { file: outcome.callSite.file, line: outcome.callSite.line },
  rawExpr   // just the raw expression, NOT the multi-line context
);
```

For field gaps:

```typescript
const questionId = AnswersStore.computeQuestionId(
  'used_fields',
  { file: outcome.callSite.file, line: outcome.callSite.line },
  `${outcome.callSite.responseType}|${outcome.callSite.resolutionHint?.needsFieldResolution?.responseVarName}`
);
```

The user-facing `sourceContext` in the ResolutionQuestion object can still be the full 10-line context (for their reference when reading the question) — but the ID hash should use only the stable identifying material.

**Fix C — file-path canonicalization.**

The `callSite.file` used in ID computation might be absolute in one run and relative in another (or use different path separators on Windows). Canonicalize before hashing:

```typescript
static computeQuestionId(kind: string, callSite: { file: string; line: number }, sourceContext: string): string {
  const canonicalFile = callSite.file.replace(/\\/g, '/');  // normalize Windows paths
  const material = `${kind}|${canonicalFile}|${sourceContext}`;
  return crypto.createHash('sha256').update(material).digest('hex').substring(0, 12);
}
```

If `callSite.file` might be absolute vs relative, strip everything up to and including `src/` for stability:

```typescript
const canonicalFile = callSite.file.replace(/\\/g, '/').replace(/^.*?\/src\//, 'src/');
```

Only apply this canonicalization if you're actually seeing path variation between runs. If the pipeline consistently passes repo-relative paths, plain `replace(/\\/g, '/')` is enough.

## Do not

- Do not remove existing behavior. The three fixes above are purely additive/corrective.
- Do not modify the answers file schema.
- Do not change how the answers file is read or written — the AnswersStore code is likely correct.
- Do not touch StoreWriter, StoreReader, or any downstream module.
- Do not throw. Preserve all existing try/catch blocks.
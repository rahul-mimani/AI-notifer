Add strategic diagnostic logging to `src/pipeline/AnalyzePipeline.ts` to diagnose why the Analyze command is producing zero producer changes and zero consumer impacts even when the user has visibly modified a DTO in the working tree. The logs must reveal at each stage: whether git detected uncommitted changes, what "before" and "after" surfaces were extracted, what the diff engine produced, and what the matcher correlated. Do not change any logic — only add logs.

Types are in `src/types.ts` (open). The pipeline is in `src/pipeline/AnalyzePipeline.ts` (open).

All logs use the prefix `[DIAG-ANALYZE]` so they can be filtered in the debug console with a single filter string.

## Step 1 — log the base/head detection

At the top of `runAnalyze`, after the git detection block that decides base and head refs:

```typescript
console.log(`[DIAG-ANALYZE] providerRoot = ${providerRoot}`);
console.log(`[DIAG-ANALYZE] consumerRoots = ${JSON.stringify(consumerRoots)}`);

// After the git diff detection that sets baseRef / headRef:
console.log(`[DIAG-ANALYZE] git base/head detection: baseRef=${baseRef}, headRef=${headRef}`);

// Also log the raw output of the uncommitted-changes check for verification:
try {
  const { stdout: statusOut } = await execFileAsync(
    'git',
    ['status', '--porcelain', '--', '*.java'],
    { cwd: providerRoot }
  );
  const uncommittedFiles = statusOut.split('\n').filter(l => l.trim().length > 0);
  console.log(`[DIAG-ANALYZE] git status --porcelain returned ${uncommittedFiles.length} lines`);
  for (const line of uncommittedFiles.slice(0, 20)) {
    console.log(`[DIAG-ANALYZE]   ${line}`);
  }
} catch (err) {
  console.log(`[DIAG-ANALYZE] git status failed: ${(err as Error).message}`);
}
```

This tells us definitively whether git sees the user's uncommitted changes, and what the pipeline decided to diff against. If `headRef` is `HEAD` instead of `working-tree` when the user has visibly modified files, the detection is broken — that alone explains zero changes.

## Step 2 — log the working-tree file walk

Wherever `walkJavaFiles` is called for the working-tree extraction (or the equivalent function name from GeneratePipeline that AnalyzePipeline reuses):

```typescript
const workingTreeFiles = await walkJavaFiles(providerRoot);
console.log(`[DIAG-ANALYZE] Working tree walk: found ${workingTreeFiles.length} .java files under ${providerRoot}`);

const filesOfInterest = workingTreeFiles.filter(f =>
  /Response\.java$/.test(f) || /Request\.java$/.test(f) || /Dto\.java$/i.test(f) || /Controller\.java$/.test(f)
);
console.log(`[DIAG-ANALYZE] Working tree files of interest (Response/Request/Dto/Controller): ${filesOfInterest.length}`);
for (const f of filesOfInterest.slice(0, 15)) {
  console.log(`[DIAG-ANALYZE]   ${f}`);
}
```

## Step 3 — log the git-base file listing

Wherever the pipeline uses `git ls-tree` to list files at `baseRef`:

```typescript
const { stdout: fileList } = await execFileAsync(
  'git',
  ['ls-tree', '-r', '--name-only', baseRef, '--', '*.java'],
  { cwd: providerRoot }
);
const baseFiles = fileList.split('\n').map(l => l.trim()).filter(l => l.endsWith('.java'));
console.log(`[DIAG-ANALYZE] git ls-tree ${baseRef}: found ${baseFiles.length} .java files at base ref`);
const baseFilesOfInterest = baseFiles.filter(f =>
  /Response\.java$/.test(f) || /Request\.java$/.test(f) || /Dto\.java$/i.test(f) || /Controller\.java$/.test(f)
);
console.log(`[DIAG-ANALYZE] Base ref files of interest: ${baseFilesOfInterest.length}`);
for (const f of baseFilesOfInterest.slice(0, 15)) {
  console.log(`[DIAG-ANALYZE]   ${f}`);
}
```

## Step 4 — log the per-surface extraction counts

After the "before" extraction completes:

```typescript
console.log(`[DIAG-ANALYZE] BEFORE surface counts: endpoints=${beforeSurface.provides.endpoints.length}, dtos=${beforeSurface.provides.dtos.length}, beans=${beforeSurface.provides.beans.length}`);
```

After the "after" extraction completes:

```typescript
console.log(`[DIAG-ANALYZE] AFTER surface counts: endpoints=${afterSurface.provides.endpoints.length}, dtos=${afterSurface.provides.dtos.length}, beans=${afterSurface.provides.beans.length}`);
```

If BEFORE and AFTER counts are identical AND small (like 0 or a handful when the repo actually has dozens), the extractor is failing on both sides for the same reason — likely a shared bug in the "read a file's content and pass to extractor" step. If BEFORE is 0 but AFTER is populated, the git-base extraction is broken. If both are populated but identical, the DTO diff isn't detecting the modified DTOs.

## Step 5 — log specific DTOs of interest from each surface

After both extractions, find a DTO the user likely edited (any DTO with "Response" in its name) and log its state on both sides:

```typescript
const targetDtoPattern = /Response$/;
const beforeDtos = beforeSurface.provides.dtos.filter(d => targetDtoPattern.test(d.fqName.split('.').pop() ?? ''));
const afterDtos = afterSurface.provides.dtos.filter(d => targetDtoPattern.test(d.fqName.split('.').pop() ?? ''));

console.log(`[DIAG-ANALYZE] DTOs matching *Response in BEFORE: ${beforeDtos.length}`);
for (const d of beforeDtos.slice(0, 10)) {
  console.log(`[DIAG-ANALYZE]   ${d.fqName} — ${d.fields.length} fields: [${d.fields.map(f => f.name).join(', ')}]`);
}

console.log(`[DIAG-ANALYZE] DTOs matching *Response in AFTER: ${afterDtos.length}`);
for (const d of afterDtos.slice(0, 10)) {
  console.log(`[DIAG-ANALYZE]   ${d.fqName} — ${d.fields.length} fields: [${d.fields.map(f => f.name).join(', ')}]`);
}
```

This shows the field lists on each side. If both are identical for the DTO the user modified, that's the smoking gun — extraction is producing the same result despite the working tree change.

## Step 6 — log the diff result

Right after `diffEngine.diff` returns:

```typescript
console.log(`[DIAG-ANALYZE] DiffEngine returned ${changes.length} ChangeEvents`);
const changeKindCounts = new Map<string, number>();
for (const c of changes) {
  changeKindCounts.set(c.kind, (changeKindCounts.get(c.kind) ?? 0) + 1);
}
for (const [kind, count] of changeKindCounts) {
  console.log(`[DIAG-ANALYZE]   ${kind}: ${count}`);
}

// Show first 5 changes in detail:
for (const c of changes.slice(0, 5)) {
  console.log(`[DIAG-ANALYZE]   change: kind=${c.kind}, surfaceId=${c.surfaceId}, severity=${c.severity}`);
}
```

## Step 7 — log matcher results per consumer

Inside the consumer loop, after `matchHttp` and `matchBean`:

```typescript
console.log(`[DIAG-ANALYZE] Consumer ${manifest.repo}: manifest has ${manifest.consumes.httpCalls.length} httpCalls, ${manifest.consumes.beanInjections.length} beanInjections`);
console.log(`[DIAG-ANALYZE]   matchHttp returned ${httpMatches.length} matches`);
console.log(`[DIAG-ANALYZE]   matchBean returned ${beanMatches.length} matches`);

// For each http match, log the details:
for (const m of httpMatches.slice(0, 10)) {
  console.log(`[DIAG-ANALYZE]     httpMatch: change=${m.change.kind}/${m.change.surfaceId}, callSite=${m.callSite.file}:${m.callSite.line}, usedField=${m.usedField ? m.usedField.path : 'null'}`);
}
```

## Step 8 — log final impact record counts

Before returning the report:

```typescript
const totalImpacts = consumerImpacts.reduce((sum, c) => sum + c.impacts.length, 0);
const breakingCount = consumerImpacts.flatMap(c => c.impacts).filter(i => i.status === 'breaking').length;
const reviewCount = consumerImpacts.flatMap(c => c.impacts).filter(i => i.status === 'review_recommended').length;
const safeCount = consumerImpacts.flatMap(c => c.impacts).filter(i => i.status === 'safe').length;

console.log(`[DIAG-ANALYZE] Final report: ${changes.length} producer changes, ${consumersScanned} consumers scanned, ${totalImpacts} total impacts (${breakingCount} breaking, ${reviewCount} review, ${safeCount} safe)`);
```

## Do not

- Do not change any logic. Only add logs.
- Do not modify how base/head refs are detected. If detection is broken, we'll fix it based on the log output.
- Do not modify the extractors, diff engine, or matcher.
- Do not remove existing behavior.
- Do not throw new errors.

## Instructions to the user after applying

Reload the extension window, open the debug console (Help → Toggle Developer Tools → Console), filter for `[DIAG-ANALYZE]`, run Analyze on CDU with your uncommitted DTO changes, then paste back:

1. The full sequence of `[DIAG-ANALYZE]` lines from the console.
2. The generated report JSON.

The two together will pinpoint exactly which stage is producing empty output. Most likely explanations, in order of likelihood:

- **`baseRef=HEAD~1, headRef=HEAD`** instead of `HEAD` and `working-tree` → the uncommitted-changes detection failed. Bug in the git status parsing.
- **`git ls-tree` returns 0 files at base ref** → the base ref doesn't exist (fresh repo or shallow clone). Fallback to empty before-surface not working correctly.
- **BEFORE and AFTER DTO field lists are identical** for the file you changed → extractor is producing the same output. Most likely cause: the "after" extraction is reading from git instead of working tree, OR the "before" extraction is reading from working tree instead of git.
- **DiffEngine returns 0 changes despite different field lists** → bug in the diff engine's DTO comparison logic.
- **Matches array is empty despite changes and consumer manifest** → path normalization or fqName mismatch.

Complete the modifications. The logs are strategic — keep them in the final build.
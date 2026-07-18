Create a new file src/freshness/FreshnessChecker.ts that checks how out-of-date a consumer's store.md manifest is by comparing its generatedFromCommit and generatedAt against the consumer repo's current HEAD. The output — a FreshnessInfo — becomes part of every Level 2 impact record in the report, so consumers can see whether the manifest they're being judged against is still trustworthy.
Types are defined in src/types.ts (currently open). Import FreshnessInfo from there.
Class shape:
Export a class FreshnessChecker with one public method:
typescriptasync check(
  repoRoot: string,
  manifestCommit: string,
  manifestGeneratedAt: string
): Promise<FreshnessInfo>;
No constructor arguments, no shared state.
Imports:
typescriptimport { execFile } from 'child_process';
import { promisify } from 'util';
import { FreshnessInfo } from '../types';

const execFileAsync = promisify(execFile);

Behavior
The method performs three computations independently and combines them into a FreshnessInfo result. Each computation has a fallback path so that a partial failure still produces a usable result.
Computation 1 — ageDays
Compute the age of the manifest in days:
typescriptconst generatedMs = Date.parse(manifestGeneratedAt);
const ageDays = isNaN(generatedMs)
  ? 0
  : Math.max(0, Math.floor((Date.now() - generatedMs) / 86400000));

Use Math.floor — a manifest generated 30 hours ago is 1 day old, not 2.
Use Math.max(0, ...) — a manifest with a future timestamp (clock skew, bad input) is treated as 0 days old, not negative.
Invalid ISO strings (Date.parse returns NaN) default to 0 days. Do not throw. This is a "best available data" module.

Computation 2 — commit
The short SHA displayed to the user:
typescriptconst commit = manifestCommit.length >= 7 ? manifestCommit.substring(0, 7) : manifestCommit;

No git call needed for this — it's a pure string slice.
Preserve the input verbatim if it's shorter than 7 characters (defensive; shouldn't happen with real SHAs).

Computation 3 — javaFilesChangedSince
This requires two git operations:
Step 3a — verify the commit exists in the repo.
Run:
typescriptawait execFileAsync('git', ['rev-parse', '--verify', `${manifestCommit}^{commit}`], { cwd: repoRoot });
The ^{commit} suffix ensures the ref actually resolves to a commit object (not a tree or blob). If this command fails (non-zero exit, throws in the promisified form), the commit is not present in the repo — could be a shallow clone, a rebased-away commit, or a completely wrong SHA. In this case:
typescriptreturn {
  ageDays,
  commit,
  javaFilesChangedSince: -1,
  flag: 'significantly_drifted',
};
Also log a warning: console.warn(\FreshnessChecker: commit ${manifestCommit} not found in ${repoRoot}; treating as significantly_drifted.`);`
Do not attempt Step 3b if 3a fails.
Step 3b — count changed Java files since the manifest commit.
Run:
typescriptconst { stdout } = await execFileAsync(
  'git',
  ['diff', '--name-only', `${manifestCommit}`, 'HEAD', '--', '*.java'],
  { cwd: repoRoot }
);
Parse the output:

Split on \n.
Filter out empty lines (empty strings, whitespace-only lines).
The count of remaining lines is javaFilesChangedSince.

If this command fails for any reason (git errored out, output couldn't be read), log a warning and default to:
typescriptjavaFilesChangedSince = 0;
// Continue with flag computation using this default.
Note the asymmetry: a missing-commit failure returns immediately with -1. A diff failure defaults to 0 and continues. This is intentional — if the commit exists but git got confused about the diff, we'd rather show the manifest as "fresh" than falsely flag it as drifted. False drift warnings train users to ignore the freshness banner.
Computing the flag
Given ageDays and javaFilesChangedSince, determine the flag using these thresholds:
typescriptlet flag: 'fresh' | 'stale' | 'significantly_drifted';
if (ageDays <= 7 && javaFilesChangedSince <= 5) {
  flag = 'fresh';
} else if (ageDays <= 30 || javaFilesChangedSince <= 20) {
  flag = 'stale';
} else {
  flag = 'significantly_drifted';
}
Read the boolean logic carefully — the second condition uses OR, not AND. This is intentional. A manifest is stale if EITHER the age is under 30 days OR fewer than 20 files have changed since. Only when both are exceeded does it fall through to significantly_drifted.
The rationale: a manifest that's 40 days old but has only 3 file changes is stale (aged but the repo has been quiet — probably still accurate). A manifest that's 5 days old but has 50 file changes is also stale (young but the repo has churned). Only manifests that are BOTH aged AND churned are significantly drifted.
Assembling the result
typescriptreturn {
  ageDays,
  commit,
  javaFilesChangedSince,
  flag,
};

Error handling summary
The method NEVER throws. Every failure mode has a specific fallback:

Invalid manifestGeneratedAt (NaN from Date.parse) → ageDays = 0, continue.
Missing commit (rev-parse fails) → return early with javaFilesChangedSince = -1, flag = 'significantly_drifted', log warning.
Diff command fails (other reasons) → javaFilesChangedSince = 0, continue with flag computation, log warning.
execFile throws for reasons other than the above (e.g. git not installed) → log warning, return { ageDays, commit, javaFilesChangedSince: -1, flag: 'significantly_drifted' }.

Wrap the entire method body in a try/catch as an outer safety net that returns the "worst case" result if something completely unexpected happens.

Implementation shell
typescriptexport class FreshnessChecker {
  async check(
    repoRoot: string,
    manifestCommit: string,
    manifestGeneratedAt: string
  ): Promise<FreshnessInfo> {
    // Computation 1 — ageDays (pure)
    const generatedMs = Date.parse(manifestGeneratedAt);
    const ageDays = isNaN(generatedMs)
      ? 0
      : Math.max(0, Math.floor((Date.now() - generatedMs) / 86400000));

    // Computation 2 — commit (pure)
    const commit = manifestCommit.length >= 7 ? manifestCommit.substring(0, 7) : manifestCommit;

    // Computation 3 — javaFilesChangedSince (git)
    let javaFilesChangedSince: number;

    try {
      await execFileAsync('git', ['rev-parse', '--verify', `${manifestCommit}^{commit}`], {
        cwd: repoRoot,
      });
    } catch {
      console.warn(
        `FreshnessChecker: commit ${manifestCommit} not found in ${repoRoot}; treating as significantly_drifted.`
      );
      return { ageDays, commit, javaFilesChangedSince: -1, flag: 'significantly_drifted' };
    }

    try {
      const { stdout } = await execFileAsync(
        'git',
        ['diff', '--name-only', manifestCommit, 'HEAD', '--', '*.java'],
        { cwd: repoRoot }
      );
      javaFilesChangedSince = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0).length;
    } catch (err) {
      console.warn(
        `FreshnessChecker: git diff failed in ${repoRoot}: ${(err as Error).message}. Defaulting to 0 changed files.`
      );
      javaFilesChangedSince = 0;
    }

    // Flag computation
    let flag: 'fresh' | 'stale' | 'significantly_drifted';
    if (ageDays <= 7 && javaFilesChangedSince <= 5) {
      flag = 'fresh';
    } else if (ageDays <= 30 || javaFilesChangedSince <= 20) {
      flag = 'stale';
    } else {
      flag = 'significantly_drifted';
    }

    return { ageDays, commit, javaFilesChangedSince, flag };
  }
}
Use this shell verbatim as your starting point. Wrap the entire method body in an outer try/catch for defense-in-depth, returning { ageDays, commit, javaFilesChangedSince: -1, flag: 'significantly_drifted' } on any unexpected exception with a console.warn describing the failure.
Add JSDoc comments on the class and the check method explaining the intent and the two failure modes.

Do not

Do not throw. Every path returns a valid FreshnessInfo.
Do not use child_process.exec or execSync. Use the promisified execFile.
Do not use shell metacharacters in the git commands (the execFile form takes an array of arguments — no shell interpolation).
Do not fetch or pull from the remote. Only local git operations.
Do not modify the repo state.
Do not use fs — no file I/O in this module.
Do not consult the manifest itself. This module receives the two fields (manifestCommit and manifestGeneratedAt) as arguments; it does not read store.md.
Do not import from any file other than ../types.


Expected freshness matrix
For your reference — verify these produce the specified flags:
ageDaysjavaFilesChangedSinceexpected flag00fresh53fresh75fresh83stale (age > 7)58stale (files > 5)2510stale403stale (age > 30 but files ≤ 20)525stale (files > 5 but age ≤ 30)4525significantly_drifted (both exceeded)any-1significantly_drifted (missing commit special case)
Complete the file. This module is small (~60 lines with comments). Do not over-engineer.


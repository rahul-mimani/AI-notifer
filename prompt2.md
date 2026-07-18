Create a new file src/store/StoreWriter.ts that writes a repo's manifest to a store.md file, preserving human-written prose across regenerations and refusing to overwrite uncommitted changes without an explicit force flag. Types are defined in src/types.ts (currently open) — import StoreManifest from there.
Class shape:
Export a class StoreWriter with:

Constructor: no arguments.
Method: async write(manifest: StoreManifest, prosePreserved: string | null, repoRoot: string, options?: { force?: boolean }): Promise<void> — writes ${repoRoot}/store.md. Throws only on the specific StoreMdHasUncommittedChanges case (see below).

Imports:
typescriptimport * as fs from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as yaml from 'yaml';
import { StoreManifest } from '../types';

const execFileAsync = promisify(execFile);

File format
The output file ${repoRoot}/store.md must have exactly this structure, with the exact marker strings shown:
# store.md — <manifest.repo>

<!-- BEGIN AI-PROSE -->
<prose content>
<!-- END AI-PROSE -->

<!-- BEGIN MACHINE-READABLE -->
```yaml
<YAML serialization of manifest>
<!-- END MACHINE-READABLE -->

Rules:
- The header is exactly `# store.md — ${manifest.repo}` on a single line, followed by a blank line.
- Marker comments (`<!-- BEGIN AI-PROSE -->`, etc.) each occupy their own line.
- Between `<!-- BEGIN MACHINE-READABLE -->` and `<!-- END MACHINE-READABLE -->`, wrap the YAML in a fenced code block with `yaml` language tag.
- Sections are separated by exactly one blank line each.
- End the file with a single trailing newline.

---

## Behavior

1. **Determine target path**: `const storePath = path.join(repoRoot, 'store.md');`

2. **Uncommitted-changes check** (skip this step entirely if `options?.force === true`):
   - Check if the file exists (`fs.stat(storePath)` — catch `ENOENT`).
   - If it exists, run `git status --porcelain store.md` in `repoRoot` via `execFileAsync('git', ['status', '--porcelain', 'store.md'], { cwd: repoRoot })`.
   - Parse the output. If it's non-empty (any uncommitted change to `store.md`), throw an `Error`:
     ```typescript
     const err = new Error(
       `store.md at ${storePath} has uncommitted changes. ` +
       `Commit them or re-run with { force: true } to overwrite.`
     );
     err.name = 'StoreMdHasUncommittedChanges';
     throw err;
     ```
   - If the git command fails for other reasons (not a git repo, git not installed), log a warning to `console.warn` and continue — do not block writing.

3. **Determine prose content**:
   - If `prosePreserved` is a non-null string, use it verbatim.
   - If `prosePreserved` is `null` and the file exists, read the existing file and extract content between `<!-- BEGIN AI-PROSE -->` and `<!-- END AI-PROSE -->` markers. Trim leading/trailing whitespace but preserve internal formatting.
   - If `prosePreserved` is `null` and no existing prose can be extracted (file missing, markers absent, empty prose), use the default placeholder:
     ```
     _(No description yet — regenerate with AI Impact: Generate store.md)_
     ```

4. **Serialize the manifest as YAML** using `yaml.stringify(manifest)`. Do not add any options — use library defaults. The resulting string will already end with a newline; keep it as-is when interpolating.

5. **Assemble the full markdown content** as a single string using the exact template:
   ```typescript
   const content =
     `# store.md — ${manifest.repo}\n` +
     `\n` +
     `<!-- BEGIN AI-PROSE -->\n` +
     `${proseContent}\n` +
     `<!-- END AI-PROSE -->\n` +
     `\n` +
     `<!-- BEGIN MACHINE-READABLE -->\n` +
     `\`\`\`yaml\n` +
     `${yamlContent}` +
     `\`\`\`\n` +
     `<!-- END MACHINE-READABLE -->\n`;
(Adjust newline handling if yaml.stringify output does not end with a newline — ensure the closing fence appears on its own line.)

Write the file:

Use fs.writeFile(storePath, content, 'utf-8').
Ensure the parent directory exists (it will for the workspace root, but if repoRoot is somehow missing, throw a clear error).




Prose extraction helper (private method)
Add a private helper method for extracting prose from an existing file:
typescriptprivate extractExistingProse(fileContent: string): string | null {
  const beginMarker = '<!-- BEGIN AI-PROSE -->';
  const endMarker = '<!-- END AI-PROSE -->';
  const beginIdx = fileContent.indexOf(beginMarker);
  const endIdx = fileContent.indexOf(endMarker);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) return null;
  const prose = fileContent
    .substring(beginIdx + beginMarker.length, endIdx)
    .trim();
  return prose.length > 0 ? prose : null;
}

Do not:

Do not use the synchronous child_process.execSync — use the async execFile wrapper shown above.
Do not use child_process.exec (unsafer than execFile).
Do not add any extra fields to the output beyond what's specified.
Do not include timestamps in the header or comment blocks — the timestamp is inside the YAML (generatedAt).
Do not throw errors other than the specific StoreMdHasUncommittedChanges case. All other failures should be caught, logged via console.warn, and the operation should proceed (fail-safe writes) or propagate as a plain Error only if the file write itself fails.
Do not modify manifest — treat it as read-only.
Do not perform any AST parsing or Spring analysis in this file — this is a pure I/O module.


Example: expected file contents after a write
For a manifest like:
typescript{
  schemaVersion: 1,
  repo: 'CDU',
  generatedAt: '2026-07-18T10:00:00Z',
  generatedFromCommit: 'abc1234',
  provides: { endpoints: [], dtos: [], beans: [] },
  consumes: { httpCalls: [], beanInjections: [] }
}
with prosePreserved = 'This service manages customer records.', the output file should be exactly:
# store.md — CDU

<!-- BEGIN AI-PROSE -->
This service manages customer records.
<!-- END AI-PROSE -->

<!-- BEGIN MACHINE-READABLE -->
```yaml
schemaVersion: 1
repo: CDU
generatedAt: 2026-07-18T10:00:00Z
generatedFromCommit: abc1234
provides:
  endpoints: []
  dtos: []
  beans: []
consumes:
  httpCalls: []
  beanInjections: []
```
<!-- END MACHINE-READABLE -->
Complete the file. Write clean, focused code. Add brief comments only where behavior is non-obvious (prose preservation logic, git check semantics).
Create a new file src/store/StoreReader.ts that reads a repo's store.md file, extracts the machine-readable YAML block, parses it into a StoreManifest, validates it, and also extracts the human-written prose block. Types are defined in src/types.ts (currently open). The file format is written by src/store/StoreWriter.ts (also open) — the reader must match its output exactly.
Class shape:
Export a class StoreReader with:

Constructor: no arguments.
Method: async read(repoRoot: string): Promise<StoreReadResult> — reads ${repoRoot}/store.md and returns a structured result. Never throws; all errors are captured in the returned object.

Also export the result type:
typescriptexport interface StoreReadResult {
  manifest: StoreManifest | null;
  prose: string | null;
  error?: string;
}
Imports:
typescriptimport * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'yaml';
import { StoreManifest } from '../types';

Behavior
The read method must handle four cases in order:
Case 1 — file does not exist

Attempt to read ${repoRoot}/store.md with fs.readFile(storePath, 'utf-8').
Catch ENOENT specifically. On this error, return:
typescript{ manifest: null, prose: null, error: 'store.md not found' }

On any other read error, return:
typescript{ manifest: null, prose: null, error: `failed to read store.md: ${err.message}` }


Case 2 — file exists but machine-readable block is missing or malformed

Locate the block between <!-- BEGIN MACHINE-READABLE --> and <!-- END MACHINE-READABLE --> markers.
If either marker is missing, or the end marker appears before the begin marker, return:
typescript{ manifest: null, prose: <extracted prose or null>, error: 'machine-readable block missing or malformed' }

Extract the content between the markers.
Strip the surrounding fenced code block: the content should have opening ```yaml and closing ``` fences. Match a starting line of ```yaml (possibly with trailing whitespace) and a closing line of ```. Remove both fence lines and any leading/trailing whitespace-only lines.
If the fence markers are absent, treat the whole block content as YAML (be permissive here — the fence is a convention, not a hard requirement for parsing).

Case 3 — YAML parse failure

Attempt to parse the extracted YAML with yaml.parse(yamlContent).
Wrap in try/catch. On parse error, return:
typescript{ manifest: null, prose: <extracted prose or null>, error: `malformed YAML in manifest: ${err.message}` }


Case 4 — validation failure

After parsing, validate the object shape against StoreManifest. Requirements:

Must be a non-null object.
schemaVersion must be the literal number 1.
repo must be a non-empty string.
generatedAt must be a non-empty string.
generatedFromCommit must be a non-empty string.
provides must be a non-null object with array fields endpoints, dtos, beans (each defaulting to [] if missing — see repair below).
consumes must be a non-null object with array fields httpCalls, beanInjections (each defaulting to [] if missing).


If any required field is missing or wrong type, return:
typescript{ manifest: null, prose: <extracted prose or null>, error: `malformed manifest: <specific reason>` }
Include the specific missing/invalid field in the error message (e.g. "malformed manifest: schemaVersion must be 1").
Repair rule: if provides or consumes exists but is missing sub-array fields (e.g. provides.beans is undefined), fill in [] rather than failing. This is a compat courtesy — older manifests without bean support should still read. Do NOT repair missing top-level required fields (schemaVersion, repo, generatedAt, generatedFromCommit).
Do not validate the contents of the endpoints[], dtos[], beans[], httpCalls[], or beanInjections[] arrays — deep-shape validation is out of scope for v1. Assume the writer produced correct shapes.

Success case

Return:
typescript{ manifest: <validated manifest object cast as StoreManifest>, prose: <extracted prose> }

Omit the error field (do not set it to undefined explicitly — omit).


Prose extraction
Prose is extracted from the file whenever possible, even if the manifest fails to parse. Rules:

Locate content between <!-- BEGIN AI-PROSE --> and <!-- END AI-PROSE --> markers.
If either marker is missing, or the end marker appears before the begin marker, prose is null.
Otherwise, extract the content between the markers and trim leading/trailing whitespace.
If the trimmed content is empty, prose is null.
The prose is included in the result on all paths (success, YAML failure, validation failure) as long as it was successfully extracted. Only Case 1 (file missing) has prose: null unconditionally.

Add a private helper for this:
typescriptprivate extractProse(fileContent: string): string | null {
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

Machine-readable block extraction helper
Add a private helper for extracting and de-fencing the YAML block:
typescriptprivate extractYamlBlock(fileContent: string): { yaml: string | null; error?: string } {
  const beginMarker = '<!-- BEGIN MACHINE-READABLE -->';
  const endMarker = '<!-- END MACHINE-READABLE -->';
  const beginIdx = fileContent.indexOf(beginMarker);
  const endIdx = fileContent.indexOf(endMarker);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    return { yaml: null, error: 'machine-readable block missing or malformed' };
  }
  let block = fileContent
    .substring(beginIdx + beginMarker.length, endIdx)
    .trim();
  // Strip fence markers if present
  const lines = block.split('\n');
  if (lines.length >= 2 && lines[0].trim().startsWith('```') && lines[lines.length - 1].trim() === '```') {
    block = lines.slice(1, -1).join('\n');
  }
  return { yaml: block };
}

Validation helper
Add a private helper that validates the parsed object and returns either a valid StoreManifest or an error string:
typescriptprivate validateManifest(parsed: unknown): { manifest: StoreManifest | null; error?: string } {
  if (parsed === null || typeof parsed !== 'object') {
    return { manifest: null, error: 'manifest is not an object' };
  }
  const m = parsed as Record<string, unknown>;
  if (m.schemaVersion !== 1) return { manifest: null, error: 'schemaVersion must be 1' };
  if (typeof m.repo !== 'string' || m.repo.length === 0) return { manifest: null, error: 'repo must be a non-empty string' };
  if (typeof m.generatedAt !== 'string' || m.generatedAt.length === 0) return { manifest: null, error: 'generatedAt must be a non-empty string' };
  if (typeof m.generatedFromCommit !== 'string' || m.generatedFromCommit.length === 0) return { manifest: null, error: 'generatedFromCommit must be a non-empty string' };
  if (m.provides === null || typeof m.provides !== 'object') return { manifest: null, error: 'provides must be an object' };
  if (m.consumes === null || typeof m.consumes !== 'object') return { manifest: null, error: 'consumes must be an object' };
  // Repair missing sub-arrays
  const provides = m.provides as Record<string, unknown>;
  if (!Array.isArray(provides.endpoints)) provides.endpoints = [];
  if (!Array.isArray(provides.dtos)) provides.dtos = [];
  if (!Array.isArray(provides.beans)) provides.beans = [];
  const consumes = m.consumes as Record<string, unknown>;
  if (!Array.isArray(consumes.httpCalls)) consumes.httpCalls = [];
  if (!Array.isArray(consumes.beanInjections)) consumes.beanInjections = [];
  return { manifest: m as unknown as StoreManifest };
}

Error philosophy

read NEVER throws. All exceptions are caught and converted to an error string in the return value.
Prose extraction is attempted independently of manifest parsing. A file can have valid prose but broken YAML, and both facts should be reported.
Error messages should be specific enough for the caller to log or display to the user (e.g. "malformed manifest: schemaVersion must be 1" not just "invalid").

Do not:

Do not throw. Return an error string instead.
Do not import from child_process — StoreReader does no git operations.
Do not modify the file on disk.
Do not attempt to auto-repair fields beyond the specific provides/consumes sub-array defaults described.
Do not use any AST parsing or Spring-specific logic.

Complete the file. Write focused, clean code. Add brief comments only where the error-handling flow or repair logic is non-obvious.
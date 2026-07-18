Create a new file src/severity/SeverityScorer.ts that assigns a final consumer-facing status (breaking, review_recommended, safe, unknown) to a change based on its intrinsic severity, the coupling type, and how confidently the consumer is known to use the affected target. This is a pure, deterministic rule-table function — no LLM, no I/O. It runs after the matcher has correlated changes to consumer usage.
Types are defined in src/types.ts (currently open). Import ChangeEvent and any relevant literal unions from there.
Class shape:
Export a class SeverityScorer with one public method:
typescriptscore(input: ScorerInput): ScorerResult;
Also export these types in the same file:
typescriptexport interface ScorerInput {
  change: ChangeEvent;
  coupling: 'http' | 'bean';
  usedTargetConfidence: 'declared' | 'inferred' | 'unknown' | null;
}

export interface ScorerResult {
  status: 'breaking' | 'review_recommended' | 'safe' | 'unknown';
  reasoning: string[];
}
Imports:
typescriptimport { ChangeEvent } from '../types';

The usedTargetConfidence field — what it means
Before defining the rules, understand the three confidence levels:

'declared' — the consumer's store.md explicitly declares this field or method as used, extracted directly from source code (a literal response.fieldName access, a field.methodName(...) call, or a Feign method binding). High trust.
'inferred' — an LLM decided the consumer probably uses this target based on surrounding code. Never asserted as fact.
'unknown' — the parser saw a call site but could not determine which fields/methods are used (e.g. the response flows through a mapper).
null — the matcher found no correlation at all. The consumer touches this surface (endpoint/bean) but not this specific field/method — or the consumer doesn't touch this surface at all.

The precision principle: only 'declared' usage against a 'breaking' change may produce a 'breaking' status. Everything else is either 'safe' (no usage, no impact) or 'review_recommended' (usage exists but confidence is soft, or the change is potentially rather than definitely breaking).

The rule table
Apply the following rules in this exact precedence order. Return on the first match. Each rule produces a status and a reasoning: string[] that explains WHY. The reasoning array is used by the UI to display "why HIGH" or "why safe" to owners.
Rule 1 — Additive changes are always safe
If input.change.severity === 'additive':
typescriptreturn { status: 'safe', reasoning: ['change_is_additive'] };
An additive change (endpoint added, non-required field added, additive bean method) cannot break existing consumers. Return 'safe' regardless of anything else.
Rule 2 — No consumer usage means no impact
If input.usedTargetConfidence === null:
typescriptreturn { status: 'safe', reasoning: ['consumer_does_not_use_this_surface'] };
The matcher would only pass null when the correlation found no field-level or method-level usage of the changed target. A breaking change on unused surface is safe for that consumer.
Rule 3 — Declared usage + breaking change = breaking
If input.usedTargetConfidence === 'declared' AND input.change.severity === 'breaking':
typescriptreturn { status: 'breaking', reasoning: ['declared_usage', 'breaking_change'] };
High confidence in consumer usage + high confidence in breaking severity = a real break. Report as breaking.
Rule 4 — Inferred usage + breaking change = review recommended
If input.usedTargetConfidence === 'inferred' AND input.change.severity === 'breaking':
typescriptreturn { status: 'review_recommended', reasoning: ['inferred_usage', 'breaking_change'] };
The AI thinks the consumer uses this target but wasn't certain. Never assert this as a hard "you broke Payments" — it's a review_recommended.
Rule 5 — Unknown usage + breaking change = review recommended
If input.usedTargetConfidence === 'unknown' AND input.change.severity === 'breaking':
typescriptreturn { status: 'review_recommended', reasoning: ['unknown_usage_confidence', 'breaking_change'] };
Parser saw usage exists but couldn't resolve to specific fields/methods. Same treatment as inferred — never hard-assert breaking.
Rule 6 — Potentially breaking changes with any usage
If input.change.severity === 'potentially_breaking':
Compute the confidence tag:

If usedTargetConfidence === 'declared' → 'confidence_declared'
If usedTargetConfidence === 'inferred' → 'confidence_inferred'
If usedTargetConfidence === 'unknown' → 'confidence_unknown'
If usedTargetConfidence === null → 'confidence_null' (should be unreachable given rule 2, but include for robustness)

Then:
typescriptreturn {
  status: 'review_recommended',
  reasoning: ['potentially_breaking_change', <confidenceTag>]
};
Potentially breaking changes (bean rename, qualifier change, condition tightened) never produce a hard breaking verdict even at declared confidence — the change itself is ambiguous.
Rule 7 — Fallback
If none of the above matched:
typescriptreturn { status: 'unknown', reasoning: ['no_matching_rule'] };
This should not fire in practice — the six rules above exhaust the valid combinations of severity ∈ {breaking, potentially_breaking, additive} × usedTargetConfidence ∈ {declared, inferred, unknown, null}. But include it as a safety net so a future addition to the change taxonomy doesn't silently produce garbage results.

Reasoning array — format
The reasoning array is a list of short snake_case tags. The UI treats each tag as a chip or badge. Rules for authoring tags:

Lowercase snake_case.
Each tag should stand alone as a fragment: declared_usage, breaking_change, not has_declared_usage_which_indicates_breaking.
Order doesn't matter functionally, but the rule table above defines the canonical order — preserve it.
Never include values that vary per call (like a field name or file path). Reasoning tags are categorical labels, not per-instance details.


Implementation shell
typescriptexport class SeverityScorer {
  score(input: ScorerInput): ScorerResult {
    const { change, usedTargetConfidence } = input;

    // Rule 1
    if (change.severity === 'additive') {
      return { status: 'safe', reasoning: ['change_is_additive'] };
    }

    // Rule 2
    if (usedTargetConfidence === null) {
      return { status: 'safe', reasoning: ['consumer_does_not_use_this_surface'] };
    }

    // Rule 3
    if (usedTargetConfidence === 'declared' && change.severity === 'breaking') {
      return { status: 'breaking', reasoning: ['declared_usage', 'breaking_change'] };
    }

    // Rule 4
    if (usedTargetConfidence === 'inferred' && change.severity === 'breaking') {
      return { status: 'review_recommended', reasoning: ['inferred_usage', 'breaking_change'] };
    }

    // Rule 5
    if (usedTargetConfidence === 'unknown' && change.severity === 'breaking') {
      return { status: 'review_recommended', reasoning: ['unknown_usage_confidence', 'breaking_change'] };
    }

    // Rule 6
    if (change.severity === 'potentially_breaking') {
      const confidenceTag =
        usedTargetConfidence === 'declared' ? 'confidence_declared' :
        usedTargetConfidence === 'inferred' ? 'confidence_inferred' :
        'confidence_unknown';
      return {
        status: 'review_recommended',
        reasoning: ['potentially_breaking_change', confidenceTag]
      };
    }

    // Rule 7 — fallback
    return { status: 'unknown', reasoning: ['no_matching_rule'] };
  }
}
Use this shell verbatim as your starting point. Add JSDoc comments above the class and above score() explaining the intent.

Do not

Do not read input.coupling. The http vs bean distinction is metadata for downstream display, not scoring input. It's present in the input type for future rules but the current rule table does not consult it. Do not add any conditional on it.
Do not read change.kind. The kind field (like DTO_FIELD_REMOVED vs BEAN_METHOD_REMOVED) is metadata for the UI. The scoring is driven only by change.severity and usedTargetConfidence. Adding kind-specific rules leaks scoring logic out of the diff engine, where severity is already decided.
Do not read change.riskFlags. Same principle — flags exist for the UI. If they need to influence severity, the diff engine should have set change.severity accordingly.
Do not import from any file other than ../types.
Do not throw. This is pure logic over a well-defined input space.
Do not add configuration, external rule loading, or plugin points. The rule table is intentionally hard-coded — auditability matters more than flexibility in v1.


Expected scoring for representative cases
To sanity-check your implementation, verify these produce the specified results:
severityconfidenceexpected statusreasoningadditivedeclaredsafe['change_is_additive']additivenullsafe['change_is_additive']breakingnullsafe['consumer_does_not_use_this_surface']breakingdeclaredbreaking['declared_usage', 'breaking_change']breakinginferredreview_recommended['inferred_usage', 'breaking_change']breakingunknownreview_recommended['unknown_usage_confidence', 'breaking_change']potentially_breakingdeclaredreview_recommended['potentially_breaking_change', 'confidence_declared']potentially_breakinginferredreview_recommended['potentially_breaking_change', 'confidence_inferred']potentially_breakingnullsafe['consumer_does_not_use_this_surface']
Note the last row: rule 2 fires before rule 6, so null confidence always short-circuits to safe regardless of severity type.
Complete the file. Keep it small — this module is roughly 50 lines including comments and type exports. Do not over-engineer.
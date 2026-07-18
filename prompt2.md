Create a new file src/diff/DiffEngine.ts that computes ChangeEvent[] by comparing two SurfaceSet values — one representing the "before" state (git base) and one representing the "after" state (working tree). This is the diff step: pure function, no I/O, no LLM, no scoring. Deterministic and trivially testable.
Types are defined in src/types.ts (currently open). Path normalization exists in src/matcher/PathNormalizer.ts (also open) but is NOT needed here — endpoint IDs are already normalized upstream by the extractors and matcher.
Class shape:
Export a class DiffEngine with one public method:
typescriptdiff(from: SurfaceSet, to: SurfaceSet): ChangeEvent[];
No constructor arguments, no shared state, no async.
Imports:
typescriptimport * as crypto from 'crypto';
import {
  SurfaceSet,
  ChangeEvent,
  ChangeKind,
  RestEndpoint,
  DtoType,
  DtoField,
  BeanDefinition,
  MethodSignature,
} from '../types';

Algorithm — three independent sub-diffs
Run these three sub-diffs sequentially and concatenate their results into one flat ChangeEvent[]. Each ChangeEvent gets a unique id via crypto.randomUUID().

Sub-diff 1 — Endpoints
Keys: RestEndpoint.id (format ${method}:${path}).
Build two maps: fromById: Map<string, RestEndpoint> from from.provides.endpoints, and toById from to.provides.endpoints.
For each id in fromById but not in toById:

Emit ENDPOINT_REMOVED, severity: 'breaking', surfaceKind: 'endpoint', surfaceId: id.
before: <the RestEndpoint object>, after: null.
riskFlags: [].

For each id in toById but not in fromById:

Emit ENDPOINT_ADDED, severity: 'additive', surfaceKind: 'endpoint', surfaceId: id.
before: null, after: <the RestEndpoint object>.
riskFlags: [].

For each id present in both (common):

The id already encodes method + path, so if the id matches, method and path are identical by construction.
Compare responseType. If different, this is meaningful but for v1 we do NOT emit a separate event — response type changes on the same endpoint are captured by the DTO sub-diff if the type is a DTO. Skip for now.
Do NOT emit ENDPOINT_METHOD_CHANGED here — same-id endpoints have the same method by definition. That change kind exists in the taxonomy for future use (e.g. when we identify moved endpoints); leave it unused in v1.


Sub-diff 2 — DTOs
Keys: DtoType.fqName.
Build two maps: fromByFqName and toByFqName from from.provides.dtos and to.provides.dtos.
For each fqName in both:

Compare fields.
Build fromFieldsByName: Map<string, DtoField> from fromDto.fields, and same for toDto.

Removed and added fields (initial pass):
Collect two arrays:

removedFields: fields in fromFieldsByName but not in toFieldsByName.
addedFields: fields in toFieldsByName but not in fromFieldsByName.

Rename heuristic pass:
Within these two arrays for this single DTO:

If removedFields.length === 1 AND addedFields.length === 1 AND their type strings are equal, treat this as a rename:

Emit one DTO_FIELD_RENAMED, severity: 'breaking', surfaceKind: 'dto'.
surfaceId: "${fqName}.${addedField.name}" (use the new name).
before: <the removed field object>, after: <the added field object>.
riskFlags: ['renamed_from:' + removedField.name].
Then clear both arrays (do not emit the individual add/remove events).



Emit remaining removed fields:
For each remaining removedField:

Emit DTO_FIELD_REMOVED, severity: 'breaking', surfaceKind: 'dto'.
surfaceId: "${fqName}.${removedField.name}".
before: <the removed field>, after: null.
riskFlags: [].

Emit remaining added fields:
For each remaining addedField:

If addedField.required === true:

Emit DTO_FIELD_ADDED, severity: 'breaking', surfaceKind: 'dto'.
riskFlags: ['required_field_added'].


Else:

Emit DTO_FIELD_ADDED, severity: 'additive', surfaceKind: 'dto'.
riskFlags: [].


surfaceId: "${fqName}.${addedField.name}".
before: null, after: <the added field>.

Common fields (name present in both):
For each field name present in both fromFieldsByName and toFieldsByName:

fromField and toField.
Type change: if fromField.type !== toField.type:

Emit DTO_FIELD_TYPE_CHANGED, severity: 'breaking', surfaceKind: 'dto'.
surfaceId: "${fqName}.${fieldName}".
before: <fromField>, after: <toField>.
riskFlags: [].


Required-ness tightened: if fromField.required === false AND toField.required === true:

Emit DTO_FIELD_REQUIREDNESS_CHANGED, severity: 'breaking', surfaceKind: 'dto'.
surfaceId: "${fqName}.${fieldName}".
before: <fromField>, after: <toField>.
riskFlags: ['became_required'].


A single field can emit both events if both changed (type change AND required-ness change) — emit them as separate ChangeEvents.
If required-ness went from true to false (relaxation), do NOT emit any event — that's not breaking.

Note on newly-added DTOs and removed DTOs:

If a DTO is in to but not from (added type): do NOT emit events. The DTO isn't a consumer surface on its own — only its use in an endpoint/bean matters. This is intentional; downstream matcher handles the correlation.
If a DTO is in from but not to (removed type): do NOT emit events for the same reason. If the DTO was used as a response type on a removed endpoint, that's already captured by ENDPOINT_REMOVED.


Sub-diff 3 — Beans
Keys: BeanDefinition.name.
Build two maps: fromByName and toByName from from.provides.beans and to.provides.beans.
Collect:

removedBeans: names in from but not in to.
addedBeans: names in to but not in from.

Rename heuristic pass:
For each pair of one removed and one added bean where removedBean.type === addedBean.type:

Emit BEAN_RENAMED, severity: 'potentially_breaking', surfaceKind: 'bean'.
surfaceId: <newBeanName>.
before: <removedBean>, after: <addedBean>.
riskFlags: ['renamed_from:' + removedBean.name].
Remove both from the pending arrays.

Note: unlike DTO rename which requires exactly 1-and-1, bean rename can match multiple pairs. Iterate removedBeans and greedily pair with any addedBean sharing the same type. Once paired, remove both.
Emit remaining removed beans:
For each remaining removedBean:

Emit BEAN_REMOVED, severity: 'breaking', surfaceKind: 'bean'.
surfaceId: <beanName>.
before: <removedBean>, after: null.
riskFlags: [].

Emit remaining added beans:
For each remaining addedBean:

Emit BEAN_ADDED, severity: 'additive', surfaceKind: 'bean'.
surfaceId: <beanName>.
before: null, after: <addedBean>.
riskFlags: [].

Common beans (name in both):
For each bean name in both:

Compare qualifiers arrays. If not deep-equal (same length, same strings, same order), emit:

BEAN_QUALIFIER_CHANGED, severity: 'potentially_breaking', surfaceKind: 'bean'.
surfaceId: <beanName>.
before: <fromBean>, after: <toBean>.
riskFlags: [].


Compare conditionals arrays. If toBean.conditionals contains any string NOT present in fromBean.conditionals (new conditional added), emit:

BEAN_CONDITIONAL_TIGHTENED, severity: 'potentially_breaking', surfaceKind: 'bean'.
surfaceId: <beanName>.
before: <fromBean>, after: <toBean>.
riskFlags: [].
Do NOT emit if conditionals were REMOVED (that's a relaxation, not a tightening).


Compare publicMethods arrays. Build maps keyed by method name:

fromMethodsByName, toMethodsByName.
For each method name in from but not to:

Emit BEAN_METHOD_REMOVED, severity: 'breaking', surfaceKind: 'bean'.
surfaceId: "${beanName}#${methodName}".
before: { type: fromBean.type, method: <fromMethod> }, after: null.
riskFlags: [].
Note: for bean method events, before.type and after.type MUST include the bean's FQN type. The matcher relies on this to correlate against BeanInjection.providerType.


For each method name in to but not from:

Emit BEAN_METHOD_ADDED, severity: 'additive', surfaceKind: 'bean'.
surfaceId: "${beanName}#${methodName}".
before: null, after: { type: toBean.type, method: <toMethod> }.
riskFlags: [].


For each method name in both:

Compare signatures. If returnType differs OR parameters arrays differ (compare by index, comparing each param's type; parameter names are not part of the signature contract), emit:

BEAN_METHOD_SIGNATURE_CHANGED, severity: 'breaking', surfaceKind: 'bean'.
surfaceId: "${beanName}#${methodName}".
before: { type: fromBean.type, method: <fromMethod> }, after: { type: toBean.type, method: <toMethod> }.
riskFlags: [].








Utility helpers (private, top-level in file)
Add these small helpers as non-exported functions in the same file:
typescriptfunction arraysDeepEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function methodSignaturesEqual(a: MethodSignature, b: MethodSignature): boolean {
  if (a.returnType !== b.returnType) return false;
  if (a.parameters.length !== b.parameters.length) return false;
  for (let i = 0; i < a.parameters.length; i++) {
    if (a.parameters[i].type !== b.parameters[i].type) return false;
  }
  return true;
}

function makeMap<T, K>(arr: T[], keyFn: (t: T) => K): Map<K, T> {
  const m = new Map<K, T>();
  for (const item of arr) m.set(keyFn(item), item);
  return m;
}

function makeEvent(
  kind: ChangeKind,
  surfaceKind: 'endpoint' | 'dto' | 'bean',
  surfaceId: string,
  severity: 'breaking' | 'potentially_breaking' | 'additive',
  before: unknown,
  after: unknown,
  riskFlags: string[]
): ChangeEvent {
  return {
    id: crypto.randomUUID(),
    kind,
    surfaceKind,
    surfaceId,
    severity,
    before,
    after,
    riskFlags,
  };
}

Do not

Do not perform any I/O.
Do not throw. If the input is malformed (missing arrays, wrong shapes), fall back gracefully — treat missing arrays as empty and continue.
Do not sort the output.
Do not deduplicate — every rule fires independently, and it's the scorer's job to interpret precedence.
Do not mutate from or to.
Do not invent additional change kinds beyond the ChangeKind union in types.ts.
Do not attempt cross-surface reasoning (e.g. "this endpoint uses this DTO, so ..."). That's the correlator's job.
Do not emit events for added or removed DTO types — only for fields within DTOs that exist on both sides.


Return
Return a single flat ChangeEvent[] containing all events from all three sub-diffs, in insertion order (endpoints first, then DTOs, then beans). Do not sort.
Complete the file. Write clean, readable code with each sub-diff clearly delimited by section comments. Prefer small helpers over long inline logic.
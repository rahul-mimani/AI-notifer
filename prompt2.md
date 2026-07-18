Create a new file src/matcher/Matcher.ts that joins provider-side ChangeEvents against consumer-side StoreManifest entries to produce matched pairs. This is the correlation step — no scoring, no LLM, no narrative. Just: "for this change on the provider, which consumer call sites and injection points are affected?"

Types are defined in src/types.ts (currently open). Path normalization is in src/matcher/PathNormalizer.ts (also open). StoreManifest shape reference is in src/store/StoreReader.ts (also open). Import from those files as needed.

Class shape:

Export a class Matcher with two public methods, no shared state:

typescriptmatchHttp(
  changes: ChangeEvent[],
  consumerManifest: StoreManifest
): HttpMatch[];

matchBean(
  changes: ChangeEvent[],
  consumerManifest: StoreManifest
): BeanMatch[];

Also export these result types:

typescriptexport interface HttpMatch {
  change: ChangeEvent;
  callSite: HttpCallSite;
  usedField: UsedField | null;
}

export interface BeanMatch {
  change: ChangeEvent;
  injection: BeanInjection;
  calledMethod: CalledMethod | null;
}

Imports:

typescriptimport {
  ChangeEvent,
  StoreManifest,
  HttpCallSite,
  UsedField,
  BeanInjection,
  CalledMethod,
} from '../types';
import { normalizePath } from './PathNormalizer';


matchHttp — HTTP coupling

Iterate changes. For each change, determine whether it targets an HTTP surface (endpoint-level or DTO-field-level where the DTO is used as a response type by a consumer call site). Skip anything else.

Two categories of HTTP-relevant change

Category 1 — endpoint-level changes. change.surfaceKind === 'endpoint'.

The surfaceId is formatted as ${method}:${normalizedPath}, e.g. "GET:/customer/{}".

For each such change:


Split surfaceId on the first : to get changeMethod and changePath.
Normalize changePath via normalizePath(changePath, 'provider').
Iterate consumerManifest.consumes.httpCalls. For each callSite:

Skip if callSite.method !== changeMethod.
Normalize callSite.path via normalizePath(callSite.path, 'consumer').
If the normalized paths are equal (string equality after both normalizations), emit:
typescript{ change, callSite, usedField: null }





usedField is always null for endpoint-level matches — the whole endpoint is affected, not a specific field.


Category 2 — DTO field-level changes. change.surfaceKind === 'dto'.

The surfaceId for these events is formatted as ${dtoFqName}.${fieldName}, e.g. "com.example.cdu.dto.CustomerResponse.phone".

For each such change:


Split the surfaceId on the last . to get dtoFqName and changedFieldName.

Use lastIndexOf('.') — the FQN itself contains dots.



Extract the simple name of the DTO from dtoFqName — everything after the final . of the package part. For "com.example.cdu.dto.CustomerResponse" → "CustomerResponse".
Iterate consumerManifest.consumes.httpCalls. For each callSite:

Skip unless callSite.responseType equals the DTO simple name OR the FQN (best-effort — consumer manifests may store either form).
Iterate callSite.usedFields. For each usedField:

Check whether usedField.path ends with .${changedFieldName} (case-sensitive). Also match the exact string "response.${changedFieldName}" explicitly — this is the canonical form the extractor emits.
If matched, emit:
typescript{ change, callSite, usedField }





If no usedField matched, do NOT emit a bare { change, callSite, usedField: null } for a DTO-field-level change — the consumer doesn't use the changed field, so it's not affected. This is intentional: it's the precision guardrail. Only emit when there's a concrete field-use match.





Aggregation and return


Return a flat array of all HttpMatch entries produced.
Order is not significant; iteration order (changes × callSites × usedFields) is fine.
Do not deduplicate across changes — the same callSite may legitimately match multiple changes.



matchBean — bean coupling

Iterate changes. For each change with change.surfaceKind === 'bean', correlate against consumerManifest.consumes.beanInjections.

Two categories of bean-relevant change

Category 1 — bean-level changes. change.kind is one of:


BEAN_ADDED — skip (additive, no impact on existing consumers)
BEAN_REMOVED
BEAN_RENAMED
BEAN_QUALIFIER_CHANGED
BEAN_CONDITIONAL_TIGHTENED


The surfaceId for bean-level events is the bean name (e.g. "customerService"). The bean's type (FQN of the class or return type) is stored in change.before and/or change.after — access via (change.before as any)?.type or the equivalent from after.

For each such change:


Extract beanType = (change.before as { type?: string })?.type ?? (change.after as { type?: string })?.type. If neither exists or beanType is empty, skip this change (defensive — should not happen with well-formed events).
Iterate consumerManifest.consumes.beanInjections. For each injection:

If injection.providerType === beanType, emit:
typescript{ change, injection, calledMethod: null }





calledMethod is always null for bean-level matches.


Category 2 — bean-method-level changes. change.kind is one of:


BEAN_METHOD_ADDED — skip (additive)
BEAN_METHOD_REMOVED
BEAN_METHOD_SIGNATURE_CHANGED


The surfaceId for these events is formatted as ${beanName}#${methodName}, e.g. "customerService#getById". The bean's type is in change.before or change.after.

For each such change:


Split surfaceId on # to get beanName and changedMethodName.
Extract beanType from change.before or change.after as above. Skip if unavailable.
Iterate consumerManifest.consumes.beanInjections. For each injection:

Skip unless injection.providerType === beanType.
Iterate injection.calledMethods. For each calledMethod:

Extract the method name from calledMethod.signature. The signature format is "methodName(...)" (e.g. "getById(...)"). Use a regex /^([A-Za-z_$][\w$]*)/ on the signature to capture the leading identifier.
If the extracted method name equals changedMethodName (exact string match), emit:
typescript{ change, injection, calledMethod }





Do NOT emit a bare { change, injection, calledMethod: null } when method-level and no method matched — same precision rule as the DTO field case. Only emit when there's a concrete method-use match.





Aggregation and return


Return a flat array of all BeanMatch entries.
No deduplication across changes.



Error handling


Neither method throws. Wrap the outer loop of each in try/catch. On unexpected exceptions during a single change's processing, log via console.warn with the change id and error message, then continue with the next change.
Skipping a change silently on well-defined cases (additive kinds, missing type info) is normal flow — no warning needed.



Do not


Do not perform severity scoring. That's a separate module.
Do not call the LLM.
Do not normalize paths inline — always go through the imported normalizePath function.
Do not mutate changes, consumerManifest, or any nested structures.
Do not emit matches for _ADDED change kinds (additive changes have no consumer breakage).
Do not emit fallback null-usedField or null-calledMethod matches for field-level or method-level changes. Precision requires a concrete match.
Do not import from child_process, fs, or any I/O module.



Expected behavior sketch

Given a change:

typescript{
  id: 'c1',
  kind: 'DTO_FIELD_REMOVED',
  surfaceKind: 'dto',
  surfaceId: 'com.example.cdu.dto.CustomerResponse.phone',
  severity: 'breaking',
  before: { name: 'phone', type: 'String' },
  after: null,
  riskFlags: []
}

And a consumer manifest whose consumes.httpCalls includes:

typescript{
  provider: 'cdu-service',
  method: 'GET',
  path: '/customer/{}',
  responseType: 'CustomerResponse',
  usedFields: [
    { path: 'response.phone', confidence: 'declared' },
    { path: 'response.name', confidence: 'declared' }
  ],
  file: 'PouService.java',
  line: 47
}

matchHttp should return exactly one HttpMatch:

typescript{
  change: <the above change>,
  callSite: <the above callSite>,
  usedField: { path: 'response.phone', confidence: 'declared' }
}

If the changed field were unused instead, no match should be emitted — the consumer doesn't read unused.

Complete the file. Write focused, testable code. Use small private helpers for the "extract bean type from change" and "extract method name from signature" operations. Keep the two match methods symmetric in structure.
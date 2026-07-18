Create a new file src/matcher/PathNormalizer.ts that exports a pure function for normalizing HTTP path strings into a single canonical form. This is the single point where cross-repo path joins happen — provider paths (from Spring annotations) and consumer paths (from URL literals, concatenations, and String.format calls) must both normalize to the same canonical shape so the matcher can join them by string equality.

This module has no dependencies on any other file in the project. It does not import from src/types.ts — but keeping that file open gives Copilot the domain context.

Exports:

typescriptexport function normalizePath(path: string, kind: 'provider' | 'consumer'): string;

No class. No default export. Just the one named function.


Canonical form

The output of normalizePath is a plain path string where:


All variable segments are represented as the literal three-character sequence {}.
No trailing slash (unless the entire path is just /).
No query string.
Case is preserved.


Examples of the canonical form:


/customer/{}
/orders/{}/items
/api/v1/customer/{}/orders/{}
/customer (no variables)
/ (root path)
"" (empty input, empty output)



Rules for both kinds

Applied before kind-specific processing:


If the input contains ?, discard everything from the first ? onward.
Strip trailing whitespace.
Case-sensitive throughout — do not lowercase.


Applied after kind-specific processing:


Strip the trailing / unless the entire result is /.



Provider kind

Input is the path as written in a Spring annotation. Convert any {anyName} segment to {}.

Examples:


"/customer/{id}" → /customer/{}
"/orders/{orderId}/items" → /orders/{}/items
"/orders/{orderId}/items/{itemId}" → /orders/{}/items/{}
"/customer" → /customer
"/" → /
"" → ""
"/customer?foo=bar" → /customer (query stripped)
"/x/" → /x (trailing slash stripped)


Implement with a regex: replace /\{[^}]+\}/g with {}. The character class inside must reject } to avoid greedy matching across segments.


Consumer kind

Input is the raw path/URL fragment as it appeared in the consumer source code. This can be any of these shapes because the HttpCallSiteExtractor may pass through several forms. Handle each:

Shape 1 — already templated with Spring-style braces:


"/customer/{id}" → /customer/{}
Same rule as provider.


Shape 2 — string concatenation as a literal source fragment:


'"/customer/" + id' → /customer/{}
'"/customer/" + var + "/items"' → /customer/{}/items
'"/customer/" + a + "/orders/" + b' → /customer/{}/orders/{}


Algorithm:


Split the input on the + operator.
For each piece, trim whitespace.
If the piece starts and ends with ", it's a string literal — take its inner content.
Otherwise, it's a variable or expression — replace with {}.
Concatenate all pieces.


Shape 3 — String.format call as a literal source fragment:


'String.format("/customer/%s", var)' → /customer/{}
'String.format("/customer/%d/orders/%s", a, b)' → /customer/{}/orders/{}
'"/customer/%s"' (a lone format template) → /customer/{}


Algorithm:


Detect String.format(...) syntax with a regex like /^String\.format\(\s*"([^"]+)"/. Extract the format string inside the first argument.
If not a String.format call but the input contains % format specifiers inside quotes, still process the specifiers.
Replace every occurrence of % followed by a single letter (from the set s, d, f, x, b, c, o, e, g, n — cover the common Java format specifiers) with {}. Use regex /%[sdfxbcoegn]/g.
Also handle width specifiers like %3d or %.2f: extend the regex to /%[-+#0-9.]*[sdfxbcoegn]/g.


Shape 4 — plain string literal already stripped of quotes:


"/customer/{id}" (arrived without quotes) → /customer/{}
This is the same as Shape 1 or provider.


Shape 5 — bare quoted string like '"/customer/x"':


The input starts and ends with ". Strip quotes, then process normally.



URL-to-path stripping

If the input (after any of the above processing) starts with a scheme like http:// or https://, strip the scheme and host:


Locate :// in the string.
After ://, find the next /. Everything from that / onward is the path.
If there is no / after the host, the path is /.


Apply this after shape-specific processing but before the trailing-slash strip. This handles cases where the extractor passed a full URL by accident.


Detection heuristics for consumer shape

Since the caller doesn't tell you which shape the input is, detect in order:


If input contains String.format( — Shape 3.
Else if input contains + with " characters — Shape 2.
Else if input contains % format specifiers — Shape 3 (lone format template).
Else if input starts and ends with " — Shape 5 (strip quotes and recurse).
Else — Shape 1/4 (treat as plain path with possible {name} variables).



Implementation shell

typescriptexport function normalizePath(path: string, kind: 'provider' | 'consumer'): string {
  if (typeof path !== 'string') return '';

  // Step 1: strip query string
  let p = path.split('?')[0].trimEnd();

  // Step 2: kind-specific processing
  if (kind === 'provider') {
    p = p.replace(/\{[^}]+\}/g, '{}');
  } else {
    p = normalizeConsumerPath(p);
  }

  // Step 3: strip scheme and host if URL
  p = stripSchemeAndHost(p);

  // Step 4: strip trailing slash (unless root)
  if (p.length > 1 && p.endsWith('/')) {
    p = p.slice(0, -1);
  }

  return p;
}

Add the helpers normalizeConsumerPath(input: string): string and stripSchemeAndHost(input: string): string as private (non-exported) top-level functions in the same file. Keep each helper small and focused.


Edge cases to handle explicitly


Empty string input → empty string output.
Input of just / → / (do not strip to empty).
Input with only variables, no static segments ("{id}") → {}.
Multiple consecutive slashes ("/x//y") → collapse is NOT required for v1; leave as-is.
Windows-style backslashes → do NOT convert; treat backslash as any other character.
Whitespace inside the path ("/customer /{id}") → preserve verbatim (don't try to clean).



Do not:


Do not import anything from other project files.
Do not export any additional utilities or types.
Do not throw on any input. Non-string inputs return "".
Do not lowercase, uppercase, or otherwise transform case.
Do not attempt to parse the input as a URL with new URL(...) — the input is often malformed source-code fragments, not real URLs.
Do not attempt to canonicalize . or .. segments.


Complete the file. Write focused, well-commented code. This module is the single point where cross-repo joins can silently fail — clarity and correctness matter more than brevity.
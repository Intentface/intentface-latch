/**
 * OAuth scope parsing and comparison.
 *
 * A scope is a SET, not a sequence (RFC 6749 §3.3: "the value of the scope
 * parameter is expressed as a list of space-delimited... strings", with no
 * ordering semantics). So `"a b"` and `"b a"` request exactly the same thing,
 * and anything that reacts to a scope *change* has to compare them as sets —
 * otherwise merely reordering the field looks like a change.
 *
 * That matters here because the reaction is expensive and user-visible: a scope
 * change clears the stored token to force re-consent (see `saveConnectionFn`).
 * Comparing positionally would log a user out of a connection for retyping the
 * same permissions in a different order.
 */

/** Split a space-separated scope string, dropping blanks and duplicates. */
export function parseScopes(input?: string): string[] | undefined {
  if (!input) return undefined;
  const seen = new Set<string>();
  for (const scope of input.split(/\s+/)) {
    if (scope) seen.add(scope);
  }
  return seen.size > 0 ? [...seen] : undefined;
}

/**
 * Whether two scope lists request the same permissions.
 *
 * Order-insensitive and duplicate-insensitive. Absent and empty are equivalent:
 * both mean "request no scope".
 */
export function sameScopeSet(a?: string[], b?: string[]): boolean {
  const left = new Set(a ?? []);
  const right = new Set(b ?? []);
  if (left.size !== right.size) return false;
  for (const scope of left) {
    if (!right.has(scope)) return false;
  }
  return true;
}

import type { EvalCase, EvalToolCall } from "./store";

/**
 * Conservative ReDoS guard for author-supplied assertion regexes: reject a
 * quantified group whose body itself contains a quantifier or alternation —
 * the repetition-of-repetition shape behind catastrophic backtracking (e.g.
 * `(a+)+$`, `(a|aa)*`). Errs on the safe side (some harmless patterns are
 * rejected); eval assertions rarely need nesting, and authors can restructure.
 * Applied at save-time (save_eval_set rejects) AND at grade time (defense in
 * depth for pre-existing stored patterns).
 */
export function isRiskyRegex(source: string): boolean {
  if (source.length > 200) return true;
  const quantifiedGroup = /\((?:[^()\\]|\\.)*[+*{|](?:[^()\\]|\\.)*\)\??[+*{]/;
  return quantifiedGroup.test(source);
}

/** Regexes only see a bounded slice — with nesting rejected, matching stays cheap. */
const REGEX_INPUT_CAP = 5_000;

/**
 * Deterministic grading for one eval case: answer assertions (contains /
 * notContains / regex) + tool-call expectations (called with matching args,
 * didn't call forbidden ones). Pure — no I/O, no model calls (an LLM judge is
 * a later grader tier).
 */
export function gradeCase(
  c: EvalCase,
  answer: string,
  calls: EvalToolCall[],
): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const lower = answer.toLowerCase();
  const a = c.expected.assertions;

  for (const s of a?.contains ?? []) {
    if (!lower.includes(s.toLowerCase())) reasons.push(`answer missing "${s}"`);
  }
  for (const s of a?.notContains ?? []) {
    if (lower.includes(s.toLowerCase())) reasons.push(`answer must not contain "${s}"`);
  }
  for (const r of a?.regex ?? []) {
    // Author-supplied patterns: refuse the catastrophic-backtracking shape,
    // bound the input, and never let a bad pattern throw.
    if (isRiskyRegex(r)) {
      reasons.push(`unsafe regex (too long or nested quantifiers): ${r.slice(0, 40)}`);
      continue;
    }
    try {
      if (!new RegExp(r).test(answer.slice(0, REGEX_INPUT_CAP))) {
        reasons.push(`answer doesn't match /${r}/`);
      }
    } catch {
      reasons.push(`invalid regex /${r}/`);
    }
  }

  for (const exp of c.expected.toolCalls ?? []) {
    const candidates = calls.filter((tc) => tc.tool === exp.tool);
    if (candidates.length === 0) {
      reasons.push(`expected a call to ${exp.tool}`);
      continue;
    }
    if (exp.args && !candidates.some((tc) => argsMatch(exp.args!, tc.args))) {
      reasons.push(`${exp.tool} was called but not with args ${JSON.stringify(exp.args)}`);
    }
  }

  for (const name of c.expected.forbiddenTools ?? []) {
    if (calls.some((tc) => tc.tool === name)) reasons.push(`must not call ${name}`);
  }

  return { pass: reasons.length === 0, reasons };
}

/** Every expected key must deep-equal the actual call's value (subset match). */
function argsMatch(expected: Record<string, unknown>, actual: unknown): boolean {
  if (actual == null || typeof actual !== "object") return false;
  const act = actual as Record<string, unknown>;
  return Object.entries(expected).every(([k, v]) => deepEqual(v, act[k]));
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

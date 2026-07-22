import type { EvalCase, EvalToolCall } from "./store";

/**
 * Static ReDoS pre-filter for author-supplied assertion regexes: reject a
 * quantified group whose body itself contains a quantifier or alternation —
 * the repetition-of-repetition shape behind catastrophic backtracking (e.g.
 * `(a+)+$`, `(a?)*`, `(a|aa)*`). Errs on the safe side (some harmless patterns
 * are rejected); eval assertions rarely need nesting, and authors can
 * restructure. Heuristic only — the HARD bound is `safeRegexTest`, which runs
 * every match in a worker with a kill timeout. Used at save-time
 * (save_eval_set rejects with a fix-it message) and as a grade-time fast path.
 */
export function isRiskyRegex(source: string): boolean {
  if (source.length > 200) return true;
  const quantifiedGroup = /\((?:[^()\\]|\\.)*[+*{|?](?:[^()\\]|\\.)*\)\??[+*{]/;
  return quantifiedGroup.test(source);
}

/** Regexes only see a bounded slice of the answer. */
const REGEX_INPUT_CAP = 5_000;
/** Hard wall-clock bound for one regex match (worker is terminated past it). */
const REGEX_TIMEOUT_MS = 200;

/**
 * Execute `new RegExp(pattern).test(input)` with a HARD execution bound: the
 * match runs in a throwaway worker thread that is terminated on timeout, so
 * catastrophic backtracking can never block the event loop (the static
 * pre-filter alone cannot guarantee that). Grading runs a handful of these per
 * eval case, so the ~ms worker spawn cost is irrelevant.
 */
export async function safeRegexTest(
  pattern: string,
  input: string,
): Promise<boolean | "timeout" | "invalid"> {
  try {
    new RegExp(pattern); // syntax check without executing a match
  } catch {
    return "invalid";
  }
  const { Worker } = await import("node:worker_threads");
  return new Promise((resolve) => {
    const worker = new Worker(
      `const { workerData, parentPort } = require("node:worker_threads");
       parentPort.postMessage(new RegExp(workerData.pattern).test(workerData.input));`,
      { eval: true, workerData: { pattern, input } },
    );
    const timer = setTimeout(() => {
      void worker.terminate();
      resolve("timeout");
    }, REGEX_TIMEOUT_MS);
    worker.once("message", (matched: unknown) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(!!matched);
    });
    worker.once("error", () => {
      clearTimeout(timer);
      resolve("invalid");
    });
  });
}

/**
 * `{"$regex": "..."}` in expected tool args is a MATCHER, not a literal: it
 * passes when the actual value (string/number/boolean, stringified) matches
 * the pattern. Returns the pattern, or null when the value is a plain literal.
 */
export function asRegexMatcher(v: unknown): string | null {
  if (v == null || typeof v !== "object" || Array.isArray(v)) return null;
  const rec = v as Record<string, unknown>;
  const keys = Object.keys(rec);
  return keys.length === 1 && keys[0] === "$regex" && typeof rec.$regex === "string" ? rec.$regex : null;
}

/** All `$regex` matcher patterns nested anywhere in an expected-args value (for save-time validation). */
export function collectMatcherPatterns(v: unknown): string[] {
  const pattern = asRegexMatcher(v);
  if (pattern != null) return [pattern];
  if (v == null || typeof v !== "object") return [];
  return Object.values(v).flatMap(collectMatcherPatterns);
}

/**
 * Deterministic grading for one eval case: answer assertions (contains /
 * notContains / regex) + trajectory expectations (called with matching args,
 * within maxCalls, in toolOrder, didn't call forbidden ones, within the
 * case's total-call budget). No model calls (the LLM judge is a separate
 * grader tier); async only because regex matching runs in a time-boxed worker.
 */
export async function gradeCase(
  c: EvalCase,
  answer: string,
  calls: EvalToolCall[],
): Promise<{ pass: boolean; reasons: string[] }> {
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
    // Author-supplied patterns: static pre-filter, bounded input, and a
    // worker-isolated match with a kill timeout as the hard bound.
    if (isRiskyRegex(r)) {
      reasons.push(`unsafe regex (too long or nested quantifiers): ${r.slice(0, 40)}`);
      continue;
    }
    const result = await safeRegexTest(r, answer.slice(0, REGEX_INPUT_CAP));
    if (result === "invalid") reasons.push(`invalid regex /${r}/`);
    else if (result === "timeout") reasons.push(`regex timed out (catastrophic backtracking?): /${r}/`);
    else if (!result) reasons.push(`answer doesn't match /${r}/`);
  }

  for (const exp of c.expected.toolCalls ?? []) {
    const candidates = calls.filter((tc) => tc.tool === exp.tool);
    if (candidates.length === 0) {
      reasons.push(`expected a call to ${exp.tool}`);
      continue;
    }
    if (exp.maxCalls != null && candidates.length > exp.maxCalls) {
      reasons.push(`${exp.tool} called ${candidates.length}× (max ${exp.maxCalls})`);
    }
    if (exp.args) {
      const risky = collectMatcherPatterns(exp.args).find((p) => isRiskyRegex(p));
      if (risky != null) {
        reasons.push(`unsafe regex matcher (too long or nested quantifiers): ${risky.slice(0, 40)}`);
        continue;
      }
      let matched = false;
      for (const tc of candidates) {
        if (await argsMatch(exp.args, tc.args)) {
          matched = true;
          break;
        }
      }
      if (!matched) reasons.push(`${exp.tool} was called but not with args ${JSON.stringify(exp.args)}`);
    }
  }

  // Relative order: the expected names must appear as a subsequence of the
  // observed call sequence (other calls may interleave).
  const order = c.expected.toolOrder;
  if (order?.length) {
    const seq = calls.map((tc) => tc.tool);
    let i = 0;
    for (const name of seq) if (i < order.length && name === order[i]) i += 1;
    if (i < order.length) {
      reasons.push(
        `tools out of order: expected ${order.join(" → ")} (got ${seq.join(", ") || "no calls"})`,
      );
    }
  }

  for (const name of c.expected.forbiddenTools ?? []) {
    if (calls.some((tc) => tc.tool === name)) reasons.push(`must not call ${name}`);
  }

  if (c.expected.maxTotalToolCalls != null && calls.length > c.expected.maxTotalToolCalls) {
    reasons.push(`${calls.length} tool calls total (max ${c.expected.maxTotalToolCalls}) — tool loop?`);
  }

  return { pass: reasons.length === 0, reasons };
}

/** Every expected key must match the actual call's value (subset match; `$regex` matchers allowed). */
async function argsMatch(expected: Record<string, unknown>, actual: unknown): Promise<boolean> {
  if (actual == null || typeof actual !== "object") return false;
  const act = actual as Record<string, unknown>;
  for (const [k, v] of Object.entries(expected)) {
    if (!(await valueMatches(v, act[k]))) return false;
  }
  return true;
}

/** Deep equality, except a `{"$regex"}` matcher anywhere in `expected` tests the actual value. */
async function valueMatches(expected: unknown, actual: unknown): Promise<boolean> {
  const pattern = asRegexMatcher(expected);
  if (pattern != null) {
    if (typeof actual !== "string" && typeof actual !== "number" && typeof actual !== "boolean") {
      return false;
    }
    return (await safeRegexTest(pattern, String(actual).slice(0, REGEX_INPUT_CAP))) === true;
  }
  if (expected === actual) return true;
  if (expected == null || actual == null || typeof expected !== "object" || typeof actual !== "object") {
    return false;
  }
  if (Array.isArray(expected) !== Array.isArray(actual)) return false;
  const ke = Object.keys(expected);
  if (ke.length !== Object.keys(actual).length) return false;
  for (const k of ke) {
    const ok = await valueMatches(
      (expected as Record<string, unknown>)[k],
      (actual as Record<string, unknown>)[k],
    );
    if (!ok) return false;
  }
  return true;
}

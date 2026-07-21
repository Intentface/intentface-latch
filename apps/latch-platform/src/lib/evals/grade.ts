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
 * Deterministic grading for one eval case: answer assertions (contains /
 * notContains / regex) + tool-call expectations (called with matching args,
 * didn't call forbidden ones). No model calls (an LLM judge is a later grader
 * tier); async only because regex assertions run in a time-boxed worker.
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

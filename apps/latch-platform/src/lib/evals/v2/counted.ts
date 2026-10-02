import type { CallExpectation, CountedCheck, CountedSpec, Matcher } from "./model";
import type { ThreadView, ToolCall } from "./thread";

/**
 * Counted checks — facts read from the tool-call log by code.
 *
 * Free, exact, instant, and cannot be wrong, which is why they can gate a
 * release without a false-alarm tax and run on every production thread rather
 * than a sample. The boundary with asked checks: if it is unambiguously in
 * the log, it is counted; if it takes reading to decide, it is asked.
 */

/** `linear_*`, `*_read_file`, or an exact name. */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

const callsOf = (v: ThreadView, tool: string): ToolCall[] => {
  const re = globToRegExp(tool);
  return v.calls.filter((c) => re.test(c.tool));
};

/**
 * Read a dot path from a call. `args.` and `result.` choose the side; a bare
 * path reads args. Brackets index arrays: `result.files[0].name`.
 *
 * Both sides matter. Some servers take the identity in the arguments; others
 * — Loredex reads by file id — name the human-readable thing only in what came
 * back. Matching on the result handles that without any per-server code.
 */
export function readPath(call: ToolCall, path: string): unknown {
  const onResult = path === "result" || path.startsWith("result.") || path.startsWith("result[");
  let cur: unknown = onResult ? call.result : call.args;
  // Only a whole leading segment: `results` and `arguments` are argument names.
  const rest = path.replace(/^(args|result)(\.|(?=\[)|$)/, "");
  for (const key of rest.split(/[.[\]]/).filter(Boolean)) {
    if (cur == null) return undefined;
    cur = (cur as Record<string, unknown>)[/^\d+$/.test(key) ? Number(key) : key];
  }
  return cur;
}

const asText = (v: unknown): string => {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return String(v);
  }
};

/**
 * `contains` searches the serialized value, so it works on a string, an array
 * of ids, or a nested result alike — "the result mentions accessibility.md"
 * without knowing where in the payload it sits.
 */
export function matches(value: unknown, m: Matcher): boolean {
  if ("equals" in m) return JSON.stringify(value) === JSON.stringify(m.equals) || value == m.equals;
  if ("contains" in m) return asText(value).includes(m.contains);
  if ("matches" in m) return new RegExp(m.matches).test(asText(value));
  return m.oneOf.some((o) => JSON.stringify(o) === JSON.stringify(value));
}

export interface CountedResult {
  passed: boolean;
  /** One line a person can read: what was checked and what was found. */
  detail: string;
  /** Per item, for a check over a list the input supplies — which held. */
  each?: boolean[];
}

/**
 * One expected call: some call to the tool satisfies every match (or, for
 * `never`, no call to it happens). A bare path reads the arguments.
 */
export function callHolds(e: CallExpectation, v: ThreadView): boolean {
  const hits = callsOf(v, e.tool);
  if (e.never) return hits.length === 0;
  return hits.some((c) =>
    (e.match ?? []).every((m) => {
      const value = readPath(c, m.path);
      if (m.op === "any") return value !== undefined;
      if (m.op === "equals") return matches(value, { equals: m.value ?? "" });
      const has = matches(value, { contains: m.value ?? "" });
      return m.op === "contains" ? has : !has;
    }),
  );
}

export function evaluateCounted(spec: CountedSpec, v: ThreadView): CountedResult {
  // Only meaningful with an input's facts — see evaluateBound.
  if (spec.op === "expected_calls") return { passed: true, detail: "no calls expected" };
  const hits = callsOf(v, spec.tool);
  switch (spec.op) {
    case "called":
      return { passed: hits.length > 0, detail: `${hits.length} call(s) to ${spec.tool}` };
    case "never_called":
      return { passed: hits.length === 0, detail: `${hits.length} call(s) to ${spec.tool}` };
    case "called_with": {
      const ok = hits.filter((c) => matches(readPath(c, spec.path), spec.match));
      return {
        passed: ok.length > 0,
        detail: hits.length
          ? `${ok.length} of ${hits.length} call(s) to ${spec.tool} matched ${spec.path}`
          : `${spec.tool} was never called`,
      };
    }
    case "at_least":
      return { passed: hits.length >= spec.n, detail: `${hits.length} call(s), needed at least ${spec.n}` };
    case "at_most":
      return { passed: hits.length <= spec.n, detail: `${hits.length} call(s), allowed at most ${spec.n}` };
    case "repeated": {
      // Identical tool + identical args. Passing means it did NOT repeat —
      // phrased so the check reads "didn't thrash", and YES stays good.
      const seen = new Set<string>();
      let dupes = 0;
      for (const c of hits) {
        const key = asText(c.args);
        if (seen.has(key)) dupes += 1;
        seen.add(key);
      }
      return { passed: dupes === 0, detail: `${dupes} repeated call(s) to ${spec.tool}` };
    }
    case "before": {
      const first = hits[0];
      const then = callsOf(v, spec.then)[0];
      if (!then) return { passed: true, detail: `${spec.then} was never called` };
      return {
        passed: !!first && first.seq < then.seq,
        detail: first ? `${spec.tool} at step ${first.seq}, ${spec.then} at ${then.seq}` : `${spec.tool} was never called`,
      };
    }
    case "before_answering": {
      if (v.answeredAt < 0) return { passed: false, detail: "the thread never answered" };
      const early = hits.filter((c) => c.seq < v.answeredAt);
      return { passed: early.length > 0, detail: `${early.length} call(s) to ${spec.tool} before the answer` };
    }
    case "stopped_for_approval": {
      const gated = hits.filter((c) => c.gated);
      return {
        passed: hits.length === 0 || gated.length === hits.length,
        detail: hits.length ? `${gated.length} of ${hits.length} call(s) went through approval` : `${spec.tool} was never called`,
      };
    }
  }
}

/**
 * Fill `{{facts.key}}` in a spec from the input it is judging.
 *
 * A counted check is written once for the whole rubric, but the value it
 * looks for often belongs to the input: *the issue this ticket names*, *the
 * document that holds this answer*. When the fact is a list, the check
 * expands into one evaluation per item and passes only if every item does —
 * which is recall, derived rather than authored.
 */
export function bindFacts(spec: CountedSpec, facts: Record<string, unknown> | undefined): CountedSpec[] | null {
  const json = JSON.stringify(spec);
  const refs = [...json.matchAll(/\{\{facts\.([\w-]+)\}\}/g)].map((m) => m[1]!);
  if (!refs.length) return [spec];
  const key = refs[0]!;
  const value = facts?.[key];
  // The input does not say — the check does not apply, rather than failing.
  if (value === undefined || (Array.isArray(value) && value.length === 0)) return null;
  const items = Array.isArray(value) ? value : [value];
  return items.map((item) => {
    const esc = JSON.stringify(String(item)).slice(1, -1);
    return JSON.parse(json.replaceAll(`{{facts.${key}}}`, esc)) as CountedSpec;
  });
}

/** Evaluate a spec that may reference input facts. `null` = not applicable. */
export function evaluateBound(spec: CountedSpec, v: ThreadView, facts?: Record<string, unknown>): CountedResult | null {
  if (spec.op === "expected_calls") {
    const list = Array.isArray(facts?.calls) ? (facts.calls as CallExpectation[]) : [];
    if (!list.length) return null;
    const each = list.map((e) => callHolds(e, v));
    const held = each.filter(Boolean).length;
    return { passed: held === each.length, detail: `${held} of ${each.length} expected calls`, each };
  }
  const specs = bindFacts(spec, facts);
  if (!specs) return null;
  const results = specs.map((s) => evaluateCounted(s, v));
  const passed = results.filter((r) => r.passed).length;
  return {
    passed: passed === results.length,
    detail: results.length === 1 ? results[0]!.detail : `${passed} of ${results.length} satisfied`,
  };
}

/** A counted check as a sentence — what the grid shows in the Question column. */
export function describeCounted(c: CountedCheck): string {
  const s = c.spec;
  const m = (x: Matcher) =>
    "equals" in x ? `equals ${JSON.stringify(x.equals)}` : "contains" in x ? `contains "${x.contains}"` : "matches" in x ? `matches /${x.matches}/` : `is one of ${JSON.stringify(x.oneOf)}`;
  switch (s.op) {
    case "called": return `${s.tool} was called`;
    case "never_called": return `${s.tool} was never called`;
    case "called_with": return `${s.tool} was called where ${s.path} ${m(s.match)}`;
    case "at_least": return `${s.tool} was called at least ${s.n} times`;
    case "at_most": return `${s.tool} was called at most ${s.n} times`;
    case "repeated": return `${s.tool} was never called twice with the same arguments`;
    case "before": return `${s.tool} was called before ${s.then}`;
    case "before_answering": return `${s.tool} was called before answering`;
    case "stopped_for_approval": return `every call to ${s.tool} went through approval`;
    case "expected_calls": return "the tool calls each input lists were made";
  }
}

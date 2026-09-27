/**
 * What the editors may save. Every refusal is a sentence a person can act
 * on, because the person reading it wrote the question or the check.
 */
import type { CallExpectation, Check, CountedSpec, Input, JudgedItem, Matcher } from "./model";

export type Valid<T> = { ok: true; value: T } | { ok: false; error: string };

const OPS = new Set<CountedSpec["op"]>([
  "called",
  "never_called",
  "called_with",
  "at_least",
  "at_most",
  "repeated",
  "before",
  "before_answering",
  "stopped_for_approval",
  "expected_calls",
]);

const clean = (xs: unknown): string[] =>
  Array.isArray(xs) ? xs.map((x) => String(x).trim()).filter(Boolean) : [];

export function validateInputs(inputs: Input[]): Valid<Input[]> {
  const seen = new Set<string>();
  const out: Input[] = [];
  for (const [i, raw] of inputs.entries()) {
    const id = String(raw.id).trim();
    const where = `Question ${i + 1}${id ? ` (#${id})` : ""}`;
    if (!id) return { ok: false, error: `${where} has no id.` };
    if (seen.has(id)) return { ok: false, error: `Two questions share the id #${id}. Ids must be unique, or their results merge.` };
    seen.add(id);
    const prompt = raw.prompt.trim();
    if (!prompt) return { ok: false, error: `${where} has no question.` };
    const followUps = clean(raw.followUps);
    const facts: Record<string, unknown> = { ...raw.facts };
    const answer = typeof facts.answer === "string" ? facts.answer.trim() : "";
    if (answer) facts.answer = answer;
    else delete facts.answer;
    for (const key of ["mustNot", "mustSay", "asks"] as const) {
      const xs = clean(facts[key]);
      if (xs.length) facts[key] = xs;
      else delete facts[key];
    }
    if (facts.decline === true) facts.decline = true;
    else delete facts.decline;
    if ("calls" in facts) {
      const calls = cleanCalls(facts.calls);
      if (typeof calls === "string") return { ok: false, error: `${where}: ${calls}` };
      if (calls.length) facts.calls = calls;
      else delete facts.calls;
    }
    // "Reads this document" was its own kind; it is an expected call like any
    // other — a read whose result names the document — so it is saved as one.
    if ("judged" in facts) {
      const judged = cleanJudged(facts.judged);
      if (typeof judged === "string") return { ok: false, error: `${where}: ${judged}` };
      if (judged.length) facts.judged = judged;
      else delete facts.judged;
    }
    if ("docs" in facts) {
      const reads = docsAsCalls(clean(facts.docs));
      const had = Array.isArray(facts.calls) ? (facts.calls as CallExpectation[]) : [];
      const fresh = reads.filter((r) => !had.some((c) => JSON.stringify(c) === JSON.stringify(r)));
      if (had.length || fresh.length) facts.calls = [...had, ...fresh];
      delete facts.docs;
    }
    out.push({ id, prompt, ...(followUps.length ? { followUps } : {}), ...(Object.keys(facts).length ? { facts } : {}) });
  }
  return { ok: true, value: out };
}

/** An input's own judge questions: each with its question, and a type that can both pass and fail. */
function cleanJudged(raw: unknown): JudgedItem[] | string {
  if (!Array.isArray(raw)) return [];
  const out: JudgedItem[] = [];
  for (const j of raw as Partial<JudgedItem>[]) {
    const ask = String(j.ask ?? "").trim();
    if (!ask) continue;
    if (!j.shape) return `"${ask.slice(0, 40)}" needs a type.`;
    const v = validateChecks([{ kind: "asked", id: "item", label: ask, ask, shape: j.shape }]);
    if (!v.ok) return v.error;
    out.push({ ask, shape: j.shape, ...(j.judge ? { judge: j.judge } : {}) });
  }
  return out;
}

/** A document the answer is in, as the call that must read it. */
export const docsAsCalls = (docs: string[]): CallExpectation[] =>
  docs.map((d) => ({ tool: "*read_file", match: [{ path: "result", op: "contains", value: d }] }));

/** Expected tool calls as saved: a tool each, matches with a path; an error in words otherwise. */
function cleanCalls(raw: unknown): CallExpectation[] | string {
  if (!Array.isArray(raw)) return [];
  const out: CallExpectation[] = [];
  for (const c of raw as Partial<CallExpectation>[]) {
    const tool = String(c.tool ?? "").trim();
    if (!tool) return "an expected tool call has no tool.";
    const match = (c.match ?? [])
      .map((m) => ({ path: String(m.path).trim(), op: m.op, ...(m.value !== undefined && m.op !== "any" ? { value: String(m.value) } : {}) }))
      .filter((m) => m.path);
    if (match.some((m) => !["contains", "equals", "not_contains", "any"].includes(m.op))) return `a match on ${tool} uses an unknown rule.`;
    out.push({ tool, ...(c.never ? { never: true } : {}), ...(match.length && !c.never ? { match } : {}) });
  }
  return out;
}

function validMatcher(m: Matcher): string | null {
  if ("matches" in m) {
    try {
      new RegExp(m.matches);
    } catch {
      return `"${m.matches}" is not a valid pattern.`;
    }
    return null;
  }
  if ("contains" in m) return m.contains.trim() ? null : "Say what the value should contain.";
  if ("oneOf" in m) return m.oneOf.length ? null : "List at least one allowed value.";
  return null;
}

export function validateChecks(checks: Check[]): Valid<Check[]> {
  if (!checks.length) return { ok: false, error: "Add at least one check." };
  const seen = new Set<string>();
  for (const c of checks) {
    const name = c.label.trim() ? `"${c.label.trim()}"` : "A check";
    if (!c.id.trim()) return { ok: false, error: `${name} has no id.` };
    if (seen.has(c.id)) return { ok: false, error: `Two checks share the id "${c.id}".` };
    seen.add(c.id);
    if (!c.label.trim()) return { ok: false, error: `Check "${c.id}" needs a name.` };
    if (c.kind === "asked") {
      if (!c.ask.trim()) return { ok: false, error: `${name} needs a question for the judge.` };
      const s = c.shape;
      if (s.type === "choice") {
        const ids = Object.keys(s.options);
        if (ids.length < 2) return { ok: false, error: `${name} needs at least two answers to pick from.` };
        if (ids.some((k) => !s.options[k].trim())) return { ok: false, error: `${name}: every answer needs a description.` };
        if (!s.bad.length) return { ok: false, error: `${name}: mark at least one answer as a fail, or nothing can fail.` };
        if (s.bad.length === ids.length) return { ok: false, error: `${name}: every answer is marked a fail, so nothing can pass.` };
        if (s.bad.some((b) => !ids.includes(b))) return { ok: false, error: `${name} marks an answer as a fail that is not in the list.` };
      }
      if (s.type === "score") {
        if (s.levels.length < 2) return { ok: false, error: `${name} needs at least two levels.` };
        if (s.levels.some((l) => !l.name.trim() || !l.means.trim())) return { ok: false, error: `${name}: every level needs a name and a meaning.` };
        const bad = s.bad ?? 0;
        if (bad < 0 || bad >= s.levels.length - 1) return { ok: false, error: `${name}: the fail line must leave at least one passing level.` };
      }
    } else {
      const s = c.spec;
      if (!OPS.has(s.op)) return { ok: false, error: `${name} uses an unknown rule.` };
      if (s.op === "expected_calls") continue;
      if (!s.tool.trim()) return { ok: false, error: `${name} needs a tool name (a * matches any characters).` };
      if (s.op === "called_with") {
        if (!s.path.trim()) return { ok: false, error: `${name}: say which part of the call to look at, e.g. "state" or "result".` };
        const err = validMatcher(s.match);
        if (err) return { ok: false, error: `${name}: ${err}` };
      }
      if ((s.op === "at_least" || s.op === "at_most") && !(Number.isInteger(s.n) && s.n >= 0))
        return { ok: false, error: `${name} needs a whole number of calls.` };
      if (s.op === "before" && !s.then.trim()) return { ok: false, error: `${name}: say which tool must come after.` };
    }
  }
  return { ok: true, value: checks };
}

/** A check id from its name: stable, readable, unique within the rubric. */
export function checkIdFor(label: string, taken: Iterable<string>): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  // Cut at a word, not mid-word: an id is read in URLs and exports.
  const cut = slug.length <= 40 ? slug : slug.slice(0, 41).replace(/-[^-]*$/, "");
  const base = cut || "check";
  const used = new Set(taken);
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  return id;
}

/** The next free question id: numeric sets continue their numbering. */
/**
 * An id for a new input. `retired` are ids that still have answers in past
 * runs — a removed input's — and are never handed out again, or the new
 * input would inherit its answers.
 */
export function nextInputId(inputs: { id: string }[], retired: Iterable<string> = []): string {
  const all = [...inputs.map((i) => i.id), ...retired];
  const nums = all.map((id) => Number(id)).filter((n) => Number.isInteger(n));
  if (inputs.every((i) => Number.isInteger(Number(i.id)))) return String((nums.length ? Math.max(...nums) : 0) + 1);
  const ids = new Set(all);
  let n = inputs.length + 1;
  while (ids.has(`q${n}`)) n++;
  return `q${n}`;
}

/**
 * A question as the editor holds it: the fields every set uses as plain
 * strings and lists, anything else as JSON text so it round-trips untouched.
 */
export interface EditableQuestion {
  id: string;
  prompt: string;
  followUps: string[];
  answer: string;
  mustNot: string[];
  mustSay: string[];
  asks: string[];
  decline: boolean;
  calls: CallExpectation[];
  judged: JudgedItem[];
  /** Other facts, as JSON — `{}` when there are none. */
  extra: string;
}

export function toEditable(i: Input): EditableQuestion {
  const { answer, mustNot, docs, mustSay, asks, decline, calls, judged, ...rest } = i.facts ?? {};
  return {
    id: i.id,
    prompt: i.prompt,
    followUps: i.followUps ?? [],
    answer: typeof answer === "string" ? answer : "",
    mustNot: clean(mustNot),
    mustSay: clean(mustSay),
    asks: clean(asks),
    decline: decline === true,
    // An older input's documents are the reads it expects.
    calls: [...(Array.isArray(calls) ? calls : []), ...docsAsCalls(clean(docs))],
    judged: Array.isArray(judged) ? judged : [],
    extra: Object.keys(rest).length ? JSON.stringify(rest, null, 2) : "{}",
  };
}

export function fromEditable(qs: EditableQuestion[]): Valid<Input[]> {
  const inputs: Input[] = [];
  for (const q of qs) {
    let extra: unknown;
    try {
      extra = JSON.parse(q.extra.trim() || "{}");
    } catch {
      return { ok: false, error: `Question #${q.id}: the other facts are not valid JSON.` };
    }
    if (!extra || typeof extra !== "object" || Array.isArray(extra))
      return { ok: false, error: `Question #${q.id}: the other facts must be a JSON object, like {"issueId": "ABC-12"}.` };
    inputs.push({
      id: q.id,
      prompt: q.prompt,
      followUps: q.followUps,
      facts: {
        ...(extra as Record<string, unknown>),
        answer: q.answer,
        mustNot: q.mustNot,
        mustSay: q.mustSay,
        asks: q.asks,
        decline: q.decline,
        calls: q.calls,
        judged: q.judged,
      },
    });
  }
  return validateInputs(inputs);
}

/**
 * The attached-eval trigger DSL: a small structural predicate tree deciding
 * WHEN a rubric's judge runs. Leaves test deterministic facts of the finished
 * turn (never message content — content conditionality stays as English inside
 * the rubric prompt, where the judge weighs it); `all`/`any`/`not` combine
 * them. A rubric without a trigger runs on every turn — but only at the top
 * level (depth 0) unless its trigger mentions `depth`, which is the explicit
 * opt-in to judging subagent turns.
 */

/** What a trigger's judge-or-skip decision may depend on — all structural. */
export interface TriggerFacts {
  /** 1-based ordinal of this assistant turn within its chat ("first message" = 1). */
  turnOrdinal: number;
  /** Names of the tools the agent called this turn. */
  toolsCalled: string[];
  /** Delegation depth: 0 = top-level turn, >0 = a subagent turn. */
  depth: number;
  /** The chat's kind: "user" (a user-facing conversation) or "internal" (a `sub_…` thread). */
  chatKind: string;
}

/** One leaf or combinator of a trigger tree. */
export type EvalTrigger =
  | { kind: "all"; of: EvalTrigger[] }
  | { kind: "any"; of: EvalTrigger[] }
  | { kind: "not"; of: EvalTrigger }
  /**
   * Turn-ordinal test. Present comparators AND together; `everyNth: n` matches
   * turns n, 2n, 3n, … (`ordinal % n === 0`).
   */
  | { kind: "turn"; eq?: number; gte?: number; lte?: number; everyNth?: number }
  /** True when the named tool was called this turn; `name` omitted → any tool. */
  | { kind: "toolCalled"; name?: string }
  /** Delegation-depth test — mentioning it anywhere opts the rubric into subagent turns. */
  | { kind: "depth"; eq?: number; gte?: number; lte?: number }
  /** Chat-kind test ("user" | "internal"). */
  | { kind: "chatKind"; is: string };

/** Where the judge's evidence comes from (AttachedEval.context; default "turn"). */
export type EvalContextScope = "turn" | "chat" | "loop";

/** Evaluate a trigger tree against one turn's facts. */
export function evaluateTrigger(t: EvalTrigger, f: TriggerFacts): boolean {
  switch (t.kind) {
    case "all":
      return t.of.every((n) => evaluateTrigger(n, f));
    case "any":
      return t.of.some((n) => evaluateTrigger(n, f));
    case "not":
      return !evaluateTrigger(t.of, f);
    case "turn":
      return (
        (t.eq === undefined || f.turnOrdinal === t.eq) &&
        (t.gte === undefined || f.turnOrdinal >= t.gte) &&
        (t.lte === undefined || f.turnOrdinal <= t.lte) &&
        (t.everyNth === undefined || f.turnOrdinal % t.everyNth === 0)
      );
    case "toolCalled":
      return t.name === undefined
        ? f.toolsCalled.length > 0
        : f.toolsCalled.includes(t.name);
    case "depth":
      return (
        (t.eq === undefined || f.depth === t.eq) &&
        (t.gte === undefined || f.depth >= t.gte) &&
        (t.lte === undefined || f.depth <= t.lte)
      );
    case "chatKind":
      return f.chatKind === t.is;
  }
}

/** Whether any node of the tree tests `depth` (the subagent opt-in marker). */
export function triggerMentionsDepth(t: EvalTrigger | undefined): boolean {
  if (!t) return false;
  if (t.kind === "depth") return true;
  if (t.kind === "all" || t.kind === "any") return t.of.some(triggerMentionsDepth);
  if (t.kind === "not") return triggerMentionsDepth(t.of);
  return false;
}

/** Whether any node tests the turn ordinal (→ the judge must load chat history). */
export function triggerNeedsTurnOrdinal(t: EvalTrigger | undefined): boolean {
  if (!t) return false;
  if (t.kind === "turn") return true;
  if (t.kind === "all" || t.kind === "any") return t.of.some(triggerNeedsTurnOrdinal);
  if (t.kind === "not") return triggerNeedsTurnOrdinal(t.of);
  return false;
}

/**
 * The full judge-or-skip decision for one rubric: its trigger must match, AND —
 * unless the trigger itself mentions depth — the turn must be top-level. This
 * default keeps "greets the user" rubrics off internal subagent turns without
 * every author having to know delegation exists.
 */
export function rubricIsDue(t: EvalTrigger | undefined, f: TriggerFacts): boolean {
  if (!triggerMentionsDepth(t) && f.depth !== 0) return false;
  return t ? evaluateTrigger(t, f) : true;
}

/** Bounds keeping a stored trigger cheap to evaluate and impossible to abuse. */
const MAX_NODES = 25;
const MAX_DEPTH = 5;

const isPosInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 1;
const isNonNegInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0;

/**
 * Validate an untrusted trigger value (JSON from the drawer's advanced field,
 * `attach_evals`, or the eval-author). Returns an error string or null. Also
 * narrows: a null return guarantees the value is a well-formed `EvalTrigger`.
 */
export function validateTrigger(value: unknown): string | null {
  const counter = { nodes: 0 };
  return walkTrigger(value, counter, 1);
}

function walkTrigger(
  value: unknown,
  counter: { nodes: number },
  depth: number,
): string | null {
  if (depth > MAX_DEPTH) return `trigger nests deeper than ${MAX_DEPTH} levels`;
  if (++counter.nodes > MAX_NODES) return `trigger has more than ${MAX_NODES} nodes`;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "each trigger node must be an object";
  }
  const t = value as Record<string, unknown>;
  switch (t.kind) {
    case "all":
    case "any": {
      if (!Array.isArray(t.of) || t.of.length === 0) {
        return `"${t.kind}" needs a non-empty "of" array`;
      }
      for (const child of t.of) {
        const err = walkTrigger(child, counter, depth + 1);
        if (err) return err;
      }
      return null;
    }
    case "not":
      return walkTrigger(t.of, counter, depth + 1);
    case "turn": {
      const comparators = ["eq", "gte", "lte", "everyNth"] as const;
      if (!comparators.some((k) => t[k] !== undefined)) {
        return `"turn" needs at least one of eq/gte/lte/everyNth`;
      }
      for (const k of comparators) {
        if (t[k] !== undefined && !isPosInt(t[k])) {
          return `"turn".${k} must be a positive integer`;
        }
      }
      return null;
    }
    case "toolCalled":
      if (
        t.name !== undefined &&
        (typeof t.name !== "string" || !t.name.trim() || t.name.length > 200)
      ) {
        return `"toolCalled".name must be a non-empty string (≤200 chars) when present`;
      }
      return null;
    case "depth": {
      const comparators = ["eq", "gte", "lte"] as const;
      if (!comparators.some((k) => t[k] !== undefined)) {
        return `"depth" needs at least one of eq/gte/lte`;
      }
      for (const k of comparators) {
        if (t[k] !== undefined && !isNonNegInt(t[k])) {
          return `"depth".${k} must be a non-negative integer`;
        }
      }
      return null;
    }
    case "chatKind":
      // Restricted to what `chatKindOf` can actually produce — an unmatched
      // trigger is a SILENT skip, so a typo ("Internal", "external") must be a
      // save-time error, not a rubric that never fires. Widen alongside
      // `chatKindOf` if chat kinds ever grow.
      if (t.is !== "user" && t.is !== "internal") {
        return `"chatKind".is must be "user" or "internal"`;
      }
      return null;
    default:
      return `unknown trigger kind "${String(t.kind)}" (all/any/not/turn/toolCalled/depth/chatKind)`;
  }
}

/**
 * The turn's 1-based ordinal within its chat: how many assistant turns the
 * chat holds up to AND including the one with `runId`. Judged post-persist,
 * so the current turn's message is already in `history`. An unknown runId
 * falls back to the total count — the live path judges the just-appended
 * (last) turn, so the count IS its ordinal.
 */
export function turnOrdinalOf(history: unknown[], runId: string): number {
  let count = 0;
  for (const m of history) {
    const msg = m as { role?: string; metadata?: { runId?: string } };
    if (msg.role !== "assistant") continue;
    count++;
    if (msg.metadata?.runId === runId) return count;
  }
  return count;
}

/**
 * A chat's kind, derived from its id: the runtime mints subagent threads as
 * `sub_…` (ChatRecord.kind "internal"); everything else the platform creates
 * today is a user-facing chat. Derived instead of fetched so the judge path
 * adds no storage read.
 */
export function chatKindOf(chatId: string): string {
  return chatId.startsWith("sub_") ? "internal" : "user";
}

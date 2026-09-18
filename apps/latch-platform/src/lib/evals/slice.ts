import { transcriptOf } from "@/agents/eval-author";

/**
 * Cut a long conversation into pieces a judge can actually read.
 *
 * The cheap evaluation models are cheap partly because they are small, and a
 * real agent run is not: forty tool calls against a document corpus is an
 * ordinary afternoon. Handing that to a judge whole either overflows it or —
 * worse — silently drops the middle, and a judge that saw half the evidence
 * answers confidently about the half it saw.
 *
 * Two rules do most of the work here:
 *
 *   DON'T SLICE UNLESS YOU MUST. A conversation inside the budget is one
 *   slice, because a window is strictly less informative than the whole and
 *   every extra slice is another judge call. Most conversations are short.
 *
 *   EVERY WINDOW CARRIES THE GOAL. A window from the middle of a run is
 *   meaningless on its own — "did it open the right document" cannot be
 *   answered without knowing what was asked. So each slice repeats the user's
 *   original request, and says where in the run it sits.
 *
 * What this does NOT fix: a failure whose cause is outside the window. If the
 * agent went wrong at step 4 and the damage shows at step 180, a window over
 * step 180 sees the damage and not the cause. Windows overlap to soften that,
 * but a question that genuinely needs the whole arc should be asked of the
 * trajectory scope instead, and phrased to survive truncation.
 */

/** JSON, structurally — the shape an evaluation model accepts as its state. */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** One thing that happened, in order. The unit a window is measured in. */
export interface TraceEvent {
  kind: "user" | "said" | "tool";
  /** Index in the flattened event stream. */
  at: number;
  value: Json;
}

export interface Slice {
  /** Position among this conversation's slices. */
  index: number;
  /** Event range, `to` exclusive. */
  from: number;
  to: number;
  /**
   * `whole` = the entire conversation fit, so a question about the overall
   * arc is answerable. `window` = a span of a longer run; questions about
   * what happened "first" or "in the end" are NOT reliable here.
   */
  scope: "whole" | "window";
  /** What the judge reads. */
  state: { [key: string]: Json };
}

export interface SliceOptions {
  /**
   * Character budget for one slice's serialized state. Below this a
   * conversation stays whole. Default suits a small judge with room to spare —
   * the questions and the model's own overhead share its window.
   */
  budgetChars?: number;
  /** Events per window once slicing kicks in. */
  windowEvents?: number;
  /** How far each window advances. Less than `windowEvents` ⇒ overlap. */
  strideEvents?: number;
}

const MAX_TOOL_OUTPUT = 2_000;
const MAX_TOOL_ARGS = 400;
const MAX_MESSAGE_TEXT = 3_000;

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…[truncated]` : s);

const compact = (v: unknown, n: number): string => {
  if (v === undefined) return "";
  try {
    return clip(typeof v === "string" ? v : JSON.stringify(v), n);
  } catch {
    return "[unserializable]";
  }
};

/**
 * Stored messages → a flat, ordered event stream.
 *
 * Flattening past the message boundary is the point: one assistant message can
 * hold forty tool calls, so windowing by message would produce a single
 * enormous window and defeat the exercise.
 */
export function eventsOf(messages: unknown[]): TraceEvent[] {
  const events: TraceEvent[] = [];
  const push = (kind: TraceEvent["kind"], value: Json) => {
    events.push({ kind, at: events.length, value });
  };

  for (const m of transcriptOf(messages, { text: MAX_MESSAGE_TEXT, toolOutput: MAX_TOOL_OUTPUT })) {
    if (m.role === "user") {
      if (m.text) push("user", { user: m.text });
      continue;
    }
    // Tool calls before the assistant's own words, in both the event order and
    // each event: what the agent DID is evidence, what it said is a claim.
    for (const tc of m.toolCalls) {
      const tool: { [key: string]: Json } = { tool: tc.tool };
      if (tc.blocked) tool.blocked = true;
      tool.args = compact(tc.args, MAX_TOOL_ARGS);
      tool.result = tc.output ?? "";
      push("tool", tool);
    }
    if (m.text) push("said", { [m.role === "assistant" ? "agent_said" : m.role]: m.text });
  }
  return events;
}

/** The request that started it all — repeated on every window. */
const goalOf = (events: TraceEvent[]): string => {
  const first = events.find((e) => e.kind === "user");
  return first ? String((first.value as { user: string }).user) : "(no user message)";
};

const sizeOf = (state: unknown): number => JSON.stringify(state).length;

/**
 * Slice a conversation for judging.
 *
 * Returns at least one slice for a non-empty conversation, and exactly one
 * when everything fits.
 */
export function sliceTrace(messages: unknown[], options: SliceOptions = {}): Slice[] {
  const { budgetChars = 12_000, windowEvents = 12, strideEvents = 6 } = options;
  const events = eventsOf(messages);
  if (events.length === 0) return [];

  const whole: Slice = {
    index: 0,
    from: 0,
    to: events.length,
    scope: "whole",
    state: { conversation: events.map((e) => e.value) },
  };
  if (sizeOf(whole.state) <= budgetChars) return [whole];

  const goal = goalOf(events);
  const stride = Math.max(1, Math.min(strideEvents, windowEvents));
  const slices: Slice[] = [];
  for (let from = 0; from < events.length; from += stride) {
    const to = Math.min(from + windowEvents, events.length);
    const window = events.slice(from, to);
    slices.push({
      index: slices.length,
      from,
      to,
      scope: "window",
      state: {
        // The header is what makes a middle window answerable at all.
        goal,
        position: `events ${from + 1}-${to} of ${events.length}`,
        conversation: window.map((e) => e.value),
      },
    });
    // A final window that would only re-show the tail adds cost, not evidence.
    if (to === events.length) break;
  }
  return slices;
}

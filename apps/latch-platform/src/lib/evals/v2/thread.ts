/**
 * Reading a stored thread into the shape checks consume.
 *
 * One pass over the messages, and everything downstream — counted operators,
 * the judge's state, reports — reads from this rather than from raw parts.
 */

export interface ToolCall {
  tool: string;
  args?: unknown;
  result?: unknown;
  /** Hit its approval gate — asked for, or stubbed in a safe-mode run. */
  gated: boolean;
  /** Index of the turn it happened in, 0-based. */
  turn: number;
  /** Position in the whole thread, 0-based — what `before` compares. */
  seq: number;
}

export interface ThreadView {
  /** User messages, in order. */
  inputs: string[];
  /** Assistant text per turn. The last entry is the final answer. */
  outputs: string[];
  calls: ToolCall[];
  /**
   * Seq of the final answer's text block; a call below it came before the
   * agent answered. -1 when the thread never answered.
   */
  answeredAt: number;
}

const textOf = (parts: Record<string, unknown>[]): string =>
  parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("")
    .trim();

const isGated = (p: Record<string, unknown>): boolean => {
  const out = p.output as { __blocked?: boolean; __stubbed?: boolean } | undefined;
  const state = p.state as string | undefined;
  return (
    !!out?.__blocked ||
    !!out?.__stubbed ||
    state === "approval-requested" ||
    state === "approval-responded" ||
    state === "output-denied"
  );
};

export function viewOf(history: unknown[]): ThreadView {
  const view: ThreadView = { inputs: [], outputs: [], calls: [], answeredAt: -1 };
  const lastTextSeq: number[] = [];
  let turn = -1;
  let seq = 0;
  for (const m of history as { role?: string; parts?: Record<string, unknown>[] }[]) {
    const parts = m.parts ?? [];
    if (m.role === "user") {
      turn += 1;
      view.inputs.push(textOf(parts));
      continue;
    }
    if (m.role !== "assistant") continue;
    const t = Math.max(0, turn);
    for (const p of parts) {
      const type = p.type as string | undefined;
      if (!type) continue;
      if (type === "text" && typeof p.text === "string" && p.text.trim()) {
        // Text and tool calls share one sequence, so "before answering" can
        // mean what it says. The LAST text block is the answer: an agent that
        // says "let me look that up" and then calls a tool has not answered.
        lastTextSeq[t] = seq;
        seq += 1;
        continue;
      }
      if (type !== "dynamic-tool" && !type.startsWith("tool-")) continue;
      view.calls.push({
        tool: typeof p.toolName === "string" ? p.toolName : type.slice(5),
        args: p.input,
        result: p.output,
        gated: isGated(p),
        turn: t,
        seq: seq++,
      });
    }
    const text = textOf(parts);
    if (text) view.outputs[t] = text;
  }
  const last = view.outputs.length - 1;
  if (last >= 0 && lastTextSeq[last] !== undefined) view.answeredAt = lastTextSeq[last]!;
  return view;
}

/** The final answer, or empty when the agent produced none. */
export const finalAnswer = (v: ThreadView): string => v.outputs[v.outputs.length - 1] ?? "";

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return String(v);
  }
}

/**
 * The thread as a judge reads it: each turn's question, the tool calls with
 * their arguments AND results, then the answer.
 *
 * Tool calls come before the answer on purpose — what the agent did is
 * evidence, what it said about it is a claim. Results are capped per call and
 * the cap is always marked: a judge shown a document cut before the
 * supporting sentence correctly reports the claim unsupported, about a
 * perfectly grounded answer, and must be able to tell that happened.
 */
export function transcriptOf(v: ThreadView, caps = { total: 30_000, perResult: 4_000 }): string {
  const lines: string[] = [];
  let used = 0;
  let truncated = false;
  const push = (s: string) => {
    if (used + s.length > caps.total) {
      truncated = true;
      return false;
    }
    lines.push(s);
    used += s.length;
    return true;
  };
  for (let t = 0; t < Math.max(v.inputs.length, v.outputs.length); t++) {
    if (!push(`USER (turn ${t + 1}): ${v.inputs[t] ?? ""}`)) break;
    for (const c of v.calls.filter((x) => x.turn === t)) {
      const res = stringify(c.result);
      const shown =
        res.length > caps.perResult ? `${res.slice(0, caps.perResult)}…[truncated]` : res;
      if (!push(`  TOOL ${c.tool}${c.gated ? " (approval-gated)" : ""}\n    args: ${stringify(c.args)}\n    result: ${shown}`))
        break;
    }
    if (!push(`AGENT (turn ${t + 1}): ${v.outputs[t] ?? "(no answer)"}`)) break;
  }
  if (truncated) lines.push("…[truncated: the rest of the thread did not fit]");
  return lines.join("\n\n");
}

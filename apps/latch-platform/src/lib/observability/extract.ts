/** One tool call the agent made: its name plus a compact view of its input. */
export interface ToolCallView {
  name: string;
  args?: unknown;
  /** The tool's result — only rendered by the "loop" context scope. */
  output?: unknown;
}

/**
 * Minimal view of a finished turn for the online judge: the final assistant
 * text and the tool calls made — NAME plus a compact view of arguments, so
 * rubrics about *which* subagent was delegated to (`spawn_agent`'s agent arg)
 * or *what* was written where are judgeable, not just "some tool ran". Walks
 * the same UI-message part shapes as `transcriptOf`.
 */
export function extractRunView(messages: unknown[]): {
  outputText?: string;
  toolCalls: ToolCallView[];
} {
  const toolCalls: ToolCallView[] = [];
  let outputText: string | undefined;
  for (const m of messages) {
    const msg = m as { role?: string; parts?: Record<string, unknown>[] };
    if (msg.role !== "assistant") continue;
    const parts = msg.parts ?? [];
    for (const p of parts) {
      const type = p.type as string | undefined;
      if (!type) continue;
      if (type === "dynamic-tool" || type.startsWith("tool-")) {
        const name =
          typeof p.toolName === "string"
            ? p.toolName
            : type.startsWith("tool-")
              ? type.slice(5)
              : "unknown";
        toolCalls.push({ name, args: p.input, output: p.output });
      }
    }
    const text = parts
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("\n")
      .trim();
    if (text) outputText = text; // last assistant text wins
  }
  return { outputText, toolCalls };
}

/** Truncate a value for a judge-facing arg preview (long prompts stay compact). */
function previewValue(v: unknown, cap = 120): string {
  if (v == null) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > cap ? `${s.slice(0, cap)}…` : s;
}

/**
 * Render tool calls for a judge prompt: `name(key=value, …)` per call, with
 * each arg value truncated. The judge sees the names IN ORDER and the salient
 * arguments (e.g. `spawn_agent(agent=running-coach-memory-writer)`), without
 * dumping huge prompt/body payloads.
 */
export function summarizeToolCalls(toolCalls: ToolCallView[]): string {
  if (toolCalls.length === 0) return "none";
  return toolCalls.map(callHead).join("\n");
}

/** `name(key=value, …)` — the shared head of both tool-call renderings. */
function callHead(tc: ToolCallView): string {
  const args = tc.args;
  if (args == null || typeof args !== "object") return tc.name;
  const inner = Object.entries(args as Record<string, unknown>)
    .map(([k, v]) => `${k}=${previewValue(v)}`)
    .join(", ");
  return inner ? `${tc.name}(${inner})` : tc.name;
}

/** Caps for the two richer context scopes — bounded evidence, not transcript dumps. */
const CHAT_CONTEXT_CAP = 24_000;
const LOOP_OUTPUT_CAP = 2_000;
const LOOP_TRACE_CAP = 16_000;
/** A subagent's final answer inside a loop trace stays a one-liner. */
const SUBAGENT_ANSWER_CAP = 300;

/**
 * The "chat" context scope: the conversation's user/assistant TEXT so far
 * (tool noise excluded), oldest first, recency-capped — over budget, whole
 * oldest turns drop behind an explicit omission marker so the judge never
 * mistakes a truncated history for the full one.
 */
export function renderChatContext(messages: unknown[], cap = CHAT_CONTEXT_CAP): string {
  const lines: string[] = [];
  for (const m of messages) {
    const msg = m as { role?: string; parts?: Record<string, unknown>[] };
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    const text = (msg.parts ?? [])
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("\n")
      .trim();
    if (text) lines.push(`${msg.role.toUpperCase()}: ${text}`);
  }
  let start = 0;
  let size = lines.reduce((n, l) => n + l.length + 2, 0);
  while (start < lines.length - 1 && size > cap) {
    size -= lines[start].length + 2;
    start++;
  }
  // The loop always keeps the newest line, so a single oversized message could
  // escape the budget — hard-truncate retained lines to make the bound real
  // (judgeOnce documents `conversation` as pre-capped by the caller).
  const kept = lines
    .slice(start)
    .map((l) => (l.length > cap ? `${l.slice(0, cap)}…` : l));
  return (start > 0 ? ["[earlier turns omitted]", ...kept] : kept).join("\n\n");
}

/**
 * The "loop" context scope's tool trace: every call with its head AND its
 * output (per-output truncated). A `spawn_agent` call renders as a one-line
 * subagent summary — who was delegated to and what they answered — never the
 * sub-thread's transcript. Over the total budget, trailing calls are dropped
 * behind an explicit count marker.
 */
export function summarizeToolLoop(toolCalls: ToolCallView[], cap = LOOP_TRACE_CAP): string {
  if (toolCalls.length === 0) return "none";
  const entries = toolCalls.map((tc) => {
    if (tc.name === "spawn_agent") {
      const answer = (tc.output as { answer?: unknown } | undefined)?.answer;
      return `${callHead(tc)} → subagent answered: ${previewValue(answer ?? "(no answer)", SUBAGENT_ANSWER_CAP)}`;
    }
    if (tc.output === undefined) return callHead(tc);
    return `${callHead(tc)}\n  → ${previewValue(tc.output, LOOP_OUTPUT_CAP)}`;
  });
  const kept: string[] = [];
  let size = 0;
  for (const e of entries) {
    if (size + e.length > cap && kept.length > 0) {
      kept.push(`[… ${entries.length - kept.length} more tool call(s) omitted]`);
      break;
    }
    kept.push(e);
    size += e.length + 1;
  }
  return kept.join("\n");
}

/**
 * The "loop" context scope's answer: EVERY assistant text part of the turn (in
 * order), not just the final one — so a judge can see intermediate narration
 * between tool calls.
 */
export function allAssistantText(messages: unknown[]): string {
  const texts: string[] = [];
  for (const m of messages) {
    const msg = m as { role?: string; parts?: Record<string, unknown>[] };
    if (msg.role !== "assistant") continue;
    for (const p of msg.parts ?? []) {
      if (p.type === "text" && typeof p.text === "string" && (p.text).trim()) {
        texts.push((p.text).trim());
      }
    }
  }
  return texts.join("\n\n");
}

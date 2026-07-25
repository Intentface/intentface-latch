/** One tool call the agent made: its name plus a compact view of its input. */
export interface ToolCallView {
  name: string;
  args?: unknown;
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
        toolCalls.push({ name, args: p.input });
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
  return toolCalls
    .map((tc) => {
      const args = tc.args;
      if (args == null || typeof args !== "object") return tc.name;
      const inner = Object.entries(args as Record<string, unknown>)
        .map(([k, v]) => `${k}=${previewValue(v)}`)
        .join(", ");
      return inner ? `${tc.name}(${inner})` : tc.name;
    })
    .join("\n");
}

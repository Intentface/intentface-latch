/**
 * Minimal view of a finished turn for the online judge: the final assistant
 * text and the tool NAMES called (args stay out of judge prompts, same as the
 * batch eval tier). Walks the same UI-message part shapes as `transcriptOf`.
 */
export function extractRunView(messages: unknown[]): {
  outputText?: string;
  toolNames: string[];
} {
  const toolNames: string[] = [];
  let outputText: string | undefined;
  for (const m of messages) {
    const msg = m as { role?: string; parts?: Record<string, unknown>[] };
    if (msg.role !== "assistant") continue;
    const parts = msg.parts ?? [];
    for (const p of parts) {
      const type = p.type as string | undefined;
      if (!type) continue;
      if (type === "dynamic-tool" || type.startsWith("tool-")) {
        toolNames.push(
          typeof p.toolName === "string"
            ? p.toolName
            : type.startsWith("tool-")
              ? type.slice(5)
              : "unknown",
        );
      }
    }
    const text = parts
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("\n")
      .trim();
    if (text) outputText = text; // last assistant text wins
  }
  return { outputText, toolNames };
}

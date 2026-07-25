import { jsonSchema, parseJsonEventStream } from "ai";
import type { UIMessageChunk } from "ai";
import type { AppMessage } from "@intentface/latch-core";
import type { PendingApproval, RenderEvent } from "./types.js";

/**
 * Fold a Latch run's streaming `Response` (the SSE the chat handler speaks —
 * `runtime.handleChat` / `applyApproval` / `applyToolResult` all return it) into
 * normalized `RenderEvent`s. Server-side and transport-agnostic: it consumes the
 * public SSE contract, so a channel works whether the runtime is in-process or a
 * remote Latch over HTTP.
 *
 * Approvals are intentionally NOT derived here — they are persisted message
 * state, not stream chunks. After this generator finishes, ask
 * {@link pendingApprovals} against fresh history.
 */
export async function* consumeRun(response: Response): AsyncGenerator<RenderEvent> {
  if (!response.body) return;

  const stream = parseJsonEventStream({
    stream: response.body,
    schema: jsonSchema<UIMessageChunk>({}),
  });
  const reader = stream.getReader();

  // tool-input-start gives us the name; tool-output-* only the id — remember it.
  const toolNames = new Map<string, string>();

  yield { type: "status", status: "working" };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value.success) continue;
      const chunk = value.value;

      switch (chunk.type) {
        case "text-delta":
          if (chunk.delta) yield { type: "text-delta", text: chunk.delta };
          break;
        case "reasoning-delta":
          if (chunk.delta) yield { type: "reasoning-delta", text: chunk.delta };
          break;
        case "tool-input-start":
          toolNames.set(chunk.toolCallId, chunk.toolName);
          break;
        case "tool-input-available":
          toolNames.set(chunk.toolCallId, chunk.toolName);
          yield {
            type: "tool-start",
            toolCallId: chunk.toolCallId,
            toolName: chunk.toolName,
            input: chunk.input,
          };
          break;
        case "tool-output-available":
          yield {
            type: "tool-end",
            toolCallId: chunk.toolCallId,
            toolName: toolNames.get(chunk.toolCallId) ?? "",
            output: chunk.output,
          };
          break;
        case "tool-output-error":
          yield {
            type: "tool-end",
            toolCallId: chunk.toolCallId,
            toolName: toolNames.get(chunk.toolCallId) ?? "",
            error: chunk.errorText,
          };
          break;
        case "error":
          yield { type: "error", message: chunk.errorText || "The run failed." };
          break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  yield { type: "finish" };
}

// ── Approvals (from persisted history, not the stream) ──────────────────────

const CONNECT_PREFIX = "connect_";

type ToolPartLike = {
  type: string;
  state?: string;
  toolName?: string;
  input?: unknown;
  approval?: { id?: string; approved?: boolean };
};

/** Bare tool name for a tool part (`tool-web_search` → `web_search`). */
function toolNameOf(part: ToolPartLike): string {
  if (part.type === "dynamic-tool") return part.toolName ?? "";
  return part.type.replace(/^tool-/, "");
}

/**
 * Scan history for tool parts parked in `approval-requested` with an undecided
 * approval — the HITL prompts a channel should render as buttons (or, for
 * `connect_*`, an authorize link). Mirrors the web UI's `renderApproval` filter.
 */
export function pendingApprovals(messages: AppMessage[]): PendingApproval[] {
  const out: PendingApproval[] = [];
  for (const msg of messages) {
    for (const part of (msg.parts ?? []) as ToolPartLike[]) {
      // A gated tool inside a spawned subagent bubbles up as a
      // `data-subagent-approval` part (not a tool part). Surface it so the
      // channel renders Approve/Deny; the decision routes via applyApproval.
      const sub = part as {
        type: string;
        data?: { approvalId?: string; summaries?: string[]; approved?: boolean };
      };
      if (sub.type === "data-subagent-approval") {
        if (sub.data?.approvalId && sub.data.approved === undefined) {
          out.push({
            approvalId: sub.data.approvalId,
            toolName: sub.data.summaries?.join(", ") || "connector action",
            input: undefined,
            isConnect: false,
          });
        }
        continue;
      }
      const isTool = part.type === "dynamic-tool" || part.type.startsWith("tool-");
      if (!isTool) continue;
      if (part.state !== "approval-requested") continue;
      const approvalId = part.approval?.id;
      if (!approvalId || part.approval?.approved !== undefined) continue;

      const toolName = toolNameOf(part);
      const isConnect = toolName.startsWith(CONNECT_PREFIX);
      out.push({
        approvalId,
        toolName,
        input: part.input,
        isConnect,
        connectionName: isConnect ? toolName.slice(CONNECT_PREFIX.length) : undefined,
      });
    }
  }
  return out;
}

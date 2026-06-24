/**
 * Platform-agnostic vocabulary for bringing a Latch run to a chat surface.
 *
 * A channel adapter (Slack, Teams, …) only ever sees `RenderEvent`s — the
 * normalized, surface-independent shape of what an agent is doing — and maps
 * them to its platform's primitives (a streamed message, a status line, an
 * approval card). The mapping from a Latch run's raw UIMessage part-stream to
 * these events lives once in `render.ts`, so a new platform is "translate
 * RenderEvents", never "re-parse the AI stream".
 */

/** A single thing worth showing on a chat surface as a run progresses. */
export type RenderEvent =
  /** Coarse run lifecycle, for typing/status indicators. */
  | { type: "status"; status: RunStatus }
  /** A chunk of the assistant's visible answer. */
  | { type: "text-delta"; text: string }
  /** A chunk of reasoning/thinking (render collapsed or throttled). */
  | { type: "reasoning-delta"; text: string }
  /** A tool call started (we know its name + input). */
  | { type: "tool-start"; toolCallId: string; toolName: string; input?: unknown }
  /** A tool call settled with a result or an error. */
  | {
      type: "tool-end";
      toolCallId: string;
      toolName: string;
      output?: unknown;
      error?: string;
    }
  /** The streamed turn ended (may still be paused awaiting approval — see status). */
  | { type: "finish" };

export type RunStatus = "thinking" | "working" | "awaiting_input" | "done" | "error";

/**
 * A pending human-in-the-loop decision surfaced after a turn pauses. Detected
 * from persisted history (not the live chunk stream), because approvals are
 * message state, not stream chunks.
 */
export interface PendingApproval {
  /** The opaque approval id to pass back to `runtime.applyApproval`. */
  approvalId: string;
  /** The tool awaiting approval (bare name, e.g. `web_search`). */
  toolName: string;
  /** The tool input the model proposed, for display. */
  input?: unknown;
  /**
   * OAuth "connect a connection" approvals (`connect_<name>`) are special: they
   * resolve by sending the user through the platform's authorize URL, not by an
   * approve/deny button. `connectionName` is the `<name>` part.
   */
  isConnect: boolean;
  connectionName?: string;
}

/** A tool-name → approval policy view, for rendering an agent's capabilities. */
export interface ToolCapability {
  name: string;
  description?: string;
  /** Whether calling this tool pauses for user approval. */
  requiresApproval: boolean;
}

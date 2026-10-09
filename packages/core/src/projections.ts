import { convertToModelMessages, type ModelMessage } from "ai";
import type { AppMessage } from "./message.js";

/**
 * The one data part a client may attach to its message: what the user is
 * looking at while they write it (the open file, the selection, a model pick).
 * The model reads it as text next to what they wrote; chat UIs don't render
 * data parts, so the user doesn't see it. See `RuntimeConfig.messageContext`.
 */
export const CONTEXT_PART_TYPE = "data-context" as const;


/**
 * The two message projections (see `message.ts`). `AppMessage` is the stored
 * source of truth; these derive what each *audience* sees, reading the two
 * metadata axes. Both default permissively: absent `visibility` → shown to the
 * user; absent `sendToModel` → fed to the model. Exceptions are explicit.
 */

/** Client projection: keep user-visible messages, drop `internal`/`redacted`. */
export function toClientMessages(messages: AppMessage[]): AppMessage[] {
  return messages.filter((m) => (m.metadata?.visibility ?? "user") === "user");
}

/**
 * Close any tool call left without a result — an undecided `approval-requested`
 * part, or a tool that was still running when the turn was interrupted (e.g. the
 * user sent a new message before it finished). `convertToModelMessages` throws
 * (and Anthropic rejects) on a `tool_use` with no following `tool_result`, so we
 * give such parts a synthetic terminal output. Projection-only — the stored
 * history is untouched; the synthetic result just keeps the model view valid.
 */
function closeDanglingToolCalls(messages: AppMessage[]): AppMessage[] {
  const lastIndex = messages.length - 1;
  return messages.map((m, i) => {
    const parts = (m as { parts?: Record<string, unknown>[] }).parts;
    if (m.role !== "assistant" || !Array.isArray(parts)) return m;
    // Tail = the final message of the history: the continuation the tool loop
    // re-runs. Only there will an approved-but-unexecuted call actually execute.
    const isTail = i === lastIndex;
    let changed = false;
    const next = parts.map((p) => {
      const type = typeof p.type === "string" ? p.type : "";
      const isToolCall = type === "dynamic-tool" || type.startsWith("tool-");
      if (!isToolCall) return p;
      const state = p.state as string | undefined;
      const approval = p.approval as { approved?: boolean } | undefined;
      // Close ONLY calls that nothing will resolve:
      //  - an interrupted execution (a call with no result, no approval flow),
      //  - an UN-decided approval (abandoned by a new message instead of a decision), or
      //  - an APPROVED call with no result that is no longer the tail — its
      //    continuation was interrupted (crash/restart mid-execution) and a later
      //    message buried it, so no re-run will ever execute it.
      // Leave tail-position approved calls and denied approvals alone — the
      // re-run executes the former; the SDK synthesizes a denial result for the latter.
      const interrupted = state === "input-available" || state === "input-streaming";
      const undecidedApproval =
        state === "approval-requested" && (!approval || approval.approved === undefined);
      const buriedApproved =
        !isTail &&
        state === "approval-responded" &&
        approval?.approved === true &&
        p.output == null;
      if (!interrupted && !undecidedApproval && !buriedApproved) return p;
      changed = true;
      return {
        ...p,
        state: "output-available",
        output: p.output ?? {
          interrupted: true,
          reason: "Not completed — superseded by a new message before this tool finished.",
        },
      };
    });
    return changed ? ({ ...m, parts: next } as AppMessage) : m;
  });
}

/**
 * Replace audio file parts with a text placeholder. Voice messages ingested
 * before channel-side transcription existed were stored as `audio/*` file
 * parts, and a chat model without audio input (Anthropic) rejects the whole
 * prompt — bricking every later turn of that chat. Projection-only — the
 * stored history keeps the original part.
 */
function replaceAudioFileParts(messages: AppMessage[]): AppMessage[] {
  return messages.map((m) => {
    const parts = (m as { parts?: Record<string, unknown>[] }).parts;
    if (!Array.isArray(parts)) return m;
    let changed = false;
    const next = parts.map((p) => {
      const isAudio =
        p.type === "file" && typeof p.mediaType === "string" && p.mediaType.startsWith("audio/");
      if (!isAudio) return p;
      changed = true;
      const name = typeof p.filename === "string" ? p.filename : "audio";
      return {
        type: "text",
        text: `[A voice message ("${name}") was attached here but could not be included — audio input is not supported.]`,
      };
    });
    return changed ? ({ ...m, parts: next } as AppMessage) : m;
  });
}

/** The part type that marks a compaction boundary (see `sliceAtCompaction`). */
export const COMPACTION_PART_TYPE = "data-compaction";

/**
 * The live context window: everything from the LAST compaction marker onward.
 *
 * `compactChat` summarizes a conversation and appends the summary as one message
 * carrying a `data-compaction` part; from then on the model sees that summary
 * instead of the turns it replaces, while stored history — and the client
 * projection — keep everything. No marker → the messages unchanged, so chats
 * that were never compacted are untouched.
 *
 * Slicing at a marker can orphan a `tool_result` from its `tool_use` only if the
 * two straddled the boundary, which can't happen: the marker is appended at the
 * tail of a settled conversation, so a call and its result are always on the
 * same side of it.
 */
export function sliceAtCompaction(messages: AppMessage[]): AppMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = (messages[i] as { parts?: { type?: unknown }[] }).parts;
    // A summary hidden from the model (replaced by a regenerate or an edit of
    // the question before it) is no longer a boundary: the context reaches back
    // to the previous one, as it did before that summary was written.
    if (messages[i]!.metadata?.sendToModel === false) continue;
    if (Array.isArray(parts) && parts.some((p) => p.type === COMPACTION_PART_TYPE)) {
      return messages.slice(i);
    }
  }
  return messages;
}

/**
 * Model projection: cut to the live context window, drop `sendToModel === false`,
 * neutralize audio file parts, close any dangling tool calls, then convert to
 * model messages. (`data-*` parts — e.g. the compaction marker — are dropped by
 * the SDK during conversion, so they never reach the model.)
 */
export async function toModelMessages(
  messages: AppMessage[],
  opts?: {
    tools?: Record<string, unknown>;
    /**
     * How a message's `data-context` part reads to the model. Return
     * `undefined` to leave it out. Defaults to {@link defaultContextText}.
     */
    contextToText?: (data: unknown) => string | undefined;
  },
): Promise<ModelMessage[]> {
  const forModel = closeDanglingToolCalls(
    replaceAudioFileParts(
      sliceAtCompaction(messages).filter((m) => m.metadata?.sendToModel !== false),
    ),
  );
  const toText = opts?.contextToText ?? defaultContextText;
  return convertToModelMessages(forModel as never, {
    ...(opts?.tools ? { tools: opts.tools } : {}),
    // Only the client's context part becomes text, where the client put it in
    // the message; every other data part (Latch's own, extensions') is left
    // out, as it always was.
    convertDataPart: (part: { type: string; data: unknown }) => {
      if (part.type !== CONTEXT_PART_TYPE) return undefined;
      const text = toText(part.data);
      return text ? { type: "text" as const, text } : undefined;
    },
  } as never);
}

/**
 * How a `data-context` part reads to the model when no `toModel` is set: a
 * labelled block, one `key: value` line per field, nested values as JSON.
 *
 * ```
 * [Context]
 * activeFile: Q3 budget
 * openTabs: ["Roadmap","Hiring plan"]
 * ```
 */
export function defaultContextText(data: unknown): string | undefined {
  if (data == null) return undefined;
  if (typeof data !== "object" || Array.isArray(data)) return `[Context]\n${typeof data === "string" ? data : JSON.stringify(data)}`;
  const lines = Object.entries(data as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  return lines.length ? `[Context]\n${lines.join("\n")}` : undefined;
}

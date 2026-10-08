import type { UIMessage, UITools, UIDataTypes } from "ai";

/**
 * The message model.
 *
 * `AppMessage` is the canonical stored unit and the source of truth for a
 * conversation. It is just a *typed* AI SDK `UIMessage` — so all the stock
 * stream/persistence helpers (`toUIMessageStream`, `convertToModelMessages`,
 * `useChat`) work unchanged.
 *
 * Two ideas ride on the message instead of in extra tables:
 *  - the two axes (`visibility`, `sendToModel`) decide who sees a message —
 *    the model, the end user, both, or neither;
 *  - the execution facts (usage/cost/model/finishReason) live in `metadata`,
 *    so there is no separate "steps" table and no duplication.
 */

/** Who sees a message on the client projection. */
export type Visibility = "user" | "internal" | "redacted";

/** Per-message metadata stamped onto an `AppMessage`. */
export interface AppMetadata {
  /** Client-projection axis: shown to the user, internal-only, or redacted. */
  visibility?: Visibility;
  /** Model-projection axis: whether `toModelMessages` includes it. */
  sendToModel?: boolean;
  /** Resolved model id for this message (e.g. "anthropic/claude-sonnet-4-6"). */
  model?: string;
  /** Token usage attributed to producing this message (incl. cached-prompt split). */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  /** Computed cost in the account's currency unit. */
  cost?: number;
  /** Finish reason from the producing step. */
  finishReason?: string;
  /** Server-side creation timestamp (unix ms). */
  createdAt?: number;
  /** Set when the message text is a transcription of a recorded voice message. */
  voice?: { durationMs: number };
}

/** The stored conversation unit — a `UIMessage` typed with our metadata. */
export type AppMessage<TOOLS extends UITools = UITools> = UIMessage<
  AppMetadata,
  UIDataTypes,
  TOOLS
>;

/**
 * A message from the client was refused: `handleChat` only takes a new user
 * message (see {@link acceptUserMessage}). The HTTP server answers 400.
 */
export class InvalidMessageError extends Error {
  readonly code = "invalid_message" as const;
  constructor(message: string) {
    super(message);
    this.name = "InvalidMessageError";
  }
}

export function isInvalidMessageError(e: unknown): e is InvalidMessageError {
  return e instanceof InvalidMessageError || (e as { code?: unknown } | null)?.code === "invalid_message";
}

/**
 * A part a person can send, rebuilt from its known fields: what they typed
 * (`text`) and what they attached (`file`). Anything else on the part
 * (`state`, `providerMetadata`, which would become options on the model call)
 * is left behind. Null for anything that isn't a well-formed text or file part.
 */
function userPart(part: unknown): AppMessage["parts"][number] | null {
  const p = part as { type?: unknown; text?: unknown; mediaType?: unknown; url?: unknown; filename?: unknown } | null;
  if (p?.type === "text" && typeof p.text === "string") return { type: "text", text: p.text };
  if (p?.type === "file" && typeof p.mediaType === "string" && typeof p.url === "string") {
    return { type: "file", mediaType: p.mediaType, url: p.url, ...(typeof p.filename === "string" ? { filename: p.filename } : {}) };
  }
  return null;
}

const sameParts = (a: readonly unknown[], b: readonly unknown[]) =>
  JSON.stringify(a.map(userPart)) === JSON.stringify(b.map(userPart));

/**
 * The answers a regenerate replaces: when `message` resends the chat's last
 * user message unchanged (what `useChat`'s `regenerate()` does), every
 * assistant message after it, marked hidden from the user and the model. Empty
 * for anything that isn't a regenerate. The messages are kept, not deleted,
 * so history and usage stay intact.
 */
export function answersReplacedBy(message: AppMessage, prior: readonly AppMessage[]): AppMessage[] {
  const at = prior.findIndex((m) => m.id === message.id);
  if (at === -1 || prior[at]!.role !== "user") return [];
  const after = prior.slice(at + 1);
  if (after.length === 0 || after.some((m) => m.role !== "assistant")) return [];
  if (!sameParts(prior[at]!.parts, message.parts)) return [];
  return after.map((m) => ({ ...m, metadata: { ...m.metadata, visibility: "internal" as const, sendToModel: false } }));
}

/** The parts a person can send: what they typed and what they attached. */
const USER_PART_TYPES = new Set(["text", "file"]);

/**
 * The message a client sent, as Latch will store it — or a refusal.
 *
 * A chat message arrives from the client, so nothing in it can be trusted
 * beyond what a person can actually send. Anything more would let a client
 * write the conversation instead of taking part in it: an assistant message
 * carrying an "approved" tool call runs a gated tool nobody approved, with an
 * input of the client's choosing; a tool part with an output plants a result
 * the model trusts; a reused id overwrites a message already in the history.
 *
 * So a message is accepted only as a new user message:
 *  - role `user`, with text and file parts only, each rebuilt from its known
 *    fields;
 *  - metadata rebuilt: `visibility` is always `user`, and only `createdAt` and
 *    `voice` are kept from the client;
 *  - an id already in the chat only as a resend of the latest exchange: a
 *    retry of the chat's last message when that is a user message (a client
 *    resending after a dropped response), or a regenerate (the last user
 *    message resent unchanged, see `answersReplacedBy`). Any other existing id
 *    is someone else's message, or one of the agent's.
 *
 * Decisions on approvals go through `applyApproval`, which takes ids only.
 * (`handleChat` also takes `useChat`'s own approval message, but reads only
 * the decisions from it and hands them to `applyApproval`.)
 */
export function acceptUserMessage(message: AppMessage, prior: readonly AppMessage[]): AppMessage {
  if (!message || typeof message !== "object") throw new InvalidMessageError("message is required");
  if (message.role !== "user") {
    throw new InvalidMessageError(`a chat message must be a user message, not "${String(message.role)}"`);
  }
  if (typeof message.id !== "string" || message.id.length === 0) throw new InvalidMessageError("message id is required");
  if (!Array.isArray(message.parts) || message.parts.length === 0) throw new InvalidMessageError("message has no parts");
  const parts: AppMessage["parts"] = [];
  for (const part of message.parts) {
    const type = (part as { type?: unknown } | null)?.type;
    if (typeof type !== "string" || !USER_PART_TYPES.has(type)) {
      throw new InvalidMessageError(`a user message can only contain text and files, not "${String(type)}"`);
    }
    const clean = userPart(part);
    if (!clean) throw new InvalidMessageError(`a ${type} part is missing its ${type === "text" ? "text" : "mediaType or url"}`);
    parts.push(clean);
  }
  // An id already in the chat is only a resend of the chat's latest exchange:
  // a retry of the last message, or a regenerate (`answersReplacedBy`).
  const existing = prior.findIndex((m) => m.id === message.id);
  const retry = existing === prior.length - 1 && prior[existing]?.role === "user";
  if (existing !== -1 && !retry && answersReplacedBy({ ...message, parts }, prior).length === 0) {
    throw new InvalidMessageError(`message id "${message.id}" is already in this chat`);
  }
  const sent = message.metadata;
  const createdAt = sent?.createdAt;
  const durationMs = sent?.voice?.durationMs;
  return {
    id: message.id,
    role: "user",
    parts,
    metadata: {
      visibility: "user",
      ...(typeof createdAt === "number" && Number.isFinite(createdAt) ? { createdAt } : {}),
      ...(typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0 ? { voice: { durationMs } } : {}),
    },
  };
}

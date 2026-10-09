import type { UIMessage, UITools, UIDataTypes } from "ai";
import { COMPACTION_PART_TYPE } from "./projections.js";

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
 * (`text`) and what they attached (`file`, in every form the AI SDK accepts:
 * a hosted or data URL, and a `providerReference` from the SDK's `uploadFile`).
 * Anything else on the part is left behind: `state`, and `providerMetadata`,
 * which would become options on the model call. Null for anything that isn't a
 * well-formed text or file part.
 */
function userPart(part: unknown): AppMessage["parts"][number] | null {
  const p = part as {
    type?: unknown;
    text?: unknown;
    mediaType?: unknown;
    url?: unknown;
    filename?: unknown;
    providerReference?: unknown;
  } | null;
  if (p?.type === "text" && typeof p.text === "string") return { type: "text", text: p.text };
  if (p?.type === "file" && typeof p.mediaType === "string" && typeof p.url === "string") {
    const ref = providerReferenceOf(p.providerReference);
    return {
      type: "file",
      mediaType: p.mediaType,
      url: p.url,
      ...(typeof p.filename === "string" ? { filename: p.filename } : {}),
      ...(ref ? { providerReference: ref } : {}),
    };
  }
  return null;
}

/** A `providerReference` as the SDK defines it: provider name → file id, all strings. */
function providerReferenceOf(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0 || entries.some(([k, v]) => k === "type" || typeof v !== "string")) return undefined;
  return Object.fromEntries(entries) as Record<string, string>;
}

const sameParts = (a: readonly unknown[], b: readonly unknown[]) =>
  JSON.stringify(a.map(userPart)) === JSON.stringify(b.map(userPart));

/** Hidden from the user and the model, but kept: what a regenerate or an edit replaced. */
export const isHidden = (m: AppMessage): boolean => m.metadata?.sendToModel === false && m.metadata?.visibility === "internal";

const hide = (m: AppMessage): AppMessage => ({ ...m, metadata: { ...m.metadata, visibility: "internal", sendToModel: false } });

/**
 * What resending the chat's last question replaces, when `message` does that:
 *  - unchanged (`useChat`'s `regenerate()`): the answers after it;
 *  - changed (`sendMessage({ messageId })`, an edit): the answers after it,
 *    plus the question's earlier wording, kept under a new id. The edited
 *    question keeps the client's id, so the client can edit it again.
 *
 * A compaction summary written after the question is replaced too: it
 * summarizes the answers being replaced.
 *
 * Each is returned hidden from the user and the model. Nothing is deleted, so
 * history and usage stay intact. Null when `message` doesn't resend the last
 * question with at least one answer after it. Messages hidden earlier don't
 * count: only what the user can still see.
 */
export function lastQuestionResent(message: AppMessage, prior: readonly AppMessage[]): AppMessage[] | null {
  const visible = prior.filter((m) => !isHidden(m));
  const at = visible.findIndex((m) => m.id === message.id);
  if (at === -1 || visible[at]!.role !== "user") return null;
  // After it: the answers, and possibly a compaction summary written since.
  // The summary covers the answers being replaced, so it is hidden with them,
  // and the model's context goes back to what it was before that compaction.
  const answers = visible.slice(at + 1);
  const isSummary = (m: AppMessage) => m.parts.some((p) => p.type === COMPACTION_PART_TYPE);
  if (!answers.some((m) => m.role === "assistant")) return null;
  if (answers.some((m) => m.role !== "assistant" && !isSummary(m))) return null;
  const replaced = answers.map(hide);
  if (!sameParts(visible[at]!.parts, message.parts)) {
    replaced.push(hide({ ...visible[at]!, id: `msg_${crypto.randomUUID().replace(/-/g, "")}` }));
  }
  return replaced;
}

/**
 * A resend Latch doesn't do in place: regenerating or editing a question that
 * later questions build on. In one chat that would hide messages after it,
 * possibly what the agent did since, or a colleague's messages in a shared
 * chat. Fork the chat at that question instead. The HTTP server answers 409.
 */
export class RewindNotSupportedError extends Error {
  readonly code = "rewind_not_supported" as const;
  constructor(readonly messageId: string) {
    super(
      `message "${messageId}" has later messages after it: only the last question can be regenerated or edited in place; fork the chat to change an earlier one`,
    );
    this.name = "RewindNotSupportedError";
  }
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
 *  - files sent inline (`data:` URLs) total at most `maxInlineFileBytes`;
 *  - metadata rebuilt: `visibility` is always `user`, and only `createdAt` and
 *    `voice` are kept from the client;
 *  - an id already in the chat only as a resend of the latest exchange: a
 *    retry of the chat's last message when that is a user message (a client
 *    resending after a dropped response), or the last question regenerated or
 *    edited (see `lastQuestionResent`). An earlier question is refused with
 *    `RewindNotSupportedError` (fork the chat instead); any other existing id
 *    is one of the agent's messages, or one that was hidden.
 *
 * Decisions on approvals go through `applyApproval`, which takes ids only.
 * (`handleChat` also takes `useChat`'s own approval message, but reads only
 * the decisions from it and hands them to `applyApproval`.)
 */
/** Default cap on files sent inline (as `data:` URLs) in one message: 20 MB. */
export const MAX_INLINE_FILE_BYTES = 20 * 1024 * 1024;

/** The decoded size of a `data:` URL, or 0 for any other URL. */
function inlineBytes(url: string): number {
  // URL schemes are case-insensitive: "DATA:" is inline data too.
  if (!/^data:/i.test(url)) return 0;
  const comma = url.indexOf(",");
  if (comma === -1) return 0;
  const body = url.slice(comma + 1);
  if (/;base64$/i.test(url.slice(0, comma))) {
    const padding = body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0;
    return Math.floor((body.length * 3) / 4) - padding;
  }
  try {
    return new TextEncoder().encode(decodeURIComponent(body)).byteLength;
  } catch {
    return body.length;
  }
}

export function acceptUserMessage(
  message: AppMessage,
  prior: readonly AppMessage[],
  opts: { maxInlineFileBytes?: number } = {},
): AppMessage {
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
  // Files sent inline travel in the request and are stored in the message
  // row, then reloaded on every turn: cap them. Larger files belong in
  // storage, referenced by URL.
  const maxInline = opts.maxInlineFileBytes ?? MAX_INLINE_FILE_BYTES;
  const inline = parts.reduce((n, p) => n + (p.type === "file" ? inlineBytes(p.url) : 0), 0);
  if (inline > maxInline) {
    throw new InvalidMessageError(
      `files sent inline total ${inline} bytes, over the ${maxInline}-byte limit: send larger files by URL`,
    );
  }
  // An id already in the chat is only a resend of the chat's latest exchange:
  // a retry of the last message, or the last question regenerated or edited
  // (`lastQuestionResent`). An earlier question is a rewind, which belongs in
  // a fork; any other id is one of the agent's messages.
  const visible = prior.filter((m) => !isHidden(m));
  const existing = visible.findIndex((m) => m.id === message.id);
  const retry = existing === visible.length - 1 && visible[existing]?.role === "user";
  if (existing !== -1 && !retry && !lastQuestionResent({ ...message, parts }, prior)) {
    if (visible[existing]!.role === "user") throw new RewindNotSupportedError(message.id);
    throw new InvalidMessageError(`message id "${message.id}" is already in this chat`);
  }
  if (existing === -1 && prior.some((m) => m.id === message.id)) {
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

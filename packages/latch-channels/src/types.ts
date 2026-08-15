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

import type { AppMessage } from "@intentface/latch-core";

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
  /** The run failed; `message` is the error text to surface to the user. */
  | { type: "error"; message: string }
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

/** One choice on an `askUser` question. `label` goes on the button. */
export interface QuestionOption {
  label: string;
  description: string;
}

/** One question from an `askUser` call (mirrors `AskUserQuestion` in the platform UI). */
export interface Question {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

/**
 * A questionnaire a paused turn is waiting on — an `askUser` tool call parked in
 * `input-available`. Unlike an approval it resolves through
 * `runtime.applyToolResult`, and ALL questions resolve in one call, so a channel
 * must collect every answer before submitting.
 */
export interface PendingQuestion {
  /** The tool call to resolve via `runtime.applyToolResult`. */
  toolCallId: string;
  questions: Question[];
}

/**
 * A questionnaire in progress on a chat surface — at most one per chat.
 *
 * Chat surfaces answer one question at a time, but `applyToolResult` closes the
 * whole tool call in one shot, so the answers collected so far have to live
 * somewhere between taps. Serverless channels have no memory between webhook
 * deliveries, hence a host-backed store.
 */
export interface AskSession {
  /** The parked `askUser` call these answers will resolve. */
  toolCallId: string;
  /** Freshness token carried in button payloads so stale buttons are rejected. */
  nonce: string;
  /** The questions as posted — avoids a history read on every tap. */
  questions: Question[];
  /** Index of the question currently on screen. */
  cursor: number;
  /** question text → committed answer, for questions already answered. */
  answers: Record<string, string>;
  /** Option indices ticked so far on the current `multiSelect` question. */
  selected: number[];
  /** Platform chat to post questions into (the Telegram/WhatsApp chat id). */
  promptChatId: string;
  /** Platform id of the visible prompt message (cosmetic — used to edit it). */
  promptRef?: string;
  /** Fence for optimistic concurrency; every successful write bumps it. */
  rev: number;
}

/**
 * Host-backed storage for in-flight questionnaires, injected like `seen` and
 * `claimTurn`. Grouped into one object because these are a single transactional
 * aggregate over one row — partial wiring is a bug, not a degradation, so a
 * channel checks for the whole store or renders questions as plain text.
 */
export interface AskStateStore {
  /** The live session for this chat, or null (expired rows count as absent). */
  get(chatId: string): Promise<AskSession | null>;
  /**
   * Claim the right to prompt. Replaces a session for a DIFFERENT tool call,
   * but leaves one for the SAME tool call untouched and answers `"already"` —
   * so re-rendering a still-pending questionnaire never double-prompts.
   */
  begin(chatId: string, session: Omit<AskSession, "rev">): Promise<"started" | "already">;
  /** Fenced patch. Returns the new rev, or null when `rev` was stale. */
  update(
    chatId: string,
    toolCallId: string,
    rev: number,
    patch: Partial<Pick<AskSession, "cursor" | "answers" | "selected" | "promptRef">>,
  ): Promise<number | null>;
  /** Fenced delete — true only if THIS caller removed it. Gates the submit. */
  finish(chatId: string, toolCallId: string, rev: number): Promise<boolean>;
  /** Unconditional drop, returning whatever was removed. */
  clear(chatId: string): Promise<AskSession | null>;
}

/**
 * Host-backed "which thread am I in" pointer for surfaces that have exactly one
 * conversation per person (a Telegram DM, a WhatsApp thread) and therefore no
 * native way to start a new one. `/new` bumps the epoch; the channel derives the
 * chat id from it, so epoch 0 keeps the original id and existing conversations
 * never move.
 */
export interface ChannelThreadStore {
  /** Current epoch for a surface conversation; 0 when it has never rotated. */
  current(baseChatId: string): Promise<number>;
  /** Start a fresh thread; returns the new (higher) epoch. */
  rotate(baseChatId: string): Promise<number>;
}

/**
 * The subset of the Latch runtime a channel drives. Structural so the package
 * stays decoupled from the concrete app (and could even target a remote Latch).
 */
export interface ChannelRunOps<P> {
  handleChat(input: {
    agent: string;
    chatId?: string;
    principal: P;
    message: AppMessage;
  }): Promise<Response>;
  applyApproval(input: {
    chatId: string;
    principal: P;
    decisions: { approvalId: string; approved: boolean }[];
  }): Promise<Response>;
  /**
   * Resume a turn paused on a client-handled tool (`askUser`). `output` is the
   * answer map — one call closes the whole tool call. Optional so existing hosts
   * keep type-checking; a channel without it can't render questionnaires.
   */
  applyToolResult?(input: {
    chatId: string;
    principal: P;
    toolCallId: string;
    output: unknown;
  }): Promise<Response>;
  /**
   * Summarize the conversation and continue from the summary (`/compact`). Null
   * when there's too little to compact. Optional so existing hosts keep
   * type-checking; without it the command reports that it isn't available.
   */
  compactChat?(input: {
    chatId: string;
    principal: P;
    focus?: string;
  }): Promise<{ summary: string; compacted: number } | null>;
  loadHistory(input: { chatId: string; principal: P }): Promise<AppMessage[]>;
}

/**
 * Host-provided speech-to-text for inbound voice/audio messages. Channels call
 * it with the downloaded audio and put the returned transcript in the user
 * message as text (the audio itself is never sent to the model — chat models
 * generally don't accept audio input). Throws on failure.
 */
export type TranscribeAudio = (audio: {
  bytes: Uint8Array;
  mediaType: string;
  filename: string;
}) => Promise<string>;

/** A tool-name → approval policy view, for rendering an agent's capabilities. */
export interface ToolCapability {
  name: string;
  description?: string;
  /** Whether calling this tool pauses for user approval. */
  requiresApproval: boolean;
}

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
  /** Token usage attributed to producing this message. */
  usage?: { inputTokens?: number; outputTokens?: number };
  /** Computed cost in the account's currency unit. */
  cost?: number;
  /** Finish reason from the producing step. */
  finishReason?: string;
  /** Server-side creation timestamp (unix ms). */
  createdAt?: number;
}

/** The stored conversation unit — a `UIMessage` typed with our metadata. */
export type AppMessage<TOOLS extends UITools = UITools> = UIMessage<
  AppMetadata,
  UIDataTypes,
  TOOLS
>;

/**
 * The platform's message/part contracts on top of `@intentface/chat`.
 *
 * The headless package owns *structural* contracts (`ChatMessage`, `FilePart`,
 * `ToolPart`) that an AI SDK `UIMessage` already satisfies. Two things it
 * deliberately doesn't model, and this app does:
 *
 *  - `dynamic-tool` parts — MCP and runtime-resolved connection tools (incl.
 *    `connect_<name>`), which the package's `tool-${string}` contract excludes;
 *  - approval-gated parts (`state: "approval-requested"` + `approval`), which
 *    are Latch's human-in-the-loop pause point.
 */

import type { AskUserQuestion as ComposerAskUserQuestion } from "@intentface/chat/composer"
import type { ChatMessage, ChatStatus, FilePart } from "@intentface/chat/types"
import type { AppMessage } from "@intentface/latch-core"
import type * as sdk from "ai"

/**
 * The message the UI renders: latch-core's `AppMessage`, a `UIMessage` typed
 * with the platform's metadata (visibility, usage/cost, voice, …).
 */
export type AppUIMessage = AppMessage

/** Metadata the chat surface reads off a message beyond `AppMetadata`'s own fields. */
export type ChatMessageMetadata = {
  /** The run that produced this assistant message — the key for evals/feedback. */
  runId?: string
  /** Set when the user aborted this turn mid-stream. */
  stopped?: boolean
  /** Present when the user's text came from a voice recording. */
  voice?: { durationMs: number }
}

/**
 * A tool-call part from a message: a static `tool-*` part OR a `dynamic-tool`
 * part. Everything downstream reads the name through {@link toolNameOf} so the
 * two shapes stay interchangeable.
 */
export type ToolPart =
  | Extract<sdk.UIMessage["parts"][number], { type: `tool-${string}` }>
  | Extract<sdk.UIMessage["parts"][number], { type: "dynamic-tool" }>

/** The tool's name: `tool-webSearch` → `webSearch`; a dynamic tool's `toolName`. */
export const toolNameOf = (part: ToolPart): string =>
  part.type === "dynamic-tool" ? part.toolName : part.type.replace(/^tool-/, "")

/** True for either part shape — the app's counterpart to the package's `isToolPart`. */
export const isAnyToolPart = (part: { type: string }): part is ToolPart =>
  (part.type.startsWith("tool-") || part.type === "dynamic-tool") &&
  "state" in part &&
  "toolCallId" in part

/**
 * The approval gate on a tool part. The SDK keeps these fields opaque on its
 * part types, so they're read through this loose view rather than cast at every
 * call site.
 */
export type ApprovalInfo = { id: string; approved?: boolean }

/** The part's approval gate, if it carries one. */
export const approvalOf = (part: {
  approval?: unknown
}): ApprovalInfo | undefined => {
  const approval = part.approval as ApprovalInfo | undefined
  return approval && typeof approval.id === "string" ? approval : undefined
}

/** True while a part is paused on an undecided approval. */
export const isAwaitingApproval = (part: {
  state?: string
  approval?: unknown
}): boolean =>
  part.state === "approval-requested" &&
  approvalOf(part)?.approved === undefined

// ---------------------------------------------------------------------------
// The askUser tool's contract (the zod schema in the agent's tools is the
// source of truth; this is its wire shape).
// ---------------------------------------------------------------------------

export type AskUserOption = {
  label: string
  description?: string
}

export type AskUserQuestion = {
  question: string
  header?: string
  options: AskUserOption[]
  multiSelect?: boolean
}

export type AskUserInput = {
  questions: AskUserQuestion[]
}

/** This app's concrete message roles (the Message primitive takes any string). */
export type MessageRole = "system" | "user" | "assistant"

/** This app's concrete step statuses (the Steps primitive takes any string). */
export type StepStatus = "complete" | "active" | "pending" | "error"

// ---------------------------------------------------------------------------
// Assignability locks
//
// `@intentface/chat` owns structural types that the AI SDK shapes must keep
// satisfying. These fail typecheck loudly if an `ai` upgrade (or a package
// change) breaks that structural compatibility.
// ---------------------------------------------------------------------------

type Assert<T extends true> = T

export type MessageContractCheck = Assert<
  AppUIMessage extends ChatMessage ? true : false
>

export type FilePartContractCheck = Assert<
  sdk.FileUIPart extends FilePart ? true : false
>

export type ChatStatusContractCheck = Assert<
  sdk.ChatStatus extends ChatStatus ? true : false
>

/** The app's richer question must keep satisfying the composer's `questions` prop. */
export type AskUserQuestionContractCheck = Assert<
  AskUserQuestion extends ComposerAskUserQuestion ? true : false
>

/**
 * Chat session context — the stable half of the chat's state.
 *
 * Message rows are memoized on their message object (see `message-item.tsx`), so
 * anything they need beyond that message has to reach them without being an
 * inline prop: a fresh closure per render would defeat the memo and re-segment
 * every finished row on every stream chunk. Handlers live here instead, and the
 * live message list is exposed as a ref so lookups that scan the whole
 * transcript (streamed tool progress) don't re-key the context per chunk.
 */

import { createContext,  use } from "react"
import type {RefObject} from "react";
import type { AppUIMessage } from "@/lib/ai/types"

export type ChatSessionValue = {
  chatId: string
  agent: string
  /** The live message list, for whole-transcript lookups during a row's render. */
  messagesRef: RefObject<AppUIMessage[]>
  /** A turn is streaming (or a continuation is being applied). */
  busy: boolean
  /** An approval/tool-result continuation is in flight. */
  deciding: boolean
  /** Approve or deny a gated tool call, then stream the continuation. */
  decide: (approvalId: string, approved: boolean) => void
  /** Start the OAuth flow for a connection, returning to this chat. */
  connect: (connection: string, approvalId: string) => void
  /** Re-run an assistant message. */
  regenerate: (messageId: string) => void
  /** Open the feedback dialog for a run, preselecting a verdict. */
  openFeedback: (messageId: string, runId: string, value: 0 | 1) => void
  /** Verdicts already submitted, per message id — highlights the chosen thumb. */
  feedbackGiven: Record<string, 0 | 1>
  /** Load a thread's history (used by the inline subagent transcript). */
  loadThread: (threadId: string) => Promise<AppUIMessage[]>
}

const ChatSessionContext = createContext<ChatSessionValue | null>(null)

export const ChatSessionProvider = ChatSessionContext.Provider

export const useChatSession = (): ChatSessionValue => {
  const ctx = use(ChatSessionContext)
  if (!ctx) throw new Error("useChatSession must be used within <Chat>")
  return ctx
}

/**
 * The session when there is one. Nested read-only transcripts (an eval case, a
 * delegated subagent) render message rows outside any live chat, and those rows
 * have no actions to wire — so absence is a valid state, not an error.
 */
export const useChatSessionOptional = (): ChatSessionValue | null =>
  use(ChatSessionContext)

/**
 * What the composer should show besides its input: nothing, an ask-user
 * questionnaire, or a credential form.
 *
 * Both arms are pauses the *agent* opened, so detection runs on `ready` as well
 * as `streaming` — the chat goes ready while a tool waits for the user. The
 * result is referentially stable while nothing transitions, which is what lets
 * the memoized composer bail on every stream chunk instead of re-rendering the
 * editor per token.
 */

import type { ChatStatus } from "ai"
import { useRef } from "react"
import {
  findPendingSecretRequest
  
} from "@/lib/ai/secret-request"
import type {SecretRequestInput} from "@/lib/ai/secret-request";
import {
  
  
  
  isAnyToolPart
  
} from "@/lib/ai/types"
import type {AppUIMessage, AskUserInput, AskUserQuestion, ToolPart} from "@/lib/ai/types";

export type ChatPanelState =
  | { type: "idle" }
  | { type: "ask-user"; toolCallId: string; questions: AskUserQuestion[] }
  | { type: "secret-request"; toolCallId: string; request: SecretRequestInput }

const IDLE: ChatPanelState = { type: "idle" }

export const useChatPanelState = (
  messages: readonly AppUIMessage[],
  status: ChatStatus
): ChatPanelState => {
  const previous = useRef<ChatPanelState>(IDLE)

  const lastAssistant =
    status === "ready" || status === "streaming"
      ? messages.findLast((m) => m.role === "assistant")
      : undefined
  const parts = lastAssistant?.parts ?? []

  const ask = parts.find(
    (p): p is ToolPart =>
      isAnyToolPart(p) &&
      p.type === "tool-askUser" &&
      p.state === "input-available"
  )
  const secret = ask ? undefined : findPendingSecretRequest(parts)

  const next: ChatPanelState = ask
    ? {
        type: "ask-user",
        toolCallId: ask.toolCallId,
        questions: (ask.input as AskUserInput | undefined)?.questions ?? [],
      }
    : secret
      ? {
          type: "secret-request",
          toolCallId: secret.toolCallId,
          request: secret.request,
        }
      : IDLE

  // The same arm on the same tool call hands back the previous object, so the
  // memoized composer sees no change.
  const prev = previous.current
  if (prev.type === next.type && next.type === "idle") return prev
  if (prev.type === next.type && next.type !== "idle" && "toolCallId" in prev) {
    if (prev.toolCallId === next.toolCallId) return prev
  }
  previous.current = next
  return next
}

/**
 * One message row.
 *
 * Memoized on the message object: finished messages keep their identity across
 * stream chunks, so every row except the streaming one bails here and the
 * segmentation below runs once per chunk instead of once per message. Everything
 * else it needs comes from `useChatSession` — passing handlers as inline props
 * would mint fresh values per render and defeat the memo.
 */

import { ChevronDown, KeyRound, Mic, ThumbsDown, ThumbsUp, Zap } from "lucide-react"
import { memo  } from "react"
import type {ReactNode} from "react";
import { Message } from "@/components/ai/message"
import { Reasoning } from "@/components/ai/reasoning"
import { ApprovalCard } from "@/components/chat/approval-card"
import { useChatSessionOptional } from "@/components/chat/context"
import { InterleavedSteps } from "@/components/chat/interleaved-steps"
import { RefreshIcon } from "@/components/icons/refresh"
import {
  getChainInfo,
  getReasoningInfo,
  getSourcesInfo,
} from "@/lib/ai/message-info"
import { getSecretRequestsAnswered } from "@/lib/ai/secret-request"
import {
  getFileParts,
  getSegmentedParts,
  getTextInfo,
  getToolParts,
} from "@/lib/ai/segments"
import { getAskUserInfo } from "@/lib/ai/steps-info"
import {
  
  
  isAwaitingApproval
  
} from "@/lib/ai/types"
import type {AppUIMessage, ChatMessageMetadata, ToolPart} from "@/lib/ai/types";
import { cn } from "@/lib/utils"

/** Format a duration in ms as m:ss (e.g. 42000 → "0:42"). */
const formatDuration = (ms: number): string => {
  const total = Math.round(ms / 1000)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, "0")}`
}

export type ChatMessageItemProps = {
  message: AppUIMessage
  isLast: boolean
  /** This message is the one currently streaming. */
  isStreaming: boolean
  isError?: boolean
  /** Messages present at mount skip the entrance animation. */
  skipAnimation?: boolean
  /** A nested transcript (a delegated subagent) — no actions, no approvals. */
  readOnly?: boolean
  /**
   * Detail for a tool row: the delegated subagent conversation, a live eval run.
   * Supplied by the chat root, which can see the whole transcript.
   */
  renderToolDetail?: (part: ToolPart) => ReactNode | undefined
}

export const ChatMessageItem = memo(
  ({
    message,
    isLast,
    isStreaming,
    isError = false,
    skipAnimation = false,
    readOnly = false,
    renderToolDetail,
  }: ChatMessageItemProps) => {
    const session = useChatSessionOptional()
    const feedbackGiven = session?.feedbackGiven ?? {}
    const busy = session?.busy ?? false
    const { parts } = message
    const isAssistant = message.role === "assistant"
    const isUser = message.role === "user"
    // latch-core's AppMetadata doesn't model the run id or the stopped marker;
    // both ride on the message from the server, so read them through the app's
    // own view of the metadata.
    const metadata = message.metadata as ChatMessageMetadata | undefined
    const runId = metadata?.runId

    const segments = getSegmentedParts(parts)
    const textInfo = getTextInfo(segments)
    const fileParts = getFileParts(segments)
    const chain = getChainInfo(segments)
    const reasoning = chain.onlyReasoning
      ? getReasoningInfo(segments, isStreaming)
      : null
    const askUser = getAskUserInfo(parts)
    // Agent extensions that ran before the model on this user turn (their
    // payload is already redacted server-side per the extension's `reveal`).
    const extensionParts = isUser ? getExtensionParts(parts) : []
    const sourcesInfo = isAssistant ? getSourcesInfo(parts) : null
    const secretsAnswered = isAssistant ? getSecretRequestsAnswered(parts) : []
    const gated = readOnly
      ? []
      : getToolParts(segments).filter((p) => isAwaitingApproval(p))

    // Every assistant turn keeps a status block, so it never appears-then-vanishes.
    // A finished reasoning-only turn uses the dedicated Reasoning disclosure; every
    // other assistant turn — streaming, tools, ask-user, or a plain text reply —
    // uses InterleavedSteps, which shows a "Thought for Xs" header even with an
    // empty timeline.
    const isReasoningOnlyDone =
      isAssistant &&
      !isStreaming &&
      !chain.hasTools &&
      !!reasoning &&
      reasoning.parts.length > 0

    return (
      <Message
        role={message.role}
        isError={isError}
        isLast={isLast}
        {...(skipAnimation && { initial: false })}
      >
        {/* File attachments the user sent */}
        {isUser && fileParts.length > 0 && (
          <Message.Attachments>
            {fileParts.map((part, i) => (
              <Message.Attachment key={i} attachment={part} />
            ))}
          </Message.Attachments>
        )}

        {/* Standalone reasoning (no tools) */}
        {isReasoningOnlyDone && reasoning && (
          <Reasoning isStreaming={reasoning.isStreaming}>
            <Reasoning.Trigger label={reasoning.headers} />
            <Reasoning.Content>{reasoning.texts}</Reasoning.Content>
          </Reasoning>
        )}

        {/* The turn timeline — reasoning + tool calls, chronologically */}
        {isAssistant && !isReasoningOnlyDone && (
          <InterleavedSteps
            segments={chain.segments}
            isStreaming={isStreaming}
            awaitingInput={askUser.isAwaitingInput || gated.length > 0}
            renderDetail={renderToolDetail}
          />
        )}

        <Message.Content>
          {parts.map((part, index) => {
            if (part.type !== "text") return null
            // Hide intermediate text between tool calls — only show text that
            // lands after the last tool/reasoning part.
            if (chain.hasTools) {
              const lastChainIdx = parts.findLastIndex(
                (p) =>
                  p.type === "reasoning" ||
                  ((p.type.startsWith("tool-") || p.type === "dynamic-tool") &&
                    p.type !== "tool-askUser")
              )
              if (index <= lastChainIdx) return null
            }
            return isUser ? (
              <Message.Text key={index}>{part.text}</Message.Text>
            ) : (
              <Message.Markdown key={index}>{part.text}</Message.Markdown>
            )
          })}
        </Message.Content>

        {extensionParts.length > 0 && <ExtensionChips parts={extensionParts} />}

        {/* A turn paused on the user's decision */}
        {gated.map((part) => (
          <ApprovalCard key={part.toolCallId} part={part} />
        ))}

        {/* Credentials the user filled in (names and non-secret values only) */}
        {secretsAnswered.map((secret) => (
          <div
            key={secret.toolCallId}
            className="flex flex-wrap items-center gap-1.5 text-xs text-ink-secondary"
          >
            <KeyRound className="size-3.5 shrink-0" />
            {secret.declined ? (
              <span>Skipped {secret.title.toLowerCase()}</span>
            ) : (
              <>
                <span>{secret.title} saved</span>
                {secret.saved.map((name) => (
                  <span
                    key={name}
                    className="rounded border border-primary-border px-1 font-mono text-2xs text-ink-tertiary"
                  >
                    {name}
                  </span>
                ))}
                {secret.values.map((value) => (
                  <span key={value.label} className="text-ink-tertiary">
                    · {value.label}: {value.value}
                  </span>
                ))}
              </>
            )}
          </div>
        ))}

        {/* Voice marker — the user's text is a transcription */}
        {isUser && metadata?.voice && (
          <span className="flex items-center gap-1 text-xs text-ink-tertiary">
            <Mic className="size-3 shrink-0" />
            Voice message · {formatDuration(metadata.voice.durationMs)}
          </span>
        )}

        {sourcesInfo?.hasSources && (
          <Message.Sources>
            {sourcesInfo.sources.map((source) => (
              <Message.Source
                key={source.domain}
                url={source.url}
                domain={source.domain}
              />
            ))}
          </Message.Sources>
        )}

        {/* Stopped marker — an assistant turn the user aborted mid-stream */}
        {isAssistant && metadata?.stopped && <Message.Stopped />}

        {/* Actions — hidden while the turn is paused on the user */}
        {session &&
          !readOnly &&
          !isStreaming &&
          !askUser.isAwaitingInput &&
          gated.length === 0 && (
            <Message.Actions
              className={cn(
                // Keep the bar visible once feedback is recorded, so the chosen
                // thumb's highlight is actually seen.
                feedbackGiven[message.id] !== undefined &&
                  "pointer-events-auto opacity-100"
              )}
            >
              {textInfo.text && <Message.Copy value={textInfo.text} />}
              {isAssistant && !busy && (
                <Message.Action
                  onClick={() => session.regenerate(message.id)}
                  tooltip="Regenerate"
                >
                  <RefreshIcon />
                </Message.Action>
              )}
              {isAssistant && !busy && runId && (
                <>
                  <Message.Action
                    aria-pressed={feedbackGiven[message.id] === 1}
                    onClick={() => session.openFeedback(message.id, runId, 1)}
                    tooltip="Good response"
                    className={cn(
                      feedbackGiven[message.id] === 1 && "text-accent-bg"
                    )}
                  >
                    <ThumbsUp />
                  </Message.Action>
                  <Message.Action
                    aria-pressed={feedbackGiven[message.id] === 0}
                    onClick={() => session.openFeedback(message.id, runId, 0)}
                    tooltip="Bad response"
                    className={cn(
                      feedbackGiven[message.id] === 0 && "text-accent-bg"
                    )}
                  >
                    <ThumbsDown />
                  </Message.Action>
                </>
              )}
            </Message.Actions>
          )}
      </Message>
    )
  }
)

ChatMessageItem.displayName = "ChatMessageItem"

// ---------------------------------------------------------------- extensions

type ExtensionPartView = {
  id?: string
  data: {
    name: string
    on: "slash" | "chat-start" | "every-turn"
    target: "message" | "instructions"
    reveal?: "command" | "prompt" | "both"
    rendered?: string
    error?: { message: string; code?: string }
    calls?: { tool: string }[]
    durationMs?: number
  }
}

function getExtensionParts(parts: readonly unknown[]): ExtensionPartView[] {
  return parts.filter(
    (p): p is ExtensionPartView =>
      typeof p === "object" &&
      p !== null &&
      (p as { type?: unknown }).type === "data-extension" &&
      typeof (p as { data?: unknown }).data === "object"
  )
}

/**
 * What ran before the model on this turn: one chip per extension, with the
 * rendered prompt behind a disclosure when the extension chose to reveal it.
 */
function ExtensionChips({ parts }: { parts: ExtensionPartView[] }) {
  return (
    <div className="flex flex-wrap gap-1.5 text-xs">
      {parts.map((p, i) => {
        const d = p.data
        const label = d.on === "slash" ? `/${d.name}` : d.name
        const detail = d.error
          ? `${label} failed: ${d.error.message}`
          : `${label} ran before the model${d.target === "instructions" ? " (system prompt)" : ""}`
        const body = (
          <span
            className={
              d.error
                ? "inline-flex items-center gap-1 rounded-md border border-destructive/40 px-1.5 py-0.5 text-destructive"
                : "inline-flex items-center gap-1 rounded-md border border-primary-border px-1.5 py-0.5 text-ink-secondary"
            }
            title={detail}
          >
            <Zap className="size-3" />
            <span className="font-mono">{label}</span>
            {d.calls && d.calls.length > 0 && (
              <span className="text-ink-secondary">· {d.calls.map((c) => c.tool).join(", ")}</span>
            )}
            {d.rendered && <ChevronDown className="size-3 transition-transform [details[open]>summary_&]:rotate-180" aria-hidden />}
          </span>
        )
        const errorLine = d.error && (
          <span className="text-destructive block">
            {d.error.message}
          </span>
        )
        if (!d.rendered) {
          return (
            <span key={p.id ?? i} className="min-w-0">
              {body}
              {errorLine}
            </span>
          )
        }
        return (
          <details key={p.id ?? i} className="min-w-0">
            <summary className="cursor-pointer list-none">{body}</summary>
            {errorLine}
            <pre className="mt-1 max-h-64 overflow-auto rounded bg-input/40 p-2 whitespace-pre-wrap text-ink-secondary">
              {d.rendered}
            </pre>
          </details>
        )
      })}
    </div>
  )
}

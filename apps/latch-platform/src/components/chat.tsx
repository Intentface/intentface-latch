/**
 * The chat surface.
 *
 * Layout and rendering come from `@intentface/chat` (via the styled layer in
 * `components/ai/*`); everything Latch-specific is orchestrated here: approval
 * gates, the credential form, delegated subagents, live evals, voice messages,
 * and picking a server-side turn back up after a reload.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useChat } from "@ai-sdk/react"
import {
  DefaultChatTransport,
  readUIMessageStream
  
} from "ai"
import type {UIMessageChunk} from "ai";
import { useRouter } from "@tanstack/react-router"
import { Telescope } from "lucide-react"
import type { AttachmentItem } from "@intentface/chat/attachments"
import type { ComposerAnswerEntry } from "@intentface/chat/composer"
import { groupTurns } from "@intentface/chat/message-utils"
import type { AppMessage, SubagentProgressData } from "@intentface/latch-core"
import { Message } from "@/components/ai/message"
import { Thread } from "@/components/ai/thread"
import { ChatInput  } from "@/components/chat/chat-input"
import type {ChatSelection} from "@/components/chat/chat-input";
import {
  ChatSessionProvider
  
} from "@/components/chat/context"
import type {ChatSessionValue} from "@/components/chat/context";
import { FeedbackDialog } from "@/components/chat/feedback-dialog"
import { ChatMessageItem } from "@/components/chat/message-item"
import { ChatPlaceholder } from "@/components/chat/placeholder"
import { SubagentThread } from "@/components/chat/subagent-thread"
import { useChatPanelState } from "@/components/chat/use-panel-state"
import { EvalRunCard } from "@/components/eval-run-card"
import { ScoreBadges, useEvalScores } from "@/components/eval-scores"
import { DisplaySettings } from "@/components/display-settings"
import { EvalsDrawer, useEvalsDrawerToggle } from "@/components/evals-drawer"
import { TextShimmer } from "@/components/ui/text-shimmer"
import type { AttachedEval } from "@/lib/agent-store"
import {
  applyDecisionToMessages,
  pendingApprovalIdsOnTail,
  pendingConnectApprovalId,
} from "@/lib/ai/approvals"
import { prepareAttachmentsForSend } from "@/lib/ai/attachments"
import type { EvalProgressData } from "@/lib/evals/store"
import type {AppUIMessage, ChatMessageMetadata, ToolPart} from "@/lib/ai/types";
import {
  authorizeUrl,
  chatApi,
  loadHistory,
  submitApproval,
  submitToolResult,
} from "@/lib/latch-client"
import {
  chatGeneratingFn,
  getAgentEvalsFn,
  rejudgeRunFn,
  saveSecretsFn,
  submitFeedbackFn,
} from "@/lib/server"
import { useSettingsStore } from "@/lib/store/settings"
import { cn } from "@/lib/utils"

/**
 * The streamed `data-eval-progress` part for a run_evals tool call, if any. The
 * tool writes one part (reconciled in place by id) while its cases run. Searched
 * across ALL messages: a continuation may land streamed parts in a different
 * message container than the one holding the original tool call.
 */
function evalProgressFor(
  messages: readonly { parts?: unknown[] }[],
  part: ToolPart
): EvalProgressData | undefined {
  const callId = part.toolCallId
  let found: EvalProgressData | undefined
  for (const msg of messages) {
    for (const p of (msg.parts ?? []) as {
      type: string
      data?: EvalProgressData
    }[]) {
      if (p.type !== "data-eval-progress" || !p.data) continue
      if (!p.data.toolCallId || p.data.toolCallId === callId) found = p.data
    }
  }
  return found
}

/**
 * The streamed `data-subagent-progress` part for a spawn_agent tool call, if any
 * — same reconciled-by-id pattern (and cross-message search) as
 * `evalProgressFor`.
 */
function subagentProgressFor(
  messages: readonly { parts?: unknown[] }[],
  part: ToolPart
): SubagentProgressData | undefined {
  const callId = part.toolCallId
  let found: SubagentProgressData | undefined
  for (const msg of messages) {
    for (const p of (msg.parts ?? []) as {
      type: string
      data?: SubagentProgressData
    }[]) {
      if (p.type !== "data-subagent-progress" || !p.data) continue
      if (!p.data.toolCallId || p.data.toolCallId === callId) found = p.data
    }
  }
  return found
}

export function Chat({
  chatId,
  agent,
  initialMessages,
  embedded = false,
  starters,
  autoSend,
  onTurnFinished,
}: {
  chatId: string
  agent: string
  initialMessages?: AppMessage[]
  /**
   * Hosted inside another page (the Evals panel) rather than the Chats route:
   * no chat-page controls in the corner, no per-chat evals drawer.
   */
  embedded?: boolean
  /** Prompts offered while the chat is empty; a click sends one as the first message. */
  starters?: { label: string; prompt: string }[]
  /** Sent once as the first message when the conversation is empty — "ask the agent to do X" from elsewhere in the app. */
  autoSend?: string
  /** After each turn settles — the host may need to reload what the turn changed. */
  onTurnFinished?: () => void
}) {
  const onTurnFinishedRef = useRef(onTurnFinished)
  onTurnFinishedRef.current = onTurnFinished
  const router = useRouter()
  const [deciding, setDeciding] = useState(false)
  // A failed secret write (e.g. not an org admin): shown in the composer form,
  // which stays open over the still-paused turn.
  const [secretError, setSecretError] = useState<string | null>(null)
  // A send the server rejected — shown above the composer so a dropped message
  // is never silent.
  const [sendError, setSendError] = useState<string | null>(null)
  // Poll guard: while an approval/tool-result continuation is streaming into
  // setMessages, the background history poll must not overwrite it (server
  // history lags the stream — it lacks streamed-only parts like eval progress).
  const decidingRef = useRef(false)
  decidingRef.current = deciding

  const {
    messages,
    sendMessage,
    setMessages,
    status,
    addToolResult,
    regenerate,
    stop,
  } = useChat({
    id: chatId,
    messages: initialMessages,
    transport: new DefaultChatTransport<AppMessage>({
      api: chatApi(chatId, agent),
      // Send new submissions as an explicit `{ message }` so the server keeps
      // our metadata (e.g. the voice-message marker) — the default `{ messages }`
      // body shape gets its metadata rebuilt server-side (and its parts reduced
      // to text, which silently dropped attachments). Keep text AND file parts:
      // the explicit path forwards them as-is, so attachments actually reach
      // the agent.
      prepareSendMessagesRequest: ({
        id,
        messages: all,
        trigger,
        messageId,
        body,
      }) => {
        const last = all.at(-1)
        if (trigger === "submit-message" && last?.role === "user") {
          const message: AppMessage = {
            ...last,
            parts: last.parts.filter(
              (p) => p.type === "text" || p.type === "file"
            ),
            metadata: {
              visibility: "user",
              createdAt: Date.now(),
              ...last.metadata,
            },
          }
          return { body: { ...body, message } }
        }
        return { body: { ...body, id, messages: all, trigger, messageId } }
      },
    }),
    onFinish: () => {
      void router.invalidate()
      onTurnFinishedRef.current?.()
    },
    // Without this a rejected send is swallowed whole: `sendMessage` only ever
    // added the user bubble to client state, so a failed turn looked like it was
    // accepted until a reload made the message vanish. Surface it instead.
    onError: (e) =>
      setSendError(e.message || "Something went wrong sending that message."),
  })

  const busy = status === "submitted" || status === "streaming"
  const scrollMode = useSettingsStore((s) => s.scrollMode)
  const stickyMessages = useSettingsStore((s) => s.stickyMessages)
  const showOverlays = useSettingsStore((s) => s.showOverlays)
  const showScrollButton = useSettingsStore((s) => s.showScrollButton)
  const panel = useChatPanelState(messages, status)

  // Latest messages, for the seed of an approval-continuation stream and for the
  // whole-transcript lookups a row does while rendering (a click handler or a
  // memoized row would otherwise close over a stale snapshot).
  const messagesRef = useRef(messages)
  messagesRef.current = messages

  // Quoted passages the user picked out of the transcript — folded into the next
  // message as blockquote context.
  const [selections, setSelections] = useState<ChatSelection[]>([])
  const clearSelections = useCallback(() => setSelections([]), [])

  // Response feedback → Langfuse `user-feedback` score on the run's trace. The
  // thumb click opens the dialog preselected; submitted verdicts are kept per
  // message id so the chosen thumb stays highlighted.
  const [feedbackFor, setFeedbackFor] = useState<{
    messageId: string
    runId: string
    initial: 0 | 1
  } | null>(null)
  const [feedbackGiven, setFeedbackGiven] = useState<Record<string, 0 | 1>>({})

  // Live evals (owner-only): the drawer + per-message score badges. The judge
  // dual-writes verdicts to a fast local store; we poll it for visible runs.
  const [editable, setEditable] = useState(false)
  const [hasRubrics, setHasRubrics] = useState(false)
  const [drawerOn, setDrawerOn] = useEvalsDrawerToggle(agent)
  const [draft, setDraft] = useState<AttachedEval[]>([])
  const [reevaluating, setReevaluating] = useState(false)
  useEffect(() => {
    let cancelled = false
    getAgentEvalsFn({ data: agent })
      .then((res) => {
        if (cancelled) return
        setEditable(res.editable)
        setHasRubrics(res.evals.some((e) => e.enabled))
      })
      .catch((e) => {
        // Non-fatal: leave eval UI at its defaults (off) if the lookup fails.
        if (!cancelled) console.warn("getAgentEvals failed:", e)
      })
    return () => {
      cancelled = true
    }
  }, [agent])

  // Distinct assistant run ids currently on screen (feedback + scores key on these).
  const runIds = Array.from(
    new Set(
      messages
        .filter((m) => m.role === "assistant")
        .map((m) => (m.metadata as ChatMessageMetadata | undefined)?.runId)
        .filter((id): id is string => !!id)
    )
  )
  // The freshest assistant run — the only one still awaiting a live judge.
  // Bounding "judging…" to it avoids a permanent spinner on older runs that
  // predate the rubrics (or whose judge failed) and will never get scores.
  const latestRunId = runIds.at(-1)
  const showEvals = editable && drawerOn
  const { scores, merge } = useEvalScores(
    runIds,
    editable && (drawerOn || hasRubrics)
  )

  // Re-judge every visible message against the current (draft) rubric set.
  const reevaluate = async () => {
    if (reevaluating || draft.length === 0) return
    setReevaluating(true)
    try {
      // allSettled: one bad run (thrown/network error, or `{ ok: false }`) must
      // not reject the whole batch or surface as an unhandled rejection — this
      // is called from a `() => void` handler that never awaits it.
      const results = await Promise.allSettled(
        runIds.map(async (runId) => {
          const res = await rejudgeRunFn({
            data: { chatId, runId, evals: draft },
          })
          if (!res.ok) throw new Error(res.error)
          merge(runId, res.scores)
        })
      )
      const failed = results.filter((r) => r.status === "rejected").length
      if (failed > 0)
        console.warn(`re-evaluate: ${failed}/${runIds.length} run(s) failed`)
    } finally {
      setReevaluating(false)
    }
  }

  // On reload, a turn may still be running server-side (we drain it to completion
  // regardless of the client). Poll for that: show a "Generating…" indicator and
  // refresh history so the answer fills in as it lands — until the run is no
  // longer active.
  const [resuming, setResuming] = useState(false)
  useEffect(() => {
    if (status !== "ready") return // a live local stream is already showing
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      // A continuation stream is live — its snapshots are fresher than server
      // history. Keep checking, but don't clobber the streamed state.
      if (decidingRef.current) {
        timer = setTimeout(poll, 2000)
        return
      }
      const gen = await chatGeneratingFn({ data: chatId }).catch(() => false)
      if (cancelled) return
      if (decidingRef.current) {
        timer = setTimeout(poll, 2000)
        return
      }
      setResuming(gen)
      const updated = await loadHistory(chatId).catch(() => null)
      if (cancelled) return
      if (updated && !decidingRef.current) setMessages(updated)
      if (gen) timer = setTimeout(poll, 2000)
    }
    void poll()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId])

  // -------------------------------------------------------------------------
  // Continuations — resuming a turn the server paused
  // -------------------------------------------------------------------------

  /** Merge a paused-turn continuation into the list as it streams, then reconcile. */
  const consumeResume = useCallback(
    async (stream: ReadableStream<UIMessageChunk> | null) => {
      if (stream) {
        // The continuation reuses the last assistant message's id and streams
        // only the new parts; seed the reader with a clone of that message and
        // let the deltas fill it in live (the reader mutates the seed in place).
        const last = [...messagesRef.current]
          .reverse()
          .find((m) => m.role === "assistant")
        const seed = last ? structuredClone(last) : undefined
        for await (const snapshot of readUIMessageStream<AppMessage>({
          message: seed,
          stream,
        })) {
          setMessages((prev) => {
            const next = [...prev]
            const i = next.findIndex((m) => m.id === snapshot.id)
            if (i >= 0) next[i] = snapshot
            else next.push(snapshot)
            return next
          })
        }
      }
      // Reconcile against authoritative server history (also covers the
      // still-paused case).
      const updated = await loadHistory(chatId)
      setMessages(updated)
      router.invalidate()
    },
    [chatId, router, setMessages]
  )

  /**
   * Mirror the server's applyDecisions on the local copy BEFORE streaming the
   * continuation: the stream re-emits the tool part only once it has output, so
   * without this the part stays `approval-requested` client-side for the whole
   * execution and the approval card sits on screen instead of the tool's live
   * view (for run_evals, minutes of frozen dialog).
   */
  const applyLocalDecision = useCallback(
    (approvalId: string, approved: boolean) => {
      const next = applyDecisionToMessages(
        messagesRef.current,
        approvalId,
        approved
      )
      // Update the ref too: consumeResume seeds the continuation reader from it,
      // and React may not have re-rendered by then.
      messagesRef.current = next
      setMessages(next)
    },
    [setMessages]
  )

  const decide = useCallback(
    async (approvalId: string, approved: boolean) => {
      setDeciding(true)
      applyLocalDecision(approvalId, approved)
      try {
        await consumeResume(
          await submitApproval(chatId, agent, [{ approvalId, approved }])
        )
      } finally {
        setDeciding(false)
      }
    },
    [agent, applyLocalDecision, chatId, consumeResume]
  )

  /**
   * Answer a paused `askUser` tool: persist the result server-side and stream the
   * continuation. `addToolResult` updates the local message optimistically so the
   * questionnaire closes and shows the answered summary right away.
   */
  const answerAskUser = useCallback(
    async (toolCallId: string, output: Record<string, string>) => {
      setDeciding(true)
      try {
        void addToolResult({ tool: "askUser", toolCallId, output })
        await consumeResume(
          await submitToolResult(chatId, agent, toolCallId, output)
        )
      } finally {
        setDeciding(false)
      }
    },
    [addToolResult, agent, chatId, consumeResume]
  )

  /**
   * Answer a paused `request_secret` tool.
   *
   * The ONLY place a credential leaves the browser: secret values go to
   * `saveSecretsFn`, which writes them to the Vault. What resumes the run is a
   * result carrying the vault NAMES and the non-secret values — so the agent can
   * finish configuring the connection without the plaintext ever entering the
   * message history or the model's context.
   */
  const answerSecretRequest = useCallback(
    async (values: Record<string, string>, declined: boolean) => {
      if (panel.type !== "secret-request") return
      const { toolCallId, request } = panel
      setDeciding(true)
      try {
        let output: Record<string, unknown>
        if (declined) {
          output = { saved: [], values: {}, declined: true }
        } else {
          const secrets = request.fields
            .filter((f) => f.secret)
            .map((f) => ({ name: f.name ?? f.key, value: values[f.key] ?? "" }))
          if (secrets.length > 0) {
            const res = await saveSecretsFn({
              data: { scope: request.scope, secrets },
            })
            if (!res.ok) {
              // Keep the form open with the reason; the turn stays paused so the
              // user can correct it (e.g. they aren't an org admin).
              setSecretError(res.error)
              return
            }
          }
          // Non-secret fields are the only values that travel onward.
          const forwarded = Object.fromEntries(
            request.fields
              .filter((f) => !f.secret)
              .map((f) => [f.key, values[f.key] ?? ""])
          )
          output = {
            saved: secrets.map((s) => s.name),
            values: forwarded,
            declined: false,
          }
        }
        setSecretError(null)
        // `addToolResult` flips the part to output-available, which drops the
        // panel state and clears the form — no separate teardown needed.
        void addToolResult({ tool: "request_secret", toolCallId, output })
        await consumeResume(
          await submitToolResult(chatId, agent, toolCallId, output)
        )
      } finally {
        setDeciding(false)
      }
    },
    [addToolResult, agent, chatId, consumeResume, panel]
  )

  // Returning from an OAuth connect (`?connected=<name>`): the run is paused on a
  // `connect_<name>` approval. Approve it now so the continuation streams in.
  const resumedRef = useRef(false)
  useEffect(() => {
    if (resumedRef.current) return
    const params = new URLSearchParams(window.location.search)
    const connected = params.get("connected")
    if (!connected) return
    resumedRef.current = true
    const url = new URL(window.location.href)
    url.searchParams.delete("connected")
    window.history.replaceState({}, "", url)
    const approvalId = pendingConnectApprovalId(
      initialMessages ?? [],
      connected
    )
    if (approvalId) void decide(approvalId, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  /**
   * A message typed over a pending approval IS the decision — the server declines
   * the gate and runs the message. Mirror it locally so the card closes now
   * rather than sitting there looking actionable.
   */
  const supersedePendingApprovals = useCallback(() => {
    for (const id of pendingApprovalIdsOnTail(messagesRef.current)) {
      applyLocalDecision(id, false)
    }
  }, [applyLocalDecision])

  const submitMessage = useCallback(
    async (text: string, files: AttachmentItem[]) => {
      setSendError(null)
      supersedePendingApprovals()
      // The composer submits generic attachment items; adapt them to AI SDK file
      // parts (inlining blob URLs) at this app boundary.
      const fileParts = await prepareAttachmentsForSend(files)
      // Fold quoted passages in as blockquote context above the message.
      const quoted = selections
        .map((selection) =>
          selection.text
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n")
        )
        .join("\n\n")
      const body = text || (fileParts.length > 0 ? "Sent with attachments" : "")
      const composed = quoted ? `${quoted}\n\n${body}` : body
      clearSelections()
      void sendMessage({
        parts: [...fileParts, { type: "text", text: composed }],
      })
    },
    [clearSelections, selections, sendMessage, supersedePendingApprovals]
  )

  // Sent once, and only into an empty conversation: a reload must not repeat it.
  const autoSent = useRef(false)
  useEffect(() => {
    if (!autoSend || autoSent.current || messages.length > 0) return
    autoSent.current = true
    void submitMessage(autoSend, [])
  }, [autoSend, messages.length, submitMessage])

  const answerQuestions = useCallback(
    (answers: ComposerAnswerEntry[]) => {
      if (panel.type !== "ask-user") return
      // Flatten the composer's answer entries into question → picked text.
      const out: Record<string, string> = {}
      for (const entry of answers) {
        out[entry.question] =
          "option" in entry
            ? entry.option
            : "options" in entry
              ? [...(entry.options ?? []), entry.text]
                  .filter(Boolean)
                  .join(", ")
              : "text" in entry
                ? entry.text
                : ""
      }
      void answerAskUser(panel.toolCallId, out)
    },
    [answerAskUser, panel]
  )

  /**
   * A finished voice recording: the transcript becomes the user message, with a
   * marker so it renders (and persists) as a voice message. Recording is allowed
   * while the agent is still streaming, but sending mid-stream would corrupt the
   * turn — queue the transcript and send once the chat is ready. Status is read
   * through refs: `onTranscribed` fires from a closure created when recording
   * STARTED, whose captured `busy` may be long stale.
   */
  const queuedVoiceRef = useRef<{ text: string; durationMs: number }[]>([])
  const chatBusyRef = useRef(false)
  chatBusyRef.current = busy || deciding
  const sendVoiceMessage = useCallback(
    (text: string, durationMs: number) => {
      supersedePendingApprovals()
      void sendMessage({
        text,
        metadata: { visibility: "user", voice: { durationMs } },
      })
    },
    [sendMessage, supersedePendingApprovals]
  )
  const handleVoiceTranscribed = useCallback(
    (text: string, durationMs: number) => {
      if (chatBusyRef.current) {
        // FIFO, not a single slot: a second recording finishing while the chat is
        // still busy must not overwrite an unsent first transcript.
        queuedVoiceRef.current.push({ text, durationMs })
        return
      }
      sendVoiceMessage(text, durationMs)
    },
    [sendVoiceMessage]
  )
  useEffect(() => {
    if (busy || deciding || queuedVoiceRef.current.length === 0) return
    const queued = queuedVoiceRef.current.shift()
    if (queued) sendVoiceMessage(queued.text, queued.durationMs)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, deciding])

  // -------------------------------------------------------------------------
  // Session context — stable handlers the memoized rows read
  // -------------------------------------------------------------------------

  const connect = useCallback(
    (connection: string, approvalId: string) => {
      window.location.href = authorizeUrl(connection, {
        chatId,
        approvalId,
        returnTo: `/chat/${chatId}`,
      })
    },
    [chatId]
  )

  const session = useMemo<ChatSessionValue>(
    () => ({
      chatId,
      agent,
      messagesRef,
      busy,
      deciding,
      decide: (approvalId, approved) => void decide(approvalId, approved),
      connect,
      regenerate: (messageId) => void regenerate({ messageId }),
      openFeedback: (messageId, runId, initial) =>
        setFeedbackFor({ messageId, runId, initial }),
      feedbackGiven,
      loadThread: (threadId) => loadHistory(threadId),
    }),
    [agent, busy, chatId, connect, decide, deciding, feedbackGiven, regenerate]
  )

  /**
   * Detail for a tool row. Stable across stream chunks — the streamed progress
   * parts are looked up through `messagesRef`, so the memoized rows keep bailing
   * while a reply streams.
   */
  const renderToolDetail = useCallback((part: ToolPart) => {
    if (part.type === "tool-spawn_agent") {
      return (
        <SubagentThread
          part={part}
          progress={subagentProgressFor(messagesRef.current, part)}
        />
      )
    }
    if (part.type === "tool-run_evals") {
      return (
        <EvalRunCard
          part={part}
          progress={evalProgressFor(messagesRef.current, part)}
        />
      )
    }
    return undefined
  }, [])

  const turns = groupTurns(messages as AppUIMessage[])
  const lastMessageId = messages.at(-1)?.id
  // Messages present at mount skip the entrance animation.
  const initialMessageIds = useRef(new Set(messages.map((m) => m.id)))

  return (
    <ChatSessionProvider value={session}>
      <div className="flex h-full min-w-0">
        <div className="relative flex h-full min-w-0 flex-1 flex-col">
          {/* Chat-area controls, floating over the thread's top-right corner. */}
          {!embedded && (
          <div className="absolute top-2 right-2 z-20 flex items-center gap-2">
            {editable && (
              <button
                type="button"
                onClick={() => setDrawerOn(!drawerOn)}
                aria-pressed={showEvals}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border border-primary-border bg-primary-bg px-2.5 py-1 text-xs text-ink-secondary hover:bg-primary-bg-hover hover:text-ink-primary",
                  showEvals && "text-ink-primary"
                )}
              >
                <Telescope className="size-3.5" /> Evals
              </button>
            )}
            <DisplaySettings />
          </div>
          )}

          <Thread autoScroll={scrollMode}>
            {showOverlays && <Thread.Overlay direction="top" />}
            <Thread.Viewport>
              {messages.length === 0 ? (
                <Thread.Placeholder>
                  {starters?.length ? (
                    <div className="flex w-full flex-col gap-2">
                      {starters.map((s) => (
                        <button
                          key={s.label}
                          type="button"
                          onClick={() => void submitMessage(s.prompt, [])}
                          className="rounded-xl border border-primary-border bg-primary-bg px-3 py-2 text-left text-sm text-ink-primary hover:bg-primary-bg-hover"
                        >
                          {s.label}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <ChatPlaceholder agent={agent} />
                  )}
                </Thread.Placeholder>
              ) : (
                <>
                  {turns.map((turn) => (
                    <Message.Turn key={turn.key} sticky={stickyMessages}>
                      {turn.messages.map((message) => {
                        const runId = (
                          message.metadata as ChatMessageMetadata | undefined
                        )?.runId
                        const isAssistant = message.role === "assistant"
                        const settled =
                          isAssistant && !(busy && message.id === lastMessageId)
                        // Badges/pending for owners watching evals, once the
                        // message is complete and carries a run id.
                        const showScores =
                          editable &&
                          (drawerOn || hasRubrics) &&
                          settled &&
                          !!runId
                        return (
                          <div key={message.id} className="flex flex-col gap-2">
                            <ChatMessageItem
                              message={message}
                              isLast={message.id === lastMessageId}
                              isStreaming={
                                busy &&
                                message.id === lastMessageId &&
                                isAssistant
                              }
                              isError={
                                status === "error" &&
                                message.id === lastMessageId
                              }
                              skipAnimation={initialMessageIds.current.has(
                                message.id
                              )}
                              renderToolDetail={renderToolDetail}
                            />
                            {showScores && runId && (
                              <ScoreBadges
                                runId={runId}
                                scores={scores[runId]}
                                pending={hasRubrics && runId === latestRunId}
                                canCorrect={editable}
                                onCorrected={(rid, updated) =>
                                  merge(
                                    rid,
                                    (scores[rid] ?? []).map((s) =>
                                      s.name === updated.name ? updated : s
                                    )
                                  )
                                }
                              />
                            )}
                          </div>
                        )
                      })}
                    </Message.Turn>
                  ))}
                  {/* A turn still draining server-side after a reload: there's no
                      local stream to narrate it, so say so explicitly. */}
                  {resuming && !busy && (
                    <div
                      className="py-1 text-sm text-ink-secondary"
                      role="status"
                    >
                      <TextShimmer>Generating…</TextShimmer>
                    </div>
                  )}
                </>
              )}
            </Thread.Viewport>

            <Thread.Composer>
              {showScrollButton && <Thread.ScrollButton />}
              <ChatInput
                panel={panel}
                isGenerating={busy || deciding}
                selections={selections}
                onClearSelections={clearSelections}
                sendError={sendError}
                onDismissSendError={() => setSendError(null)}
                secretError={secretError}
                onSubmitMessage={submitMessage}
                onAnswerQuestions={answerQuestions}
                onSaveSecret={answerSecretRequest}
                onVoiceTranscribed={handleVoiceTranscribed}
                onStop={stop}
              />
            </Thread.Composer>

            {showOverlays && <Thread.Overlay direction="bottom" />}
          </Thread>

          <FeedbackDialog
            key={
              feedbackFor
                ? `${feedbackFor.messageId}-${feedbackFor.initial}`
                : "closed"
            }
            open={feedbackFor !== null}
            onOpenChange={(open) => {
              if (!open) setFeedbackFor(null)
            }}
            initialValue={feedbackFor?.initial}
            onSubmit={async ({ value, comment }) => {
              if (!feedbackFor) return
              const res = await submitFeedbackFn({
                data: { runId: feedbackFor.runId, value, comment },
              })
              if (!res.ok) throw new Error(res.error)
              setFeedbackGiven((prev) => ({
                ...prev,
                [feedbackFor.messageId]: value,
              }))
            }}
          />
        </div>

        {showEvals && !embedded && (
          <EvalsDrawer
            agent={agent}
            draft={draft}
            setDraft={setDraft}
            onClose={() => setDrawerOn(false)}
            onReevaluate={reevaluate}
            reevaluating={reevaluating}
          />
        )}
      </div>
    </ChatSessionProvider>
  )
}

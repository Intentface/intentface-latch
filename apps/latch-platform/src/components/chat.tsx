import { useEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, readUIMessageStream } from "ai";
import { useRouter } from "@tanstack/react-router";
import { Bot, Brain, ChevronDown, CircleDot, Loader2, Telescope } from "lucide-react";
import {
  cn,
  Composer,
  FeedbackDialog,
  Message,
  StepQueue,
  Thread,
  useComposerState,
  useSettingsStore



} from "@intentface/latch-ui";
import type {AppUIMessage, ComposerSubmitData, ToolPart} from "@intentface/latch-ui";
import type { AppMessage, SubagentProgressData } from "@intentface/latch-core";
import {
  authorizeUrl,
  chatApi,
  loadHistory,
  submitApproval,
  submitToolResult,
} from "@/lib/latch-client";
import { chatGeneratingFn, getAgentEvalsFn, rejudgeRunFn, submitFeedbackFn } from "@/lib/server";
import type { AttachedEval } from "@/lib/agent-store";
import { EvalsDrawer, useEvalsDrawerToggle } from "@/components/evals-drawer";
import { ScoreBadges, useEvalScores } from "@/components/eval-scores";
import type { UIMessageChunk } from "ai";
import { Button } from "@/components/ui/button";
import { VoiceRecorder } from "@/components/voice-recorder";
import { EvalRunCard } from "@/components/eval-run-card";
import type { EvalProgressData } from "@/lib/evals/store";

/** Loose view of a tool part's approval fields (SDK types keep these opaque). */
type ApprovalPart = {
  type: string;
  toolName?: string;
  state?: string;
  input?: unknown;
  approval?: { id: string; approved?: boolean };
};

/**
 * The streamed `data-eval-progress` part for a run_evals tool call, if any.
 * The tool writes one part (reconciled in place by id) while its cases run.
 * Searched across ALL messages: a continuation may land streamed parts in a
 * different message container than the one holding the original tool call.
 */
function evalProgressFor(
  messages: readonly { parts?: unknown[] }[],
  part: ToolPart,
): EvalProgressData | undefined {
  const callId = (part as { toolCallId?: string }).toolCallId;
  let found: EvalProgressData | undefined;
  for (const msg of messages) {
    for (const p of (msg.parts ?? []) as { type: string; data?: EvalProgressData }[]) {
      if (p.type !== "data-eval-progress" || !p.data) continue;
      if (!p.data.toolCallId || p.data.toolCallId === callId) found = p.data;
    }
  }
  return found;
}

/**
 * The streamed `data-subagent-progress` part for a spawn_agent tool call, if
 * any — same reconciled-by-id pattern (and cross-message search) as
 * `evalProgressFor`.
 */
function subagentProgressFor(
  messages: readonly { parts?: unknown[] }[],
  part: ToolPart,
): SubagentProgressData | undefined {
  const callId = (part as { toolCallId?: string }).toolCallId;
  let found: SubagentProgressData | undefined;
  for (const msg of messages) {
    for (const p of (msg.parts ?? []) as { type: string; data?: SubagentProgressData }[]) {
      if (p.type !== "data-subagent-progress" || !p.data) continue;
      if (!p.data.toolCallId || p.data.toolCallId === callId) found = p.data;
    }
  }
  return found;
}

/** The approval id of a pending `connect_<name>` gate, if one is awaiting a decision. */
function pendingConnectApprovalId(
  msgs: AppMessage[] | undefined,
  name: string,
): string | undefined {
  for (const m of msgs ?? []) {
    for (const part of m.parts ?? []) {
      const p = part as ApprovalPart;
      const isConnect =
        p.type === `tool-connect_${name}` ||
        (p.type === "dynamic-tool" && p.toolName === `connect_${name}`);
      if (isConnect && p.state === "approval-requested" && p.approval && p.approval.approved === undefined) {
        return p.approval.id;
      }
    }
  }
  return undefined;
}

export function Chat({
  chatId,
  agent,
  initialMessages,
}: {
  chatId: string;
  agent: string;
  initialMessages?: AppMessage[];
}) {
  const router = useRouter();
  const [deciding, setDeciding] = useState(false);
  // Poll guard: while an approval/tool-result continuation is streaming into
  // setMessages, the background history poll must not overwrite it (server
  // history lags the stream — it lacks streamed-only parts like eval progress).
  const decidingRef = useRef(false);
  decidingRef.current = deciding;
  const { messages, sendMessage, setMessages, status, addToolResult, regenerate, stop } = useChat({
    id: chatId,
    messages: initialMessages,
    transport: new DefaultChatTransport<AppMessage>({
      api: chatApi(chatId, agent),
      // Send new submissions as an explicit `{ message }` so the server keeps
      // our metadata (e.g. the voice-message marker) — the default `{ messages }`
      // body shape gets its metadata rebuilt server-side. Parts are filtered to
      // text for parity with what the server extracts from the default shape.
      prepareSendMessagesRequest: ({ id, messages: all, trigger, messageId, body }) => {
        const last = all.at(-1);
        if (trigger === "submit-message" && last?.role === "user") {
          const message: AppMessage = {
            ...last,
            parts: last.parts.filter((p) => p.type === "text"),
            metadata: { visibility: "user", createdAt: Date.now(), ...last.metadata },
          };
          return { body: { ...body, message } };
        }
        return { body: { ...body, id, messages: all, trigger, messageId } };
      },
    }),
    onFinish: () => router.invalidate(),
  });
  const busy = status === "submitted" || status === "streaming";
  const scrollMode = useSettingsStore((s) => s.scrollMode);
  const composerState = useComposerState(messages, status);
  const isAskUser = composerState.type === "ask-user";

  // Response feedback → Langfuse `user-feedback` score on the run's trace.
  // The thumb click opens the dialog preselected; submitted verdicts are kept
  // per message id so the chosen thumb stays highlighted.
  const [feedbackFor, setFeedbackFor] = useState<{
    messageId: string;
    runId: string;
    initial: 0 | 1;
  } | null>(null);
  const [feedbackGiven, setFeedbackGiven] = useState<Record<string, 0 | 1>>({});

  // Live evals (owner-only): the drawer + per-message score badges. The judge
  // dual-writes verdicts to a fast local store; we poll it for visible runs.
  const [editable, setEditable] = useState(false);
  const [hasRubrics, setHasRubrics] = useState(false);
  const [drawerOn, setDrawerOn] = useEvalsDrawerToggle(agent);
  const [draft, setDraft] = useState<AttachedEval[]>([]);
  const [reevaluating, setReevaluating] = useState(false);
  useEffect(() => {
    let cancelled = false;
    getAgentEvalsFn({ data: agent })
      .then((res) => {
        if (cancelled) return;
        setEditable(res.editable);
        setHasRubrics(res.evals.some((e) => e.enabled));
      })
      .catch((e) => {
        // Non-fatal: leave eval UI at its defaults (off) if the lookup fails.
        if (!cancelled) console.warn("getAgentEvals failed:", e);
      });
    return () => {
      cancelled = true;
    };
  }, [agent]);
  // Distinct assistant run ids currently on screen (feedback + scores key on these).
  const runIds = Array.from(
    new Set(
      messages
        .filter((m) => m.role === "assistant")
        .map((m) => (m.metadata as { runId?: string } | undefined)?.runId)
        .filter((id): id is string => !!id),
    ),
  );
  // The freshest assistant run — the only one still awaiting a live judge.
  // Bounding "judging…" to it avoids a permanent spinner on older runs that
  // predate the rubrics (or whose judge failed) and will never get scores.
  const latestRunId = runIds.at(-1);
  const showEvals = editable && drawerOn;
  const { scores, merge } = useEvalScores(runIds, editable && (drawerOn || hasRubrics));

  // Re-judge every visible message against the current (draft) rubric set.
  const reevaluate = async () => {
    if (reevaluating || draft.length === 0) return;
    setReevaluating(true);
    try {
      // allSettled: one bad run (thrown/network error, or `{ ok: false }`) must
      // not reject the whole batch or surface as an unhandled rejection — this
      // is called from a `() => void` handler that never awaits it.
      const results = await Promise.allSettled(
        runIds.map(async (runId) => {
          const res = await rejudgeRunFn({ data: { chatId, runId, evals: draft } });
          if (!res.ok) throw new Error(res.error);
          merge(runId, res.scores);
        }),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed > 0) console.warn(`re-evaluate: ${failed}/${runIds.length} run(s) failed`);
    } finally {
      setReevaluating(false);
    }
  };

  // On reload, a turn may still be running server-side (we now drain it to
  // completion regardless of the client). Poll for that: show a "Generating…"
  // indicator and refresh history so the answer fills in as it lands — until
  // the run is no longer active.
  const [resuming, setResuming] = useState(false);
  useEffect(() => {
    if (status !== "ready") return; // a live local stream is already showing
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      // A continuation stream is live — its snapshots are fresher than server
      // history. Keep checking, but don't clobber the streamed state.
      if (decidingRef.current) {
        timer = setTimeout(poll, 2000);
        return;
      }
      const gen = await chatGeneratingFn({ data: chatId }).catch(() => false);
      if (cancelled) return;
      if (decidingRef.current) {
        timer = setTimeout(poll, 2000);
        return;
      }
      setResuming(gen);
      const updated = await loadHistory(chatId).catch(() => null);
      if (cancelled) return;
      if (updated && !decidingRef.current) setMessages(updated);
      if (gen) timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  const showActive = composerState.type === "active" || resuming;
  const activeSteps =
    composerState.type === "active"
      ? composerState.steps
      : resuming
        ? [{ key: "gen", label: "Generating…", kind: "thinking" as const }]
        : [];

  // The composer reports either a message (text + files) or ask-user answers.
  async function handleSubmit(data: ComposerSubmitData) {
    if (data.kind === "answers") {
      if (composerState.type !== "ask-user") return;
      // Flatten the composer's answer entries into question → picked text.
      const out: Record<string, string> = {};
      for (const a of data.answers) {
        out[a.question] =
          "option" in a
            ? a.option
            : "options" in a
              ? [...(a.options ?? []), a.text].filter(Boolean).join(", ")
              : "text" in a
                ? a.text
                : "";
      }
      await answerAskUser(composerState.toolCallId, out);
      return;
    }
    sendMessage({ text: data.text, files: data.files });
  }

  // A finished voice recording: the transcript becomes the user message, with
  // a marker so it renders (and persists) as a voice message. Recording is
  // allowed while the agent is still streaming, but sending mid-stream would
  // corrupt the turn — queue the transcript and send once the chat is ready.
  // Status is read through refs: `onTranscribed` fires from a closure created
  // when recording STARTED, whose captured `busy` may be long stale.
  const queuedVoiceRef = useRef<{ text: string; durationMs: number } | null>(null);
  const chatBusyRef = useRef(false);
  chatBusyRef.current = busy || deciding;
  function sendVoiceMessage(text: string, durationMs: number) {
    sendMessage({ text, metadata: { visibility: "user", voice: { durationMs } } });
  }
  function handleVoiceTranscribed(text: string, durationMs: number) {
    if (chatBusyRef.current) {
      queuedVoiceRef.current = { text, durationMs };
      return;
    }
    sendVoiceMessage(text, durationMs);
  }
  useEffect(() => {
    if (busy || deciding || !queuedVoiceRef.current) return;
    const queued = queuedVoiceRef.current;
    queuedVoiceRef.current = null;
    sendVoiceMessage(queued.text, queued.durationMs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, deciding]);

  // Latest messages, for seeding the approval-continuation stream (a click
  // handler / mount effect would otherwise close over a stale snapshot).
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // Merge a paused-turn continuation (approval / tool-result resume) into the
  // message list as it streams, then reconcile against authoritative history.
  async function consumeResume(stream: ReadableStream<UIMessageChunk> | null) {
    if (stream) {
      // The continuation reuses the last assistant message's id and streams
      // only the new parts; seed the reader with a clone of that message and
      // let the deltas fill it in live (the reader mutates the seed in place).
      const last = [...messagesRef.current].reverse().find((m) => m.role === "assistant");
      const seed = last ? (structuredClone(last)) : undefined;
      for await (const snapshot of readUIMessageStream<AppMessage>({ message: seed, stream })) {
        setMessages((prev) => {
          const next = [...prev];
          const i = next.findIndex((m) => m.id === snapshot.id);
          if (i >= 0) next[i] = snapshot;
          else next.push(snapshot);
          return next;
        });
      }
    }
    // Reconcile against authoritative server history (also covers the still-paused case).
    const updated = await loadHistory(chatId);
    setMessages(updated);
    router.invalidate();
  }

  /**
   * Mirror the server's applyDecisions on the local copy BEFORE streaming the
   * continuation: the stream re-emits the tool part only once it has output, so
   * without this the part stays `approval-requested` client-side for the whole
   * execution and the approval card sits on screen instead of the tool's live
   * view (for run_evals, minutes of frozen dialog).
   */
  function applyLocalDecision(approvalId: string, approved: boolean) {
    const next = messagesRef.current.map((m) => {
      const parts = (m as { parts?: unknown[] }).parts;
      if (!Array.isArray(parts)) return m;
      let touched = false;
      const nextParts = parts.map((part) => {
        const p = part as ApprovalPart;
        if (p.state !== "approval-requested" || p.approval?.id !== approvalId) return part;
        touched = true;
        return { ...p, state: "approval-responded", approval: { ...p.approval, approved } };
      });
      return touched ? { ...m, parts: nextParts } : m;
    });
    // Update the ref too: consumeResume seeds the continuation reader from it,
    // and React may not have re-rendered by then.
    messagesRef.current = next as never;
    setMessages(next as never);
  }

  async function decide(approvalId: string, approved: boolean) {
    setDeciding(true);
    applyLocalDecision(approvalId, approved);
    try {
      await consumeResume(await submitApproval(chatId, agent, [{ approvalId, approved }]));
    } finally {
      setDeciding(false);
    }
  }

  // Answer a paused `askUser` tool: persist the result server-side and stream
  // the continuation. `addToolResult` updates the local message optimistically
  // so the questionnaire closes and shows the answered summary right away.
  async function answerAskUser(toolCallId: string, output: Record<string, string>) {
    setDeciding(true);
    try {
      void addToolResult({ tool: "askUser", toolCallId, output });
      await consumeResume(await submitToolResult(chatId, agent, toolCallId, output));
    } finally {
      setDeciding(false);
    }
  }

  // Returning from an OAuth connect (`?connected=<name>`): the run is paused on a
  // `connect_<name>` approval. Approve it now so the continuation streams in.
  const resumedRef = useRef(false);
  useEffect(() => {
    if (resumedRef.current) return;
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    if (!connected) return;
    resumedRef.current = true;
    const url = new URL(window.location.href);
    url.searchParams.delete("connected");
    window.history.replaceState({}, "", url);
    const approvalId = pendingConnectApprovalId(initialMessages, connected);
    if (approvalId) void decide(approvalId, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Approve/deny (or in-chat Connect) UI for a tool part awaiting a decision. */
  function renderApproval(part: ToolPart) {
    const p = part as ApprovalPart;
    const name = p.type === "dynamic-tool" ? p.toolName : p.type.replace(/^tool-/, "");
    const approvalId = p.approval?.id;
    if (!approvalId) return null;

    if (name?.startsWith("connect_")) {
      const conn = name.replace(/^connect_/, "");
      return (
        <div className="border-primary-border bg-primary rounded-md border p-2">
          {deciding ? (
            <div className="text-ink-secondary flex items-center gap-2 text-sm">
              <Loader2 className="size-4 animate-spin" />
              Connecting <span className="font-medium">{conn}</span> and resuming…
            </div>
          ) : (
            <>
              <div className="text-sm">
                Connect <span className="font-medium">{conn}</span> to continue.
              </div>
              <p className="text-ink-tertiary my-1 text-xs">
                You'll authorize access, then this conversation resumes automatically.
              </p>
              <Button
                size="sm"
                onClick={() => {
                  window.location.href = authorizeUrl(conn, {
                    chatId,
                    approvalId,
                    returnTo: `/chat/${chatId}`,
                  });
                }}
              >
                Connect {conn}
              </Button>
            </>
          )}
        </div>
      );
    }

    return (
      <div className="border-primary-border bg-primary rounded-md border p-2">
        <div className="text-sm">
          Approve <span className="font-medium">{name}</span>?
        </div>
        <pre className="text-ink-secondary my-1 overflow-x-auto text-xs">
          {JSON.stringify(p.input, null, 2)}
        </pre>
        <div className="flex gap-2">
          <Button size="sm" disabled={deciding} onClick={() => decide(approvalId, true)}>
            Approve
          </Button>
          <Button size="sm" variant="outline" disabled={deciding} onClick={() => decide(approvalId, false)}>
            Deny
          </Button>
        </div>
      </div>
    );
  }

  const lastId = messages.at(-1)?.id;

  return (
    <div className="flex h-full min-w-0">
      <div className="relative flex h-full min-w-0 flex-1 flex-col">
        {editable && (
          <button
            type="button"
            onClick={() => setDrawerOn(!drawerOn)}
            aria-pressed={showEvals}
            className={cn(
              "border-secondary-border bg-secondary text-ink-secondary hover:text-ink-primary absolute top-2 right-2 z-10 inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs",
              showEvals && "text-ink-primary",
            )}
          >
            <Telescope className="size-3.5" /> Evals
          </button>
        )}
        <Thread autoScroll={scrollMode}>
          <Thread.Overlay direction="top" />
      <Thread.Viewport>
        {messages.length === 0 ? (
          <Thread.Placeholder>
            <p className="text-ink-primary text-sm font-medium">{agent}</p>
            <p className="text-ink-tertiary text-sm">
              Ask anything. Try “charge customer Acme $49” to see a tool approval.
            </p>
          </Thread.Placeholder>
        ) : (
          messages.map((m) => {
            const runId = (m.metadata as { runId?: string } | undefined)?.runId;
            const isAssistant = m.role === "assistant";
            const settled = isAssistant && !(busy && m.id === lastId);
            // Show badges/pending for owners watching evals, once the message
            // is complete and carries a run id.
            const showScores =
              editable && (drawerOn || hasRubrics) && settled && !!runId;
            return (
              <div key={m.id}>
                <Message
                  message={m as unknown as AppUIMessage}
                  isStreaming={busy && m.id === lastId && isAssistant}
                  renderApproval={renderApproval}
                  renderSubagent={(part) => (
                    <SubagentThread part={part} progress={subagentProgressFor(messages, part)} />
                  )}
                  renderTool={(part) =>
                    part.type === "tool-run_evals" ? (
                      <EvalRunCard part={part} progress={evalProgressFor(messages, part)} />
                    ) : undefined
                  }
                  onRegenerate={
                    isAssistant && !busy ? () => regenerate({ messageId: m.id }) : undefined
                  }
                  onFeedback={
                    isAssistant && !busy && runId
                      ? (value: 0 | 1) => setFeedbackFor({ messageId: m.id, runId, initial: value })
                      : undefined
                  }
                  feedbackValue={feedbackGiven[m.id]}
                />
                {showScores && (
                  <ScoreBadges
                    runId={runId}
                    scores={runId ? scores[runId] : undefined}
                    pending={hasRubrics && runId === latestRunId}
                    canCorrect={editable}
                    onCorrected={(rid, updated) =>
                      merge(rid, (scores[rid] ?? []).map((s) => (s.name === updated.name ? updated : s)))
                    }
                  />
                )}
              </div>
            );
          })
        )}
        <FeedbackDialog
          key={feedbackFor ? `${feedbackFor.messageId}-${feedbackFor.initial}` : "closed"}
          open={feedbackFor !== null}
          onOpenChange={(open) => {
            if (!open) setFeedbackFor(null);
          }}
          initialValue={feedbackFor?.initial}
          onSubmit={async ({ value, comment }) => {
            if (!feedbackFor) return;
            const res = await submitFeedbackFn({
              data: { runId: feedbackFor.runId, value, comment },
            });
            if (!res.ok) throw new Error(res.error);
            setFeedbackGiven((prev) => ({ ...prev, [feedbackFor.messageId]: value }));
          }}
        />
      </Thread.Viewport>
      <Thread.Composer>
        <Thread.ScrollButton />
        <Composer
          onSubmit={handleSubmit}
          isSubmitting={busy}
          questions={isAskUser ? composerState.questions : undefined}
        >
          <Composer.Panel value={showActive ? "active" : isAskUser ? "ask-user" : undefined}>
            <Composer.PanelItem value="active">
              <StepQueue>
                {activeSteps.map((step, i) => {
                  const active = i === activeSteps.length - 1;
                  return (
                    <StepQueue.Item key={step.key}>
                      <StepQueue.Icon>
                        {step.kind === "thinking" ? (
                          <Brain className={cn("size-3.5", active && "animate-pulse")} />
                        ) : active ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <CircleDot className="size-3.5" />
                        )}
                      </StepQueue.Icon>
                      <StepQueue.Label active={active}>{step.label}</StepQueue.Label>
                    </StepQueue.Item>
                  );
                })}
              </StepQueue>
            </Composer.PanelItem>
            <Composer.PanelItem value="ask-user">
              <Composer.AskUser />
            </Composer.PanelItem>
          </Composer.Panel>

          <Composer.Container>
            <Composer.Attachments />
            <Composer.Textarea autoFocus>
              <Composer.Placeholder
                placeholder={
                  isAskUser ? "Or type your own answer…" : busy ? "Thinking…" : "Message the agent…"
                }
              />
            </Composer.Textarea>
            {isAskUser ? (
              <Composer.Actions className="flex items-center justify-end">
                <Composer.AskUserHints />
                <Composer.AskUserDismiss />
                <Composer.AskUserContinue />
              </Composer.Actions>
            ) : (
              <Composer.Actions className="flex items-center justify-between">
                <div className="flex items-center gap-1">
                  <Composer.AttachmentTrigger />
                  <VoiceRecorder onTranscribed={handleVoiceTranscribed} />
                </div>
                <Composer.Submit isGenerating={busy} onStop={stop} />
              </Composer.Actions>
            )}
          </Composer.Container>
        </Composer>
      </Thread.Composer>
          <Thread.Overlay direction="bottom" />
        </Thread>
      </div>
      {showEvals && (
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
  );
}

/**
 * A `spawn_agent` tool call: header + the subagent conversation. While the
 * subagent runs, the streamed `data-subagent-progress` part renders the
 * delegated exchange LIVE (expanded by default, collapsible); once the tool
 * result lands, it reverts to the lazy-expandable persisted thread.
 */
function SubagentThread({ part, progress }: { part: ToolPart; progress?: SubagentProgressData }) {
  const p = part as {
    state?: string;
    input?: { agent?: string; threadId?: string };
    output?: { threadId?: string; answer?: string };
  };
  const agent = p.input?.agent ?? progress?.agent ?? "agent";
  const threadId = p.output?.threadId ?? p.input?.threadId ?? progress?.threadId;
  const running = p.state === "input-streaming" || p.state === "input-available";
  const live = running && progress ? progress : undefined;

  const [open, setOpen] = useState(false);
  const [liveCollapsed, setLiveCollapsed] = useState(false);
  const [msgs, setMsgs] = useState<AppMessage[] | null>(null);
  const [loading, setLoading] = useState(false);

  async function toggle() {
    if (live) {
      setLiveCollapsed((c) => !c);
      return;
    }
    const next = !open;
    setOpen(next);
    if (next && !msgs && threadId) {
      setLoading(true);
      const h = await loadHistory(threadId).catch(() => [] as AppMessage[]);
      setMsgs(h);
      setLoading(false);
    }
  }

  const expanded = live ? !liveCollapsed : open;

  return (
    <div className="border-primary-border overflow-hidden rounded-lg border">
      <button
        type="button"
        onClick={toggle}
        disabled={!live && !threadId}
        className="hover:bg-primary-hover flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors disabled:opacity-60"
      >
        <Bot className="text-ink-secondary size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          Delegated to <span className="font-medium">{agent}</span>
        </span>
        {running && <Loader2 className="text-ink-tertiary size-3.5 shrink-0 animate-spin" />}
        {(live || threadId) && (
          <ChevronDown
            className={cn(
              "text-ink-tertiary size-4 shrink-0 transition-transform",
              expanded && "rotate-180",
            )}
          />
        )}
      </button>
      {expanded && (
        <div className="border-primary-border bg-base/40 space-y-3 border-t p-3">
          {live ? (
            live.messages.length > 0 ? (
              live.messages.map((m) => (
                <Message key={m.id} message={m as unknown as AppUIMessage} />
              ))
            ) : (
              <p className="text-ink-tertiary text-xs">Starting…</p>
            )
          ) : loading ? (
            <p className="text-ink-tertiary text-xs">Loading…</p>
          ) : msgs && msgs.length > 0 ? (
            msgs.map((m) => <Message key={m.id} message={m as unknown as AppUIMessage} />)
          ) : (
            <p className="text-ink-tertiary text-xs">No messages.</p>
          )}
        </div>
      )}
    </div>
  );
}

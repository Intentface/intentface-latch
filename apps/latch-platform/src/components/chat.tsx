import { useEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, readUIMessageStream } from "ai";
import { useRouter } from "@tanstack/react-router";
import { Brain, CircleDot, Loader2 } from "lucide-react";
import {
  cn,
  Composer,
  Message,
  StepQueue,
  Thread,
  useComposerState,
  useSettingsStore,
  type AppUIMessage,
  type ComposerSubmitData,
  type ToolPart,
} from "@intentface/latch-ui";
import type { AppMessage } from "@intentface/latch-core";
import {
  authorizeUrl,
  chatApi,
  loadHistory,
  submitApproval,
  submitToolResult,
} from "@/lib/latch-client";
import { chatGeneratingFn } from "@/lib/server";
import type { UIMessageChunk } from "ai";
import { Button } from "@/components/ui/button";

/** Loose view of a tool part's approval fields (SDK types keep these opaque). */
type ApprovalPart = {
  type: string;
  toolName?: string;
  state?: string;
  input?: unknown;
  approval?: { id: string; approved?: boolean };
};

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
  const { messages, sendMessage, setMessages, status, addToolResult, regenerate, stop } = useChat({
    id: chatId,
    messages: initialMessages,
    transport: new DefaultChatTransport({ api: chatApi(chatId, agent) }),
    onFinish: () => router.invalidate(),
  });
  const busy = status === "submitted" || status === "streaming";
  const scrollMode = useSettingsStore((s) => s.scrollMode);
  const composerState = useComposerState(messages, status);
  const isAskUser = composerState.type === "ask-user";

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
      const gen = await chatGeneratingFn({ data: chatId }).catch(() => false);
      if (cancelled) return;
      setResuming(gen);
      const updated = await loadHistory(chatId).catch(() => null);
      if (cancelled) return;
      if (updated) setMessages(updated as never);
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
      const seed = last ? (structuredClone(last) as AppMessage) : undefined;
      for await (const snapshot of readUIMessageStream<AppMessage>({ message: seed, stream })) {
        setMessages((prev) => {
          const next = [...prev];
          const i = next.findIndex((m) => m.id === snapshot.id);
          if (i >= 0) next[i] = snapshot as never;
          else next.push(snapshot as never);
          return next;
        });
      }
    }
    // Reconcile against authoritative server history (also covers the still-paused case).
    const updated = await loadHistory(chatId);
    setMessages(updated as never);
    router.invalidate();
  }

  async function decide(approvalId: string, approved: boolean) {
    setDeciding(true);
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
          messages.map((m) => (
            <Message
              key={m.id}
              message={m as unknown as AppUIMessage}
              isStreaming={busy && m.id === lastId && m.role === "assistant"}
              renderApproval={renderApproval}
              onRegenerate={
                m.role === "assistant" && !busy ? () => regenerate({ messageId: m.id }) : undefined
              }
            />
          ))
        )}
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
                <Composer.AttachmentTrigger />
                <Composer.Submit isGenerating={busy} onStop={stop} />
              </Composer.Actions>
            )}
          </Composer.Container>
        </Composer>
      </Thread.Composer>
      <Thread.Overlay direction="bottom" />
    </Thread>
  );
}

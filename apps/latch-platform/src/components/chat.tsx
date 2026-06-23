import { useEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithToolCalls,
  readUIMessageStream,
} from "ai";
import { useRouter } from "@tanstack/react-router";
import { Brain, CircleDot, Loader2 } from "lucide-react";
import {
  AskUser,
  cn,
  Composer,
  Message,
  StepQueue,
  Thread,
  useComposerState,
  useSettingsStore,
  type AppUIMessage,
  type AskUserHandle,
  type ToolPart,
} from "@intentface/latch-ui";
import type { AppMessage } from "@intentface/latch-core";
import {
  authorizeUrl,
  chatApi,
  loadHistory,
  submitApproval,
} from "@/lib/latch-client";
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
  const { messages, sendMessage, setMessages, status, addToolResult, regenerate } = useChat({
    id: chatId,
    messages: initialMessages,
    transport: new DefaultChatTransport({ api: chatApi(chatId, agent) }),
    // Auto-resume the run once a client-handled tool (askUser) gets its answer.
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    onFinish: () => router.invalidate(),
  });
  const busy = status === "submitted" || status === "streaming";
  const scrollMode = useSettingsStore((s) => s.scrollMode);
  const composerState = useComposerState(messages, status);
  const askRef = useRef<AskUserHandle>(null);

  // Map composer keystrokes onto the ask-user questionnaire while it's open, so
  // the user can answer entirely from the keyboard without leaving the input.
  function handleAskKey(e: React.KeyboardEvent): boolean {
    const h = askRef.current;
    if (!h) return false;
    switch (e.key) {
      case "ArrowUp":
        h.navigate(-1);
        return true;
      case "ArrowDown":
        h.navigate(1);
        return true;
      case "ArrowLeft":
        h.prev();
        return true;
      case "ArrowRight":
        h.next();
        return true;
      case "Enter":
        h.enter();
        return true;
      default:
        if (/^[1-9]$/.test(e.key)) {
          h.pickIndex(Number(e.key) - 1);
          return true;
        }
        return true; // swallow other keys in capture mode
    }
  }

  // Latest messages, for seeding the approval-continuation stream (a click
  // handler / mount effect would otherwise close over a stale snapshot).
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  async function decide(approvalId: string, approved: boolean) {
    setDeciding(true);
    try {
      const stream = await submitApproval(chatId, agent, [{ approvalId, approved }]);
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
        {composerState.type === "ask-user" && (
          <div className="border-primary-border bg-secondary mb-2 w-full overflow-hidden rounded-2xl border shadow-xs [corner-shape:squircle]">
            <AskUser
              ref={askRef}
              questions={composerState.questions}
              onSubmit={(answers) =>
                void addToolResult({
                  tool: "askUser",
                  toolCallId: composerState.toolCallId,
                  output: answers,
                })
              }
            />
          </div>
        )}
        {composerState.type === "active" && (
          <div className="border-primary-border bg-primary mb-2 w-full overflow-hidden rounded-2xl border shadow-xs [corner-shape:squircle]">
            <StepQueue>
              {composerState.steps.map((step, i) => {
                const active = i === composerState.steps.length - 1;
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
          </div>
        )}
        <Composer
          disabled={busy}
          capture={composerState.type === "ask-user"}
          onCaptureKey={handleAskKey}
          placeholder={
            composerState.type === "ask-user"
              ? "Use ↑↓ and Enter to answer…"
              : "Message the agent…"
          }
          onSubmit={(text, files) => sendMessage({ text, files })}
        />
      </Thread.Composer>
      <Thread.Overlay direction="bottom" />
    </Thread>
  );
}

import { useEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, readUIMessageStream } from "ai";
import { useRouter } from "@tanstack/react-router";
import { Loader2, Send } from "lucide-react";
import { Message, Thread, type AppUIMessage, type ToolPart } from "@intentface/latch-ui";
import type { AppMessage } from "@intentface/latch-core";
import {
  authorizeUrl,
  chatApi,
  loadHistory,
  submitApproval,
} from "@/lib/latch-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
  const [input, setInput] = useState("");
  const [deciding, setDeciding] = useState(false);
  const { messages, sendMessage, setMessages, status } = useChat({
    id: chatId,
    messages: initialMessages,
    transport: new DefaultChatTransport({ api: chatApi(chatId, agent) }),
    onFinish: () => router.invalidate(),
  });
  const busy = status === "submitted" || status === "streaming";

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
    <div className="flex h-full flex-col">
      <div className="text-ink-secondary border-b px-4 py-2 text-xs">
        Agent: <span className="text-ink-primary font-medium">{agent}</span>
      </div>

      <Thread>
        {messages.length === 0 && (
          <p className="text-ink-secondary mt-12 text-center text-sm">
            Ask anything. Try: “charge customer Acme $49” to see a tool approval.
          </p>
        )}
        {messages.map((m) => (
          <Message
            key={m.id}
            message={m as unknown as AppUIMessage}
            isStreaming={busy && m.id === lastId && m.role === "assistant"}
            renderApproval={renderApproval}
          />
        ))}
      </Thread>

      <form
        className="flex gap-2 border-t p-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!input.trim() || busy) return;
          sendMessage({ text: input });
          setInput("");
        }}
      >
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={busy ? "Thinking…" : "Message the agent…"}
          disabled={busy}
        />
        <Button type="submit" size="icon" disabled={busy || !input.trim()}>
          <Send className="size-4" />
        </Button>
      </form>
    </div>
  );
}

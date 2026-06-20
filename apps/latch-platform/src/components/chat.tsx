import { useEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useRouter } from "@tanstack/react-router";
import { Loader2, Send } from "lucide-react";
import type { AppMessage } from "@intentface/latch-core";
import {
  applyApproval,
  authorizeUrl,
  chatApi,
  loadHistory,
} from "@/lib/latch-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type ToolPart = {
  state?: string;
  input?: unknown;
  output?: unknown;
  approval?: { id: string; approved?: boolean };
};

/** The approval id of a pending `connect_<name>` gate, if one is awaiting a decision. */
function pendingConnectApprovalId(
  msgs: AppMessage[] | undefined,
  name: string,
): string | undefined {
  for (const m of msgs ?? []) {
    for (const part of m.parts ?? []) {
      const p = part as ToolPart & { type: string; toolName?: string };
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

  async function decide(approvalId: string, approved: boolean) {
    setDeciding(true);
    try {
      await applyApproval(chatId, agent, [{ approvalId, approved }]);
      const updated = await loadHistory(chatId);
      setMessages(updated as never);
      router.invalidate();
    } finally {
      setDeciding(false);
    }
  }

  // Returning from an OAuth connect (`?connected=<name>`): the run is paused on a
  // `connect_<name>` approval. Approve it now — the page is already rendered, so
  // the continuation (tool calls + answer) fills in with the working state,
  // instead of blocking a blank redirect until the whole turn finished.
  const resumedRef = useRef(false);
  useEffect(() => {
    if (resumedRef.current) return;
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    if (!connected) return;
    resumedRef.current = true;
    // Drop the param so a refresh doesn't re-fire the approval.
    const url = new URL(window.location.href);
    url.searchParams.delete("connected");
    window.history.replaceState({}, "", url);
    const approvalId = pendingConnectApprovalId(initialMessages, connected);
    if (approvalId) void decide(approvalId, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div className="text-muted-foreground border-b px-4 py-2 text-xs">
        Agent: <span className="text-foreground font-medium">{agent}</span>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {messages.length === 0 && (
          <p className="text-muted-foreground mt-12 text-center text-sm">
            Ask anything. Try: “charge customer Acme $49” to see a tool approval.
          </p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
            <div
              className={cn(
                "max-w-[80%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap",
                m.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted",
              )}
            >
              {m.parts.map((part, i) => {
                if (part.type === "text") return <span key={i}>{part.text}</span>;

                const isTool = part.type.startsWith("tool-") || part.type === "dynamic-tool";
                if (isTool) {
                  const tp = part as ToolPart;
                  const name =
                    part.type === "dynamic-tool"
                      ? (part as { toolName?: string }).toolName
                      : part.type.replace(/^tool-/, "");

                  if (tp.state === "approval-requested" && tp.approval) {
                    // A synthetic connect_<name> tool → render a Connect button
                    // that starts OAuth and resumes this chat on callback.
                    if (name?.startsWith("connect_")) {
                      const conn = name.replace(/^connect_/, "");
                      return (
                        <div key={i} className="bg-background text-foreground my-1 rounded-md border p-2">
                          {deciding ? (
                            // Back from OAuth → auto-approving + resuming the turn.
                            <div className="text-muted-foreground flex items-center gap-2 text-sm">
                              <Loader2 className="size-4 animate-spin" />
                              Connecting <span className="font-medium">{conn}</span> and resuming…
                            </div>
                          ) : (
                            <>
                              <div className="text-sm">
                                Connect <span className="font-medium">{conn}</span> to continue.
                              </div>
                              <p className="text-muted-foreground my-1 text-xs">
                                You'll authorize access, then this conversation resumes
                                automatically.
                              </p>
                              <Button
                                size="sm"
                                onClick={() => {
                                  window.location.href = authorizeUrl(conn, {
                                    chatId,
                                    approvalId: tp.approval!.id,
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
                      <div key={i} className="bg-background text-foreground my-1 rounded-md border p-2">
                        <div className="text-sm">
                          Approve <span className="font-medium">{name}</span>?
                        </div>
                        <pre className="text-muted-foreground my-1 text-xs">
                          {JSON.stringify(tp.input, null, 2)}
                        </pre>
                        <div className="flex gap-2">
                          <Button size="sm" disabled={deciding} onClick={() => decide(tp.approval!.id, true)}>
                            Approve
                          </Button>
                          <Button size="sm" variant="outline" disabled={deciding} onClick={() => decide(tp.approval!.id, false)}>
                            Deny
                          </Button>
                        </div>
                      </div>
                    );
                  }

                  const denied = tp.state === "approval-responded" && tp.approval?.approved === false;
                  return (
                    <Badge key={i} variant={denied ? "destructive" : "secondary"} className="my-1 mr-1">
                      🔧 {name}
                      <span className="opacity-60"> · {denied ? "denied" : (tp.state ?? "")}</span>
                    </Badge>
                  );
                }

                if (part.type.startsWith("data-")) {
                  return (
                    <Badge key={i} variant="outline" className="my-1 mr-1">
                      {part.type.replace(/^data-/, "")}
                    </Badge>
                  );
                }
                return null;
              })}
            </div>
          </div>
        ))}
      </div>

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

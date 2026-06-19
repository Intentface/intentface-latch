import { useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useRouter } from "@tanstack/react-router";
import { Send } from "lucide-react";
import type { AppMessage } from "@intentface/latch-core";
import { applyApprovalFn, loadHistoryFn } from "@/lib/chats.server";
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

export function Chat({
  chatId,
  initialMessages,
}: {
  chatId: string;
  initialMessages?: AppMessage[];
}) {
  const router = useRouter();
  const [input, setInput] = useState("");
  const [deciding, setDeciding] = useState(false);
  const { messages, sendMessage, setMessages, status } = useChat({
    id: chatId,
    messages: initialMessages,
    transport: new DefaultChatTransport({ api: "/api/chat" }),
    onFinish: () => router.invalidate(),
  });
  const busy = status === "submitted" || status === "streaming";

  async function decide(approvalId: string, approved: boolean) {
    setDeciding(true);
    try {
      await applyApprovalFn({ data: { chatId, decisions: [{ approvalId, approved }] } });
      const updated = await loadHistoryFn({ data: chatId });
      setMessages(updated as never);
      router.invalidate();
    } finally {
      setDeciding(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
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

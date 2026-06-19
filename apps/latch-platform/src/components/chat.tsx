import { useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useRouter } from "@tanstack/react-router";
import { Send } from "lucide-react";
import type { AppMessage } from "@intentface/latch-core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** Chat against /api/chat — the durable `assistant` agent, scoped to your org. */
export function Chat({
  chatId,
  initialMessages,
}: {
  chatId: string;
  initialMessages?: AppMessage[];
}) {
  const router = useRouter();
  const [input, setInput] = useState("");
  const { messages, sendMessage, status } = useChat({
    id: chatId,
    messages: initialMessages,
    transport: new DefaultChatTransport({ api: "/api/chat" }),
    // Refresh the sidebar once a (possibly new) chat finishes a turn.
    onFinish: () => router.invalidate(),
  });
  const busy = status === "submitted" || status === "streaming";

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {messages.length === 0 && (
          <p className="text-muted-foreground mt-12 text-center text-sm">
            Ask the agent anything. Runs are persisted and durable.
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
                if (part.type.startsWith("tool-") || part.type === "dynamic-tool") {
                  const name =
                    part.type === "dynamic-tool"
                      ? (part as { toolName?: string }).toolName
                      : part.type.replace(/^tool-/, "");
                  const state = (part as { state?: string }).state ?? "";
                  return (
                    <Badge key={i} variant="secondary" className="my-1 mr-1">
                      🔧 {name}
                      {state && <span className="opacity-60"> · {state}</span>}
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

import { useState } from "react";
import { createFileRoute, Link, useLoaderData } from "@tanstack/react-router";
import { Bot, MessageSquare, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentPickerDialog } from "@/components/agent-picker-dialog";

export const Route = createFileRoute("/chat/")({
  component: ChatIndex,
});

/** Human-friendly relative time ("just now", "3h ago", "Apr 2"). */
function ago(value: string | number | Date | undefined): string {
  if (!value) return "";
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const min = Math.round(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Format a USD cost compactly (sub-cent precision for small amounts). */
function fmtCost(n: number): string {
  return `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`;
}

function ChatIndex() {
  const { chats, agents } = useLoaderData({ from: "/chat" });
  const [picking, setPicking] = useState(false);
  const total = chats.reduce((s, c) => s + (c.cost ?? 0), 0);

  return (
    <div className="mx-auto h-full w-full max-w-3xl overflow-y-auto px-6 py-8">
      <div className="mb-6 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-ink-primary text-lg font-semibold tracking-tight">Chats</h1>
          <p className="text-ink-tertiary text-sm">
            Your conversations across agents
            {total > 0 && <> · {fmtCost(total)} total</>}.
          </p>
        </div>
        <Button size="sm" className="gap-1.5" onClick={() => setPicking(true)}>
          <Plus className="size-4" /> New chat
        </Button>
      </div>

      {picking && <AgentPickerDialog agents={agents} onClose={() => setPicking(false)} />}

      {chats.length === 0 ? (
        <div className="border-primary-border text-ink-tertiary flex flex-col items-center gap-3 rounded-xl border border-dashed py-16 text-center">
          <MessageSquare className="size-6 opacity-60" />
          <p className="text-sm">No chats yet. Start one to get going.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {chats.map((c) => (
            <Link
              key={c.id}
              to="/chat/$chatId"
              params={{ chatId: c.id }}
              search={{ agent: undefined }}
              className="group border-primary-border bg-secondary hover:border-accent-border flex items-start gap-3 rounded-xl border p-4 shadow-sm transition-colors"
            >
              <div className="bg-base text-ink-secondary grid size-9 shrink-0 place-items-center rounded-lg">
                <MessageSquare className="size-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-ink-primary truncate text-sm font-medium">
                  {c.title?.trim() || "Untitled chat"}
                </div>
                <div className="text-ink-tertiary mt-1 flex items-center gap-1.5 text-xs">
                  <Bot className="size-3" />
                  <span className="truncate">{c.agent}</span>
                  <span aria-hidden>·</span>
                  <span className="shrink-0">{ago(c.updatedAt)}</span>
                </div>
              </div>
              {c.cost > 0 && (
                <div className="text-ink-tertiary shrink-0 text-xs tabular-nums">
                  {fmtCost(c.cost)}
                </div>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

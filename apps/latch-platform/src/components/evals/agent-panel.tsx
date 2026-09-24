import { useEffect, useState } from "react";
import { Loader2, SquarePen, Sparkles, X } from "lucide-react";
import type { AppMessage } from "@intentface/latch-core";
import { loadHistoryFn } from "@/lib/server";
import { Chat } from "@/components/chat";

/**
 * The Evals agent, docked beside the Evals pages. Not a modal: the grid,
 * the threads and the chat are meant to be looked at together — the agent
 * says "4 of 6 end with a question" and the person opens those four.
 *
 * One conversation per agent under test, kept across page switches and
 * reloads, until the person starts a new one. Starters carry what is on
 * screen (agent, question set, run) so the first message needs no typing.
 */

const OPEN_KEY = "latch:evals-panel";
const chatKey = (agent: string) => `latch:evals-chat:${agent}`;

const read = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string | null) => {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* private mode: the panel still works, it just forgets */
  }
};

/** Whether the panel is open, remembered across the Evals pages. */
export function usePanelOpen() {
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(read(OPEN_KEY) === "1"), []);
  const set = (next: boolean) => {
    setOpen(next);
    write(OPEN_KEY, next ? "1" : null);
  };
  return [open, set] as const;
}

export type PanelContext = { agent: string; questionSet?: string; run?: string; checks?: string };

function startersFor(c: PanelContext) {
  const run = c.run ? `run ${c.run}` : c.questionSet ? `the latest run of ${c.questionSet}` : "the latest run";
  const checks = c.checks ? ` (checks: ${c.checks})` : "";
  return [
    {
      label: "What is failing, and why?",
      prompt: `For ${c.agent}, on ${run}${checks}: which checks fail most, and why? Read the failing threads before answering.`,
    },
    {
      label: "Read failing threads and suggest notes",
      prompt: `For ${c.agent}, on ${run}: read up to 5 threads that failed a check and suggest a note on each.`,
    },
    {
      label: "Where does @draft differ from live?",
      prompt: `For ${c.agent}, on ${run}: where does @draft differ from live, question by question? Read the threads that changed.`,
    },
    {
      label: "Triage the failure modes",
      prompt: `For ${c.agent}: find patterns in the notes people accepted, then triage each failure mode — fix, measure or leave — with reasons.`,
    },
  ];
}

export function EvalsAgentPanel({ open, onClose, context }: { open: boolean; onClose: () => void; context: PanelContext }) {
  const [chatId, setChatId] = useState<string | null>(null);
  const [history, setHistory] = useState<AppMessage[] | null>(null);

  // Resume this agent's conversation, or start one.
  useEffect(() => {
    if (!open) return;
    const kept = read(chatKey(context.agent));
    const id = kept ?? crypto.randomUUID();
    if (!kept) write(chatKey(context.agent), id);
    setHistory(null);
    setChatId(id);
    void loadHistoryFn({ data: id }).then((h) => setHistory(h as AppMessage[]));
  }, [open, context.agent]);

  const fresh = () => {
    const id = crypto.randomUUID();
    write(chatKey(context.agent), id);
    setHistory([]);
    setChatId(id);
  };

  if (!open) return null;
  return (
    <>
      {/* Make room: on wide screens the page moves left instead of hiding under the panel. */}
      <style>{`@media (min-width: 1280px) { .evals-page { margin-right: 452px; } } @media (max-width: 1799px) { .evals-nav { display: none !important; } }`}</style>
      <aside
        aria-label="Evals agent"
        className="smooth-shadow-ring-xs smooth-ring-primary-border bg-primary-bg fixed inset-y-2 right-2 z-40 flex w-[min(440px,calc(100vw-1rem))] flex-col overflow-hidden rounded-xl"
      >
        <div className="border-primary-border flex items-center gap-2 border-b px-4 py-2.5">
          <Sparkles className="text-ink-secondary size-4" />
          <div className="min-w-0 flex-1">
            <div className="text-ink-primary text-sm font-medium">Evals agent</div>
            <div className="text-ink-tertiary truncate text-xs">
              On {context.agent} · it suggests, you decide
            </div>
          </div>
          <button type="button" onClick={fresh} aria-label="New conversation" title="New conversation" className="text-ink-tertiary hover:text-ink-primary rounded p-1">
            <SquarePen className="size-4" />
          </button>
          <button type="button" onClick={onClose} aria-label="Close the evals agent" className="text-ink-tertiary hover:text-ink-primary rounded p-1">
            <X className="size-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1">
          {chatId && history !== null ? (
            <Chat key={chatId} chatId={chatId} agent="evals" initialMessages={history} embedded starters={startersFor(context)} />
          ) : (
            <div className="p-4">
              <Loader2 className="text-ink-tertiary size-4 animate-spin" />
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

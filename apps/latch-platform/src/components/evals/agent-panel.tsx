import { useCallback, useEffect, useState } from "react";
import { ChevronDown, Loader2, Pin, PinOff, Sparkles, SquarePen, X } from "lucide-react";
import { Tabs } from "@intentface/chat/tabs";
import type { AppMessage } from "@intentface/latch-core";
import { loadHistoryFn } from "@/lib/server";
import { Chat } from "@/components/chat";
import { cn } from "@/lib/utils";

/**
 * The Evals agent as a tab in the Evals header — the first thing in a dock of
 * things you have open, beside the fixed page links.
 *
 * The dock is the Tabs primitive: an open-ended, closable collection with at
 * most one showing. Its panel floats under its own tab by default — non-modal,
 * so the page stays usable behind it and the grid and the answer can be read
 * together — or pins to the side of the page when you want it to stay put.
 * Closing the tab (×) removes it; hiding (the chevron, or Esc) keeps the tab
 * and the conversation, just out of the way.
 *
 * One conversation per agent under test, kept across page switches and
 * reloads until the person starts a new one. Starters carry what is on screen.
 */

const DOCK_KEY = "latch:evals-dock";
const chatKey = (agent: string) => `latch:evals-chat:${agent}`;
const AGENT_TAB = "agent";

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
    /* private mode: the dock still works, it just forgets */
  }
};

type Dock = { items: string[]; value: string | null; pinned: boolean };

/** What is open in the dock, remembered across the Evals pages. Starts empty on the server. */
function useDock() {
  const [dock, setDock] = useState<Dock>({ items: [], value: null, pinned: false });
  useEffect(() => {
    try {
      const saved = JSON.parse(read(DOCK_KEY) ?? "null") as Dock | null;
      if (saved) setDock(saved);
    } catch {
      /* a stale shape: start empty */
    }
  }, []);
  const update = useCallback((patch: Partial<Dock>) => {
    setDock((d) => {
      const next = { ...d, ...patch };
      write(DOCK_KEY, JSON.stringify(next));
      return next;
    });
  }, []);
  return [dock, update] as const;
}

/** This agent's conversation: resumed, or started when there is none. */
function useConversation(agent: string, active: boolean) {
  const [chatId, setChatId] = useState<string | null>(null);
  const [history, setHistory] = useState<AppMessage[] | null>(null);
  useEffect(() => {
    if (!active) return;
    const kept = read(chatKey(agent));
    const id = kept ?? crypto.randomUUID();
    if (!kept) write(chatKey(agent), id);
    setHistory(null);
    setChatId(id);
    void loadHistoryFn({ data: id }).then((h) => setHistory(h as AppMessage[]));
  }, [agent, active]);
  const fresh = () => {
    const id = crypto.randomUUID();
    write(chatKey(agent), id);
    setHistory([]);
    setChatId(id);
  };
  return { chatId, history, fresh };
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

const tabClass =
  "border-primary-border text-ink-secondary hover:text-ink-primary data-[selected]:bg-primary-bg data-[selected]:text-ink-primary focus-visible:ring-ring flex h-8 cursor-default items-center gap-1.5 rounded-lg border pr-1 pl-2.5 text-sm outline-none focus-visible:ring-2";

/** The dock: the strip for the Evals header, and wherever its panel is showing. */
export function EvalsAgentDock({ context }: { context: PanelContext }) {
  const [dock, update] = useDock();
  const open = dock.items.includes(AGENT_TAB);
  const conversation = useConversation(context.agent, open);
  const showing = dock.value !== null;

  const ask = () => update({ items: open ? dock.items : [...dock.items, AGENT_TAB], value: AGENT_TAB });

  const header = (
    <div className="border-primary-border flex items-center gap-1.5 border-b px-3 py-2">
      <Sparkles className="text-ink-secondary size-4" />
      <div className="min-w-0 flex-1">
        <div className="text-ink-primary text-sm font-medium">Evals agent</div>
        <div className="text-ink-tertiary truncate text-xs">On {context.agent} · it suggests, you decide</div>
      </div>
      <IconButton label="New conversation" onClick={conversation.fresh}>
        <SquarePen className="size-4" />
      </IconButton>
      <IconButton label={dock.pinned ? "Float over the page" : "Pin beside the page"} onClick={() => update({ pinned: !dock.pinned })}>
        {dock.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
      </IconButton>
      <IconButton label="Hide (Esc)" onClick={() => update({ value: null })}>
        <ChevronDown className="size-4" />
      </IconButton>
    </div>
  );

  const viewport = (
    <Tabs.Viewport className="min-h-0 flex-1">
      {(id) =>
        id === AGENT_TAB ? (
          conversation.chatId && conversation.history !== null ? (
            <Chat
              key={conversation.chatId}
              chatId={conversation.chatId}
              agent="evals"
              initialMessages={conversation.history}
              embedded
              starters={startersFor(context)}
            />
          ) : (
            <div className="p-4">
              <Loader2 className="text-ink-tertiary size-4 animate-spin" />
            </div>
          )
        ) : null
      }
    </Tabs.Viewport>
  );

  return (
    <Tabs.Root
      items={dock.items}
      onItemsChange={(items) => update({ items, ...(items.length ? {} : { value: null }) })}
      value={dock.value}
      onValueChange={(value) => update({ value })}
      className="flex items-center gap-1.5"
    >
      {!open && (
        <button
          type="button"
          onClick={ask}
          className="border-primary-border bg-primary-bg text-ink-primary hover:bg-primary-bg-hover flex h-8 items-center gap-1.5 rounded-lg border px-3 text-sm"
        >
          <Sparkles className="size-4" /> Ask the evals agent
        </button>
      )}
      <Tabs.List className="flex items-center gap-1.5">
        {(id) =>
          id === AGENT_TAB ? (
            <Tabs.Trigger value={id} className={tabClass}>
              <Sparkles className="size-4" />
              Evals agent
              <Tabs.Action>
                <Tabs.Close
                  aria-label="Close the evals agent"
                  className="text-ink-tertiary hover:text-ink-primary hover:bg-primary-bg-hover flex size-5 items-center justify-center rounded"
                >
                  <X className="size-3.5" />
                </Tabs.Close>
              </Tabs.Action>
            </Tabs.Trigger>
          ) : null
        }
      </Tabs.List>

      {dock.pinned ? (
        showing && (
          <>
            {/* Make room: on wide screens the page moves left instead of hiding under the panel. */}
            <style>{`@media (min-width: 1280px) { .evals-page { margin-right: 452px; } } @media (max-width: 1799px) { .evals-nav { display: none !important; } .evals-sections { grid-template-columns: minmax(0, 1fr) !important; } }`}</style>
            <aside
              aria-label="Evals agent"
              className="border-primary-border bg-primary-bg fixed inset-y-2 right-2 z-40 flex w-[min(440px,calc(100vw-1rem))] flex-col overflow-hidden rounded-xl border"
            >
              {header}
              {viewport}
            </aside>
          </>
        )
      ) : (
        <Tabs.Portal>
          <Tabs.Positioner side="bottom" align="end" sideOffset={8} collisionPadding={8} className="z-40">
            <Tabs.Popup
              aria-label="Evals agent"
              className={cn(
                "border-primary-border bg-primary-bg flex h-[min(760px,calc(100vh-7rem))] w-[min(460px,calc(100vw-1rem))] flex-col overflow-hidden rounded-xl border shadow-lg",
                "origin-top-right transition-[opacity,scale] duration-150 data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
              )}
            >
              {header}
              {viewport}
            </Tabs.Popup>
          </Tabs.Positioner>
        </Tabs.Portal>
      )}
    </Tabs.Root>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} className="text-ink-tertiary hover:text-ink-primary hover:bg-primary-bg-hover rounded p-1">
      {children}
    </button>
  );
}

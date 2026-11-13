import { Shell } from "@intentface/chat/shell";
import { Tabs } from "@intentface/chat/tabs";
import { BookOpen, FileText, Notebook, PanelLeft, Sparkles, SquarePen, X } from "@keyline-icons/react";
import { useEffect, useState } from "react";
import { api, type Person } from "./api";
import { ChatView } from "./ChatView";
import { onAnswerFinished } from "./chats";
import { DocumentView } from "./DocumentView";
import { KnowledgeNav } from "./KnowledgeNav";
import { PeopleNav } from "./PeopleNav";
import { TrustMark } from "./TrustMark";
import { ACCENT, CARD, FOCUS_RING, GROUND, ICON_BUTTON, SECTION_LABEL } from "./ui";

/** The chat tab's value; every other tab is a file's path. */
const CHAT = "chat";

const newChatId = () => `chat_${crypto.randomUUID().slice(0, 8)}`;

/** Each person keeps their current chat across reloads. */
function chatIdFor(person: string, fresh = false): string {
  const key = `knowledge-example:chat:${person}`;
  try {
    const saved = fresh ? null : localStorage.getItem(key);
    if (saved) return saved;
    const id = newChatId();
    localStorage.setItem(key, id);
    return id;
  } catch {
    return newChatId();
  }
}

const narrow = () => typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches;

export function App() {
  const [people, setPeople] = useState<Person[]>([]);
  const [personId, setPersonId] = useState("maija");
  const [chatId, setChatId] = useState(() => chatIdFor("maija"));
  const [tabs, setTabs] = useState<string[]>([CHAT]);
  const [tab, setTab] = useState<string | null>(CHAT);
  // Bumped after each answer: the agent may have written to the knowledge.
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    api.people().then(setPeople, () => setPeople([]));
  }, []);
  useEffect(() => onAnswerFinished(() => setRevision((r) => r + 1)), []);

  const person = people.find((p) => p.id === personId);

  const switchTo = (id: string) => {
    if (id === personId) return;
    setPersonId(id);
    setChatId(chatIdFor(id));
    setTabs([CHAT]);
    setTab(CHAT);
  };

  const openFile = (path: string) => {
    setTabs((open) => (open.includes(path) ? open : [...open, path]));
    setTab(path);
  };

  const newChat = () => {
    setChatId(chatIdFor(personId, true));
    setTab(CHAT);
  };

  return (
    <Shell.Root
      defaultOpen={!narrow()}
      className={`group/shell fixed inset-0 flex overflow-hidden [--shell-sidebar-width:288px] ${GROUND}`}
    >
      {/* Rest the pointer on the left edge to float a collapsed sidebar back out. */}
      <Shell.Hotspot className="absolute inset-y-0 left-0 z-20 hidden w-5 data-[state=collapsed]:block" />

      {/* The gutter holds the sidebar's place; the sidebar itself is out of flow so it can float. On a phone it overlays instead. */}
      <div
        data-slot="shell-gutter"
        className="w-(--shell-sidebar-width) shrink-0 transition-[width] duration-150 ease-linear group-data-resizing/shell:transition-none group-data-[state=collapsed]/shell:w-0 max-md:hidden motion-reduce:transition-none"
      />

      <Shell.Sidebar
        className={[
          "absolute inset-y-0 left-0 z-10 flex w-(--shell-sidebar-width) min-w-[220px] max-w-[380px] flex-col overflow-hidden pt-2",
          GROUND,
          "transition-[left,top,bottom,padding-top,background-color,border-radius,box-shadow] duration-150 ease-linear",
          "data-[state=collapsed]:-left-(--shell-sidebar-width) data-[state=collapsed]:inset-y-2 data-[state=collapsed]:rounded-lg data-[state=collapsed]:pt-0",
          "data-[state=collapsed]:bg-white data-[state=collapsed]:not-data-[hotspot]:shadow-[0_0_0_1px_rgb(0_0_0/0.075),0_1px_2px_rgb(0_0_0/0.06),0_4px_8px_-2px_rgb(0_0_0/0.05)]",
          "dark:data-[state=collapsed]:bg-zinc-900",
          "data-[state=collapsed]:data-[hotspot]:left-2 data-[hotspot]:shadow-[0_0_0_1px_rgb(0_0_0/0.075),0_1px_2px_rgb(0_0_0/0.06),0_12px_32px_-8px_rgb(0_0_0/0.16)]",
          "max-md:shadow-[0_12px_32px_-8px_rgb(0_0_0/0.3)]",
          "motion-reduce:transition-none",
        ].join(" ")}
      >
        <div className="flex h-11 shrink-0 items-center gap-2 pr-2 pl-3.5">
          <span className={`grid size-5 shrink-0 place-items-center rounded-[5px] ${ACCENT}`}>
            <BookOpen className="size-3" />
          </span>
          <span className="min-w-0 flex-1 truncate font-semibold text-[13px] tracking-[-0.01em] text-zinc-900 dark:text-zinc-100">Advisor</span>
          <Shell.Trigger aria-label="Collapse sidebar" className={ICON_BUTTON}>
            <PanelLeft className="size-[15px]" />
          </Shell.Trigger>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-3">
          <p className={SECTION_LABEL}>Signed in as</p>
          {people.length > 0 && <PeopleNav people={people} selected={personId} onSelect={switchTo} />}
          {person && (
            <>
              <p className={`${SECTION_LABEL} mt-2`}>What {person.name.split(" ")[0]} can see</p>
              <KnowledgeNav person={person} revision={revision} openPath={tab} onOpen={openFile} />
            </>
          )}
        </div>

        <div className="grid shrink-0 grid-cols-[auto_1fr] items-baseline gap-x-2.5 gap-y-1 border-t border-zinc-950/6 px-3.5 py-2.5 text-[12px] leading-4 text-zinc-500 dark:border-white/6 dark:text-zinc-400">
          <TrustMark trusted label />
          <span>written by our staff; the agent follows it</span>
          <TrustMark trusted={false} label />
          <span>written by users; information only</span>
        </div>
      </Shell.Sidebar>

      <Shell.Grip
        aria-label="Resize sidebar"
        className={[
          "absolute inset-y-0 left-[calc(var(--shell-sidebar-width)+8px)] z-20 w-1.5 -translate-x-1/2 cursor-col-resize select-none max-md:hidden",
          "before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-transparent before:transition-colors before:duration-100",
          "before:[mask-image:linear-gradient(to_bottom,transparent_16px,black_72px,black_calc(100%-72px),transparent_calc(100%-16px))]",
          "hover:before:bg-[#0169cc] data-[resizing]:before:bg-[#0169cc] dark:hover:before:bg-[#4c9bea] dark:data-[resizing]:before:bg-[#4c9bea]",
          "focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-[#0169cc]/60",
          "data-[state=collapsed]:hidden",
        ].join(" ")}
      />

      <Shell.Viewport className="flex min-w-0 flex-1 flex-col p-2">
        {person && (
          <Tabs.Root
            items={tabs}
            // The chat tab can't be closed: put it back first if it was.
            onItemsChange={(next) => setTabs(next.includes(CHAT) ? next : [CHAT, ...next])}
            value={tab}
            onValueChange={setTab}
            selectOnClose="recent"
            className="flex min-h-0 flex-1 flex-col gap-2"
          >
            <div className="flex h-[30px] shrink-0 items-center gap-1">
              <Shell.Trigger aria-label="Open sidebar" className={`${ICON_BUTTON} hidden group-data-[state=collapsed]/shell:grid`}>
                <PanelLeft className="size-[15px]" />
              </Shell.Trigger>
              <Tabs.List aria-label="Open" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
                {(id) => (
                  <Tabs.Trigger value={id} aria-label={id === CHAT ? "Chat" : id} title={id === CHAT ? undefined : id} className={tabClass(id === CHAT)}>
                    <Tabs.Icon className="shrink-0 text-zinc-500 dark:text-zinc-400 [&>svg]:size-[15px]">
                      {id === CHAT ? <Sparkles /> : id.endsWith("/SKILL.md") ? <Notebook /> : <FileText />}
                    </Tabs.Icon>
                    <span className="min-w-0 truncate">{tabLabel(id, person)}</span>
                    {id !== CHAT && (
                      <Tabs.Action className="absolute inset-y-0 right-1.5 flex items-center opacity-0 transition-opacity group-hover/tab:opacity-100 group-data-[selected]/tab:opacity-100">
                        <Tabs.Close
                          aria-label={`Close ${id}`}
                          className={`grid size-5 shrink-0 cursor-pointer place-items-center rounded-full text-zinc-400 transition-colors hover:bg-zinc-950/5 hover:text-zinc-900 dark:text-zinc-500 dark:hover:bg-white/8 dark:hover:text-zinc-100 ${FOCUS_RING}`}
                        >
                          <X className="size-3.5" />
                        </Tabs.Close>
                      </Tabs.Action>
                    )}
                  </Tabs.Trigger>
                )}
              </Tabs.List>
              <button type="button" onClick={newChat} aria-label="New chat" title="New chat" className={ICON_BUTTON}>
                <SquarePen className="size-[15px]" />
              </button>
            </div>

            <Tabs.Viewport className={`min-h-0 flex-1 overflow-hidden rounded-lg ${CARD}`}>
              {(id) =>
                id === CHAT ? (
                  <ChatView key={`${personId}:${chatId}`} person={person} chatId={chatId} onOpenFile={openFile} />
                ) : (
                  <DocumentView key={id} person={person} path={id} revision={revision} />
                )
              }
            </Tabs.Viewport>
          </Tabs.Root>
        )}
      </Shell.Viewport>
    </Shell.Root>
  );
}

/** A file tab is named after its skill or file; the chat tab after who's asking. */
function tabLabel(id: string, person: Person) {
  if (id === CHAT) return `Chat as ${person.name.split(" ")[0]}`;
  const parts = id.split("/");
  return id.endsWith("/SKILL.md") ? parts.at(-2)! : parts.at(-1)!;
}

// From the Tabs docs demo: no strip behind the tabs, the open one raised to
// match the card below, and the close button's slot reserved so labels don't jump.
const tabClass = (fixed: boolean) =>
  [
    "group/tab relative flex h-[30px] min-w-0 shrink cursor-pointer select-none items-center gap-2 overflow-hidden",
    fixed ? "w-auto max-w-56 shrink-0 pr-3" : "w-44 pr-7",
    "rounded-md pl-2.5 font-medium text-[13px] text-zinc-700 transition-colors dark:text-zinc-300",
    "hover:bg-zinc-950/5 dark:hover:bg-white/8",
    "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#0169cc]/60",
    "data-[selected]:bg-white data-[selected]:bg-linear-to-b data-[selected]:from-white data-[selected]:to-[#fdfdfd] data-[selected]:text-zinc-900",
    "data-[selected]:shadow-[inset_0_1px_0_#fff,0_0_0_1px_rgb(0_0_0/0.075),0_1px_2px_rgb(0_0_0/0.07),0_2px_6px_-2px_rgb(0_0_0/0.05)]",
    "dark:data-[selected]:bg-[#2d2d30] dark:data-[selected]:from-[#313134] dark:data-[selected]:to-[#2a2a2d] dark:data-[selected]:text-zinc-100",
    "dark:data-[selected]:shadow-[inset_0_1px_0_rgb(255_255_255/0.1),inset_0_0_0_1px_rgb(255_255_255/0.05),0_0_0_1px_rgb(0_0_0/0.16),0_1px_2px_rgb(0_0_0/0.1)]",
  ].join(" ");

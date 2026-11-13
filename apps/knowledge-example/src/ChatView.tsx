import { type Chat, useChat } from "@ai-sdk/react";
import { Composer, type ComposerSubmitData } from "@intentface/chat/composer";
import { Message } from "@intentface/chat/message";
import { groupTurns } from "@intentface/chat/message-utils";
import { Steps } from "@intentface/chat/steps";
import { Thread, useThread } from "@intentface/chat/thread";
import { ArrowDown, ArrowUp, Check, ChevronDown, Circle, FileText, Folder, Pen, Search, Sparkles, Stop, X } from "@keyline-icons/react";
import { getToolOrDynamicToolName, isTextUIPart, isToolUIPart, type UIMessage } from "ai";
import { type ReactNode, useEffect, useState } from "react";
import type { Person } from "./api";
import { chatFor } from "./chats";
import { Markdown } from "./Markdown";
import { TrustMark } from "./TrustMark";
import { ACCENT, FOCUS_RING, RAISED, USER_BUBBLE } from "./ui";

const STARTERS: Record<string, string[]> = {
  maija: [
    "Tallinn says rebooking approvals are too slow in the morning peak. What should we change?",
    "Do rebookings under €2,000 still need a dispatcher's approval?",
    "Note for me: I want a proposal for batched approvals by Friday.",
  ],
  jussi: [
    "Can the rebooking agent auto-approve small rebookings again?",
    "Draft the message the agent shows a dispatcher when it proposes a rebooking.",
  ],
  omar: [
    "Patients feel accused by the chest-pain question. How should the intake assistant ask it?",
    "Could the assistant suggest a clinic based on the patient's symptoms?",
  ],
  sara: [
    "Add batched morning approvals, one list per carrier, to Northwind's rebooking playbook.",
    "Add a practice about batching approvals to /practices.",
  ],
};

/** The chat for one person and chat id. The chat itself lives in a store, so an answer keeps streaming while another tab is open. */
export function ChatView({ person, chatId, onOpenFile }: { person: Person; chatId: string; onOpenFile: (path: string) => void }) {
  const [chat, setChat] = useState<Chat<UIMessage> | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setChat(null);
    setFailed(null);
    chatFor(person.id, chatId).then(
      (c) => live && setChat(c),
      (e: unknown) => live && setFailed(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [person.id, chatId, attempt]);
  if (failed) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="rounded-lg bg-red-500/8 px-3.5 py-2.5 text-[13px] text-red-700 dark:text-red-300">
          Couldn't load this chat: {failed}.{" "}
          <button type="button" className="font-medium underline underline-offset-2" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </p>
      </div>
    );
  }
  return chat ? <LiveChat chat={chat} person={person} onOpenFile={onOpenFile} /> : null;
}

function LiveChat({ chat, person, onOpenFile }: { chat: Chat<UIMessage>; person: Person; onOpenFile: (path: string) => void }) {
  const { messages, sendMessage, status, stop, error } = useChat({ chat });
  const generating = status === "submitted" || status === "streaming";
  const send = (text: string) => void sendMessage({ text });

  const handleSubmit = (data: ComposerSubmitData) => {
    if (data.kind !== "message") return;
    const text = data.text.trim();
    if (text) send(text);
  };

  return (
    <Thread.Root className="relative flex h-full w-full overflow-hidden [--thread-overlay-top-height:1rem]">
      <Thread.Overlay direction="top" className="inset-x-0 top-0 z-1 h-(--thread-overlay-top-height) bg-linear-to-b from-white to-transparent dark:from-zinc-900" />
      <Thread.Viewport className="h-full w-full overflow-x-hidden overflow-y-auto outline-none [overflow-anchor:auto]">
        <div className="relative flex min-h-full w-full flex-col items-center pt-(--thread-overlay-top-height) pb-(--thread-overlay-bottom-height)">
          {messages.length === 0 ? (
            <Starters person={person} onPick={send} />
          ) : (
            <Thread.Content className="mx-auto flex min-h-full w-full max-w-2xl flex-col gap-6 px-4 sm:px-6 [&>*:last-child]:min-h-(--thread-turn-min-height,0px)">
              {groupTurns(messages).map((turn) => (
                <Message.Turn key={turn.key} className="flex flex-col gap-4">
                  {turn.messages.map((m) => (
                    <MessageView key={m.id} message={m} isLast={m.id === messages.at(-1)?.id} onOpenFile={onOpenFile} />
                  ))}
                </Message.Turn>
              ))}
              {status === "submitted" && <p className="text-[13px] text-zinc-400 dark:text-zinc-500">Thinking…</p>}
              {error && (
                <p className="rounded-lg bg-red-500/8 px-3.5 py-2.5 text-[13px] text-red-700 dark:text-red-300">The answer failed: {error.message}</p>
              )}
            </Thread.Content>
          )}
        </div>
      </Thread.Viewport>

      <Thread.Composer className="absolute inset-x-0 bottom-0 z-2 w-full">
        <div className="relative mx-auto flex w-full max-w-2xl flex-col items-center bg-linear-to-t from-white from-70% to-transparent px-4 pt-6 pb-4 sm:px-6 dark:from-zinc-900">
          <ScrollButton />
          <Composer.Root onSubmit={handleSubmit} isSubmitting={generating} className="flex w-full flex-col">
            <Composer.Container className="cursor-text rounded-xl bg-white p-1 shadow-[0_0_0_1px_rgb(0_0_0/0.08),0_1px_2px_-1px_rgb(0_0_0/0.08),0_6px_16px_-6px_rgb(0_0_0/0.1)] dark:bg-zinc-800 dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.06),inset_0_0_0_1px_rgb(255_255_255/0.07),0_0_0_1px_rgb(0_0_0/0.2),0_1px_2px_rgb(0_0_0/0.12),0_6px_16px_-6px_rgb(0_0_0/0.22)]">
              <Composer.Textarea
                autoFocus
                className="max-h-40 min-h-12 overflow-y-auto px-2.5 pt-2.5 text-sm text-zinc-900 dark:text-zinc-100 **:data-composer-editor:w-full **:data-composer-editor:max-w-none **:data-composer-editor:leading-6 [&_[data-composer-editor]:focus]:outline-none"
              >
                <Composer.Placeholder placeholder="Ask about designing your agent…" className="text-zinc-400 leading-6 dark:text-zinc-500" />
              </Composer.Textarea>
              <Composer.Actions className="flex h-12 items-center justify-end px-2.5">
                <Composer.Submit
                  isGenerating={generating}
                  onStop={stop}
                  aria-label={generating ? "Stop" : "Send"}
                  className={`flex size-7 cursor-pointer items-center justify-center rounded-full transition-opacity disabled:cursor-default disabled:opacity-40 ${ACCENT} ${FOCUS_RING}`}
                >
                  {generating ? <Stop className="size-[15px]" /> : <ArrowUp className="size-[15px]" />}
                </Composer.Submit>
              </Composer.Actions>
            </Composer.Container>
          </Composer.Root>
        </div>
      </Thread.Composer>
    </Thread.Root>
  );
}

const possessive = (name: string) => (name.endsWith("s") ? `${name}'` : `${name}'s`);

/** An empty chat says what the agent reads, and offers questions that show it. */
function Starters({ person, onPick }: { person: Person; onPick: (text: string) => void }) {
  return (
    <div className="flex w-full max-w-2xl flex-1 flex-col items-center justify-center gap-5 px-6 pb-40 text-center">
      <div className="flex flex-col items-center gap-1.5">
        <Sparkles className="size-5 text-zinc-500 dark:text-zinc-400" />
        <p className="font-medium text-[13px] text-zinc-900 dark:text-zinc-100">Ask the advisor</p>
        <p className="max-w-md text-[13px] leading-5 text-zinc-500 dark:text-zinc-400">
          It reads the shared practices, {possessive(person.org.name)} playbooks and docs, and {person.name.split(" ")[0]}'s notes before it answers.
        </p>
      </div>
      <div className="flex w-full flex-col items-center gap-2">
        {(STARTERS[person.id] ?? []).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onPick(s)}
            className={`max-w-full cursor-pointer rounded-xl px-3.5 py-2 text-left text-[13px] leading-5 transition-colors hover:from-[#fafafa] hover:to-[#f6f6f6] dark:hover:from-[#38383b] dark:hover:to-[#313134] ${RAISED} ${FOCUS_RING}`}
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

// useThread exposes the scroll state the viewport tracks; the button is ours.
function ScrollButton() {
  const { isAtBottom, scrollToBottom } = useThread();
  if (isAtBottom) return null;
  return (
    <button
      type="button"
      onClick={() => scrollToBottom()}
      aria-label="Scroll to latest"
      className={`absolute -top-10 z-10 flex size-8 cursor-pointer items-center justify-center rounded-full text-zinc-500 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 ${RAISED} ${FOCUS_RING}`}
    >
      <ArrowDown className="size-[15px]" />
    </button>
  );
}

type ToolPart = Extract<UIMessage["parts"][number], { toolCallId: string }>;
type Segment = { kind: "text"; text: string } | { kind: "tools"; parts: ToolPart[] };

/** Consecutive tool calls form one step list; text renders as Markdown. */
function MessageView({ message, isLast, onOpenFile }: { message: UIMessage; isLast: boolean; onOpenFile: (path: string) => void }) {
  const segments: Segment[] = [];
  for (const part of message.parts) {
    if (isTextUIPart(part) && part.text.trim()) segments.push({ kind: "text", text: part.text });
    else if (isToolUIPart(part)) {
      const last = segments.at(-1);
      if (last?.kind === "tools") last.parts.push(part as ToolPart);
      else segments.push({ kind: "tools", parts: [part as ToolPart] });
    }
  }
  if (!segments.length) return null;

  return (
    <Message.Root role={message.role} isLast={isLast} className="group flex w-full flex-col gap-3 data-[role=user]:items-end">
      {segments.map((s, i) =>
        s.kind === "text" ? (
          message.role === "user" ? (
            <p key={i} className={USER_BUBBLE}>
              {s.text}
            </p>
          ) : (
            <Markdown key={i}>{s.text}</Markdown>
          )
        ) : (
          <ToolSteps key={i} parts={s.parts} onOpenFile={onOpenFile} />
        ),
      )}
    </Message.Root>
  );
}

const VERBS: Record<string, [now: string, done: string, icon: ReactNode]> = {
  list_files: ["Listing", "Listed", <Folder key="i" className="size-[15px]" />],
  read_file: ["Reading", "Read", <FileText key="i" className="size-[15px]" />],
  glob: ["Finding", "Found", <Search key="i" className="size-[15px]" />],
  grep: ["Searching for", "Searched for", <Search key="i" className="size-[15px]" />],
  search_files: ["Searching", "Searched", <Search key="i" className="size-[15px]" />],
  write_file: ["Writing", "Wrote", <Pen key="i" className="size-[15px]" />],
  edit_file: ["Editing", "Edited", <Pen key="i" className="size-[15px]" />],
};

const isDone = (p: ToolPart) => p.state === "output-available" || p.state === "output-error";
const outputOf = (p: ToolPart) => (p.state === "output-available" ? String(p.output ?? "") : p.state === "output-error" ? (p.errorText ?? "") : "");

/** What the agent did with the knowledge: one collapsible timeline, a row per tool call. */
function ToolSteps({ parts, onOpenFile }: { parts: ToolPart[]; onOpenFile: (path: string) => void }) {
  const running = parts.some((p) => !isDone(p));
  const reads = parts.filter((p) => getToolOrDynamicToolName(p) === "read_file").length;
  const writes = parts.filter((p) => ["write_file", "edit_file"].includes(getToolOrDynamicToolName(p))).length;
  const summary = [reads && `read ${reads} ${reads === 1 ? "file" : "files"}`, writes && `changed ${writes}`].filter(Boolean).join(", ");

  return (
    <Steps.Root className="w-full">
      <Steps.Item defaultOpen status={running ? "active" : "complete"}>
        <Steps.Trigger className={`${TRIGGER_CLASS} font-medium`}>
          <span>{running ? "Looking through the knowledge…" : `Looked through the knowledge${summary ? `: ${summary}` : ""}`}</span>
          <ChevronDown className="size-[15px] shrink-0 -rotate-90 transition-transform group-data-open/steps-trigger:rotate-0" />
        </Steps.Trigger>
        <Steps.Panel className={PANEL_CLASS}>
          {parts.map((p, i) => (
            <ToolStep key={p.toolCallId} part={p} first={i === 0} onOpenFile={onOpenFile} />
          ))}
        </Steps.Panel>
      </Steps.Item>
    </Steps.Root>
  );
}

function ToolStep({ part, first, onOpenFile }: { part: ToolPart; first: boolean; onOpenFile: (path: string) => void }) {
  const name = getToolOrDynamicToolName(part);
  const input = (part.input ?? {}) as { path?: string; pattern?: string; query?: string };
  const done = isDone(part);
  const output = outputOf(part);
  const refused = output.startsWith("Refused") || part.state === "output-error";
  const status = !done ? "active" : refused ? "error" : "complete";
  const [now, past, icon] = VERBS[name] ?? [name, name, <Circle key="i" className="size-[15px]" />];
  const target = input.path ?? (input.pattern ? `“${input.pattern}”` : input.query ? `“${input.query}”` : "");
  // read_file's first line says how the agent was told to treat the file.
  const trusted = name === "read_file" && done && !refused ? output.split("\n")[0]?.includes("· trusted:") : undefined;
  const openable = done && !refused && !!input.path && name !== "list_files";

  return (
    <Steps.Item status={status}>
      {!first && <span aria-hidden="true" className={RAIL_CLASS} />}
      <div className="flex min-w-0 items-center gap-2">
        <Steps.Trigger className={`${TRIGGER_CLASS} min-w-0 flex-1`}>
          {/* The status glyph turns into a chevron on hover or focus, so the row gains an affordance without a second icon. */}
          <Steps.Icon className={`relative ${ICON_CLASS}`}>
            <span className="transition-opacity group-hover/steps-trigger:opacity-0 group-focus-visible/steps-trigger:opacity-0 group-data-open/steps-trigger:opacity-0">
              {status === "active" ? <Circle className="size-[15px] animate-pulse" /> : status === "error" ? <X className="size-[15px]" /> : done ? icon : <Check className="size-[15px]" />}
            </span>
            <ChevronDown className="absolute size-[15px] opacity-0 transition-all group-hover/steps-trigger:opacity-100 group-focus-visible/steps-trigger:opacity-100 group-data-open/steps-trigger:rotate-180 group-data-open/steps-trigger:opacity-100" />
          </Steps.Icon>
          <Steps.Label className={`${LABEL_CLASS} min-w-0 truncate`}>
            {done ? past : now} <span className="font-mono text-[12px]">{target}</span>
            {refused && <span className="ml-1.5 text-red-600 dark:text-red-400">refused</span>}
          </Steps.Label>
        </Steps.Trigger>
        <TrustMark trusted={trusted} label />
        {openable && (
          <button
            type="button"
            onClick={() => onOpenFile(input.path!)}
            className={`h-6 shrink-0 cursor-pointer rounded-md px-2 text-[12px] font-medium text-zinc-500 transition-colors hover:bg-zinc-950/5 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/8 dark:hover:text-zinc-100 ${FOCUS_RING}`}
          >
            Open
          </button>
        )}
      </div>
      <Steps.Panel className={PANEL_CLASS}>
        <pre className="my-1.5 max-h-64 overflow-auto rounded-lg bg-zinc-950/4 px-3 py-2.5 font-mono text-[12px] leading-5 whitespace-pre-wrap text-zinc-600 dark:bg-white/5 dark:text-zinc-300">
          {output || "…"}
        </pre>
      </Steps.Panel>
    </Steps.Item>
  );
}

// From the Steps docs demo: the group name children read open state through,
// a panel that animates from --panel-height, the rail joining the step icons,
// and status surfaced as data-status so one class string covers every state.
const TRIGGER_CLASS =
  "group/steps-trigger flex h-7 w-full cursor-pointer items-center gap-2.5 rounded-md text-[13px] text-zinc-500 transition-colors hover:text-zinc-900 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#0169cc]/60 dark:text-zinc-400 dark:hover:text-zinc-100";

const PANEL_CLASS =
  "flex flex-col overflow-hidden h-(--panel-height) transition-[height] duration-200 ease-out data-starting-style:h-0 data-ending-style:h-0 [&>*]:shrink-0 in-data-nested:ml-[7px] in-data-nested:border-l in-data-nested:border-zinc-950/10 in-data-nested:pl-[17px] dark:in-data-nested:border-white/10";

const RAIL_CLASS = "ml-[7px] block h-2 w-px bg-zinc-950/10 dark:bg-white/10";

const ICON_CLASS =
  "flex size-[15px] shrink-0 items-center justify-center data-[status=complete]:text-zinc-500 data-[status=active]:text-zinc-900 data-[status=error]:text-red-600 dark:data-[status=complete]:text-zinc-400 dark:data-[status=active]:text-zinc-100 dark:data-[status=error]:text-red-400";

const LABEL_CLASS =
  "text-left text-[13px] data-[status=complete]:text-zinc-700 data-[status=active]:font-medium data-[status=active]:text-zinc-900 data-[status=error]:text-zinc-700 dark:data-[status=complete]:text-zinc-300 dark:data-[status=active]:text-zinc-100 dark:data-[status=error]:text-zinc-300";

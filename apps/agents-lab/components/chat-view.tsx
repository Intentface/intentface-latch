"use client";

import { useEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
  type UIMessage,
} from "ai";
import { ArrowUp, Check, X } from "lucide-react";
import { Thread } from "@/components/ai/thread";
import { Message } from "@/components/ai/message";
import { Composer } from "@/components/ai/composer";
import { cn } from "@/lib/utils";
import type { ComposerCommandsMap } from "@intentface/chat/composer";

type ToolPart = {
  type: string;
  toolCallId?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  approval?: { id: string; approved?: boolean; reason?: string };
};

const isTool = (p: { type: string }): p is ToolPart => p.type.startsWith("tool-");
const toolName = (p: ToolPart) => p.type.slice("tool-".length);

/**
 * The browser half of a client tool. The server declares these with no
 * `execute`, so the run ENDS with the call unanswered and the page answers it.
 */
const readBrowserContext = () => ({
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  locale: navigator.language,
  screen: `${window.screen.width}x${window.screen.height}`,
  localTime: new Date().toLocaleString(),
});

interface RegisteredCommand {
  name: string;
  description: string;
  extension: string;
}

export function ChatView({ chatId, onTurnEnd }: { chatId: string; onTurnEnd: () => void }) {
  const [initial, setInitial] = useState<UIMessage[] | null>(null);
  const [commands, setCommands] = useState<RegisteredCommand[]>([]);

  // Fetched, not hardcoded: the palette is whatever the extensions registered.
  useEffect(() => {
    let live = true;
    void fetch("/api/commands")
      .then((r) => r.json())
      .then((d: { commands: RegisteredCommand[] }) => live && setCommands(d.commands ?? []))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    void fetch(`/api/chats/${chatId}`)
      .then((r) => r.json())
      .then((d: { messages: UIMessage[] }) => live && setInitial(d.messages ?? []))
      .catch(() => live && setInitial([]));
    return () => {
      live = false;
    };
  }, [chatId]);

  if (initial === null)
    return <div className="flex flex-1 items-center justify-center text-xs text-ink-tertiary">Loading…</div>;

  return (
    <Conversation chatId={chatId} initial={initial} commands={commands} onTurnEnd={onTurnEnd} />
  );
}

function Conversation({
  chatId,
  initial,
  commands,
  onTurnEnd,
}: {
  chatId: string;
  initial: UIMessage[];
  commands: RegisteredCommand[];
  onTurnEnd: () => void;
}) {
  const [refused, setRefused] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const compacted = useRef(false);

  /**
   * `execute` at document start: a slash command is only a command when it is
   * the whole message, which is also how the SDK parses it. Selecting one
   * fills the editor and leaves submitting to the person, so they can add
   * arguments — `/tidy` and `/whoami` take none, but `expand` commands may.
   */
  const composerCommands: ComposerCommandsMap = {
    "/": {
      kind: "execute",
      trigger: "doc-start",
      items: commands.map((c) => ({
        value: c.name,
        label: `/${c.name}`,
        description: c.description,
        keywords: c.extension,
        onSelect: ({ editor }) => {
          editor.clear();
          editor.insertText(`/${c.name} `);
          editor.focus();
        },
      })),
    },
  };

  const { messages, setMessages, sendMessage, addToolApprovalResponse, addToolOutput, status } =
    useChat({
    id: chatId,
    messages: initial,
    transport: new DefaultChatTransport({
      api: "/api/chat",
      // The server owns the transcript, so only the new turn is sent.
      prepareSendMessagesRequest: ({ messages: m, id }) => ({
        body: { chatId: id, messages: m.slice(-1) },
      }),
    }),
    // Answering a card — an approval or a browser tool's output — resolves the
    // suspension by starting a NEW run over the longer transcript. There is no
    // paused process, which is why this survives a reload.
    sendAutomaticallyWhen: ({ messages: m }) =>
      lastAssistantMessageIsCompleteWithApprovalResponses({ messages: m }) ||
      lastAssistantMessageIsCompleteWithToolCalls({ messages: m }),
    onToolCall: ({ toolCall }) => {
      if (toolCall.toolName !== "browserContext") return;
      addToolOutput({
        tool: "browserContext",
        toolCallId: toolCall.toolCallId,
        output: readBrowserContext(),
      });
    },
    // Compaction rewrites history on the SERVER. This client built its list
    // from the stream and has no idea the past changed, so it would keep
    // showing turns that no longer exist. Refetch when told.
    // Only MARK it here. `onData` fires mid-stream, and refetching then races
    // the stream: the server has the rewritten history but not yet this turn's
    // reply, which is persisted when the run ends. A reload landing after the
    // stream would then wipe the reply the reader just watched arrive.
    onData: (part) => {
      if (part.type === "data-compacted") compacted.current = true;
    },
    onFinish: () => {
      onTurnEnd();
      if (!compacted.current) return;
      compacted.current = false;
      setReloadKey((k) => k + 1);
    },
    onError: (e) => setRefused(e.message),
  });

  // The server rewrote history; this client's copy came from the stream and
  // still holds turns that no longer exist.
  useEffect(() => {
    if (reloadKey === 0) return;
    void fetch(`/api/chats/${chatId}`)
      .then((r) => r.json())
      .then((d: { messages: UIMessage[] }) => setMessages(d.messages ?? []))
      .catch(() => undefined);
  }, [reloadKey, chatId, setMessages]);

  const busy = status === "streaming" || status === "submitted";

  return (
    <Thread className="[--thread-width:42rem]">
      <Thread.Viewport>
            {messages.length === 0 && (
              <p className="text-sm text-ink-tertiary">
                Type <code className="text-ink-secondary">/help</code>, or ask to delete{" "}
                <code className="text-ink-secondary">old-backup.zip</code> to watch an extension
                refuse it.
              </p>
            )}

            {messages.map((m, i) => (
              <Message key={m.id} role={m.role} isLast={i === messages.length - 1}>
                <Message.Content>
                  {m.parts.map((part, j) => {
                    if (part.type === "text")
                      return <Message.Text key={j}>{(part as { text: string }).text}</Message.Text>;

                    // The compaction boundary: a divider, not a paragraph.
                    // The turns it covers are still above it to read; the
                    // summary itself is only ever sent to the model.
                    if (part.type === "data-compaction-summary") {
                      const d = (part as { data: { summarised: number; kept: number } }).data;
                      return (
                        <div key={j} className="flex items-center gap-3 py-1">
                          <span className="h-px flex-1 bg-quaternary-bg" />
                          <span className="text-2xs whitespace-nowrap text-ink-tertiary">
                            {d.summarised} earlier message{d.summarised === 1 ? "" : "s"} summarised
                            for the model
                          </span>
                          <span className="h-px flex-1 bg-quaternary-bg" />
                        </div>
                      );
                    }

                    if (part.type === "data-cost" || part.type.startsWith("data-notice-"))
                      return (
                        <p key={j} className="font-mono text-2xs text-ink-tertiary">
                          {String((part as { data: unknown }).data)}
                        </p>
                      );

                    if (isTool(part))
                      return (
                        <ToolCard
                          key={j}
                          part={part}
                          onApprove={(approved) =>
                            void addToolApprovalResponse({
                              id: part.approval!.id,
                              approved,
                              ...(approved ? {} : { reason: "Declined in the lab." }),
                            })
                          }
                          onAnswer={(answer) =>
                            addToolOutput({
                              tool: "askUser",
                              toolCallId: part.toolCallId!,
                              output: { answer },
                            })
                          }
                        />
                      );
                    return null;
                  })}
                </Message.Content>
              </Message>
            ))}

            {refused && (
              <p className="rounded-lg bg-primary-bg px-3 py-2 text-xs text-red-500 shadow-border">
                {refused}
              </p>
            )}
      </Thread.Viewport>

      <Thread.Composer>
        <div className="mx-auto flex w-full max-w-(--thread-width) flex-col px-4 pb-6">
          <Composer
            commands={composerCommands}
            onSubmit={(data) => {
              if (data.kind !== "message") return;
              const text = data.text.trim();
              if (!text) return;
              setRefused(null);
              void sendMessage({ text });
            }}
            className="flex w-full flex-col"
          >
            <Composer.Panel>
              {(composer: { commands: { active: boolean } }) =>
                composer.commands.active ? <Composer.Commands prefix="/" /> : null
              }
            </Composer.Panel>
            <Composer.Container className="cursor-text rounded-2xl bg-primary-bg shadow-border transition-colors">
              <Composer.Textarea className="max-h-40 min-h-9 overflow-y-auto px-4 pt-3 text-sm">
                <Composer.Placeholder
                  placeholder="Ask something, or type /help"
                  className="text-ink-tertiary"
                />
              </Composer.Textarea>
              <Composer.Actions className="flex items-center justify-end gap-2 p-2">
                <Composer.Submit
                  disabled={busy}
                  className="flex size-8 items-center justify-center rounded-full bg-accent-bg text-white transition-opacity disabled:opacity-40"
                >
                  <ArrowUp className="size-4" />
                </Composer.Submit>
              </Composer.Actions>
            </Composer.Container>
          </Composer>
        </div>
      </Thread.Composer>
    </Thread>
  );
}

function ToolCard({
  part,
  onApprove,
  onAnswer,
}: {
  part: ToolPart;
  onApprove: (approved: boolean) => void;
  onAnswer: (answer: string) => void;
}) {
  const name = toolName(part);
  const blocked =
    part.state === "output-available" &&
    (part.output as { blocked?: boolean } | undefined)?.blocked === true;

  return (
    <div
      className={cn(
        "rounded-xl bg-primary-bg px-3 py-2 text-xs shadow-border",
        blocked && "ring-1 ring-amber-500/30",
      )}
    >
      <div className="flex items-center justify-between">
        <span className="font-mono text-accent-bg">{name}</span>
        {part.state === "approval-requested" && (
          <span className="text-2xs text-ink-tertiary">needs approval</span>
        )}
      </div>

      {part.input != null && Object.keys(part.input).length > 0 && (
        <pre className="mt-1 overflow-x-auto font-mono text-2xs text-ink-tertiary">
          {JSON.stringify(part.input)}
        </pre>
      )}

      {part.state === "approval-requested" && part.approval && (
        <div className="mt-2 flex gap-2">
          <button
            onClick={() => onApprove(true)}
            className="flex items-center gap-1 rounded-md bg-accent-bg px-2.5 py-1 text-white transition-opacity hover:opacity-90"
          >
            <Check className="size-3" /> Approve
          </button>
          <button
            onClick={() => onApprove(false)}
            className="flex items-center gap-1 rounded-md bg-tertiary-bg px-2.5 py-1 text-ink-secondary transition-colors hover:bg-tertiary-bg-hover"
          >
            <X className="size-3" /> Deny
          </button>
        </div>
      )}

      {part.state === "input-available" && name === "askUser" && (
        <AskUser
          question={(part.input as { question?: string })?.question ?? "?"}
          placeholder={(part.input as { placeholder?: string })?.placeholder}
          onAnswer={onAnswer}
        />
      )}

      {part.state === "input-available" && name === "browserContext" && (
        <p className="mt-1 text-ink-tertiary">Reading your browser…</p>
      )}

      {part.state === "output-available" && (
        <pre className="mt-1 overflow-x-auto font-mono text-2xs text-ink-secondary">
          {JSON.stringify(part.output)}
        </pre>
      )}
      {part.state === "output-error" && <p className="mt-1 text-red-500">{part.errorText}</p>}
      {part.state === "output-denied" && <p className="mt-1 text-ink-tertiary">Denied.</p>}
    </div>
  );
}

function AskUser({
  question,
  placeholder,
  onAnswer,
}: {
  question: string;
  placeholder?: string;
  onAnswer: (answer: string) => void;
}) {
  const [value, setValue] = useState("");
  const [sent, setSent] = useState(false);
  if (sent) return null;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const answer = value.trim();
        if (!answer) return;
        setSent(true);
        onAnswer(answer);
      }}
      className="mt-2 space-y-2"
    >
      <p className="text-ink-primary">{question}</p>
      <div className="flex gap-2">
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder ?? "Your answer"}
          className="flex-1 rounded-md bg-tertiary-bg px-2 py-1 outline-none placeholder:text-ink-tertiary"
        />
        <button type="submit" className="rounded-md bg-accent-bg px-2.5 py-1 text-white">
          Answer
        </button>
      </div>
    </form>
  );
}

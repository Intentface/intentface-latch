import { useChat } from "@ai-sdk/react";
import { Composer } from "@intentface/chat/composer";
import { Steps } from "@intentface/chat/steps";
import { Thread } from "@intentface/chat/thread";
import { DefaultChatTransport, getToolOrDynamicToolName, isTextUIPart, isToolUIPart, type UIMessage } from "ai";
import { useEffect, useState } from "react";
import { api, type Person } from "./api";
import { Markdown } from "./Markdown";
import { TrustMark } from "./TrustMark";

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

const possessive = (name: string) => (name.endsWith("s") ? `${name}'` : `${name}'s`);

/** The chat for one person and chat id: history first, then live. */
export function Chat(props: { person: Person; chatId: string; onNewChat: () => void; onOpenFile: (path: string) => void; onTurnFinished: () => void }) {
  const [history, setHistory] = useState<UIMessage[] | null>(null);
  useEffect(() => {
    api.history(props.person.id, props.chatId).then(
      (m) => setHistory(m as UIMessage[]),
      () => setHistory([]),
    );
  }, [props.person.id, props.chatId]);
  return history ? <LiveChat {...props} history={history} /> : <p className="loading">Loading…</p>;
}

function LiveChat({
  person,
  chatId,
  history,
  onNewChat,
  onOpenFile,
  onTurnFinished,
}: {
  person: Person;
  chatId: string;
  history: UIMessage[];
  onNewChat: () => void;
  onOpenFile: (path: string) => void;
  onTurnFinished: () => void;
}) {
  const { messages, sendMessage, status, stop, error } = useChat({
    id: chatId,
    messages: history,
    transport: new DefaultChatTransport({ api: api.chatUrl(chatId), headers: api.headers(person.id) }),
    onFinish: onTurnFinished,
  });
  const busy = status === "submitted" || status === "streaming";
  const send = (text: string) => void sendMessage({ text });

  return (
    <div className="chat">
      <header className="chat-head">
        <div>
          <div className="chat-title">Ask the advisor</div>
          <div className="chat-sub">
            as {person.name}, {person.org.name}
          </div>
        </div>
        <button type="button" className="ghost-button" onClick={onNewChat} disabled={busy}>
          New chat
        </button>
      </header>

      <Thread.Root className="thread">
        <Thread.Viewport className="thread-viewport">
          <Thread.Content className="thread-content">
            {messages.length === 0 && (
              <div className="starters">
                <p>The advisor reads the practices, {possessive(person.org.name)} playbooks and docs, and your notes before it answers. Try:</p>
                {(STARTERS[person.id] ?? []).map((s) => (
                  <button key={s} type="button" className="starter" onClick={() => send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            )}
            {messages.map((m) => (
              <MessageView key={m.id} message={m} onOpenFile={onOpenFile} />
            ))}
            {status === "submitted" && <div className="thinking">Reading the knowledge…</div>}
            {error && <div className="chat-error">The answer failed: {error.message}</div>}
          </Thread.Content>
        </Thread.Viewport>

        <Thread.Composer className="thread-composer">
          <Composer.Root
            className="composer"
            isSubmitting={busy}
            onSubmit={(data) => {
              if (data.kind === "message" && data.text.trim()) send(data.text);
            }}
          >
            <Composer.Container className="composer-box">
              <Composer.Textarea className="composer-input" placeholder="Ask about designing your agent…" autoFocus />
              <Composer.Actions className="composer-actions">
                <Composer.Submit className="send-button" isGenerating={busy} onStop={stop}>
                  {busy ? "Stop" : "Send"}
                </Composer.Submit>
              </Composer.Actions>
            </Composer.Container>
          </Composer.Root>
        </Thread.Composer>
      </Thread.Root>
    </div>
  );
}

type Part = UIMessage["parts"][number];
type ToolPart = Extract<Part, { toolCallId: string }>;

/** Consecutive tool calls form one step list; text renders as Markdown. */
function MessageView({ message, onOpenFile }: { message: UIMessage; onOpenFile: (path: string) => void }) {
  const groups: Array<{ kind: "text"; text: string } | { kind: "tools"; parts: ToolPart[] }> = [];
  for (const part of message.parts) {
    if (isTextUIPart(part) && part.text.trim()) groups.push({ kind: "text", text: part.text });
    else if (isToolUIPart(part)) {
      const last = groups.at(-1);
      if (last?.kind === "tools") last.parts.push(part as ToolPart);
      else groups.push({ kind: "tools", parts: [part as ToolPart] });
    }
  }
  if (!groups.length) return null;
  return (
    <div className="message" data-role={message.role}>
      {groups.map((g, i) =>
        g.kind === "text" ? (
          message.role === "user" ? (
            <p key={i} className="bubble">
              {g.text}
            </p>
          ) : (
            <Markdown key={i}>{g.text}</Markdown>
          )
        ) : (
          <Steps.Root key={i} className="steps">
            {g.parts.map((p) => (
              <ToolStep key={p.toolCallId} part={p} onOpenFile={onOpenFile} />
            ))}
          </Steps.Root>
        ),
      )}
    </div>
  );
}

const VERBS: Record<string, [string, string]> = {
  list_files: ["Listing", "Listed"],
  read_file: ["Reading", "Read"],
  glob: ["Finding", "Found"],
  grep: ["Searching for", "Searched for"],
  search_files: ["Searching", "Searched"],
  write_file: ["Writing", "Wrote"],
  edit_file: ["Editing", "Edited"],
};

function ToolStep({ part, onOpenFile }: { part: ToolPart; onOpenFile: (path: string) => void }) {
  const name = getToolOrDynamicToolName(part);
  const input = (part.input ?? {}) as { path?: string; pattern?: string; query?: string };
  const done = part.state === "output-available" || part.state === "output-error";
  const output = part.state === "output-available" ? String(part.output ?? "") : part.state === "output-error" ? (part.errorText ?? "") : "";
  const refused = output.startsWith("Refused");
  const status = !done ? "running" : part.state === "output-error" || refused ? "error" : "done";
  const [verbNow, verbDone] = VERBS[name] ?? [name, name];
  const target = input.path ?? (input.pattern ? `“${input.pattern}”` : input.query ? `“${input.query}”` : "");
  // read_file's first line says how the agent was told to treat the file.
  const trusted = name === "read_file" && done && !refused ? output.split("\n")[0]?.includes("· trusted:") : undefined;

  const openable = done && !refused && !!input.path && name !== "list_files";

  return (
    <Steps.Item status={status} className="step">
      <div className="step-row">
        <Steps.Trigger className="step-trigger">
          <Steps.Icon className="step-icon" />
          <Steps.Label className="step-label">
            {done ? verbDone : verbNow} <span className="step-path">{target}</span>
            {refused && <span className="step-refused">refused</span>}
          </Steps.Label>
        </Steps.Trigger>
        {trusted !== undefined && <TrustMark trusted={trusted} label />}
        {openable && (
          <button type="button" className="step-open" onClick={() => onOpenFile(input.path!)}>
            Open
          </button>
        )}
      </div>
      <Steps.Panel className="step-panel">
        <pre className="step-output">{output || "…"}</pre>
      </Steps.Panel>
    </Steps.Item>
  );
}

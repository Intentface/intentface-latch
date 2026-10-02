import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { getEvalThreadFn } from "@/lib/evals-server";
import { loadHistoryFn } from "@/lib/server";
import type { AppUIMessage } from "@/lib/ai/types";
import { ChatMessageItem } from "@/components/chat/message-item";
import { getNoteFn, resolveSuggestionFn, saveNoteFn } from "@/lib/failures-server";

/**
 * One thread as its user saw it: the same message rendering as Chats —
 * questions, the agent's steps and tool calls in the order they happened,
 * the answer formatted, follow-up turns in place — with what a good answer
 * conveys kept beside it, since that is the reviewer's, not the user's.
 * Shared by the results review and the reading queue.
 */
export function ThreadView({
  agent,
  threadId,
  caption,
  children,
}: {
  agent: string;
  threadId: string;
  caption?: string;
  /** Rendered under the thread, inside the scroll area — a note box, say. */
  children?: React.ReactNode;
}) {
  const [messages, setMessages] = useState<AppUIMessage[] | null | undefined>(undefined);
  const [reference, setReference] = useState<string | null>(null);
  useEffect(() => {
    setMessages(undefined);
    setReference(null);
    let live = true;
    void Promise.all([loadHistoryFn({ data: threadId }), getEvalThreadFn({ data: { agent, threadId } })]).then(([history, detail]) => {
      if (!live) return;
      setMessages(detail === null ? null : (history as AppUIMessage[]));
      setReference(detail?.reference ?? null);
    });
    return () => {
      live = false;
    };
  }, [agent, threadId]);

  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3 text-sm">
      {caption && <div className="text-ink-tertiary text-xs">{caption}</div>}
      {messages === undefined ? (
        <Loader2 className="text-ink-tertiary size-4 animate-spin" />
      ) : messages === null ? (
        <p className="text-ink-tertiary">This thread is no longer available.</p>
      ) : (
        <div className="flex flex-col gap-4">
          {messages.map((m) => (
            <ChatMessageItem key={m.id} message={m} isLast={false} isStreaming={false} skipAnimation readOnly />
          ))}
        </div>
      )}
      {reference && (
        <details className="border-primary-border rounded-lg border px-3 py-2" open>
          <summary className="text-ink-secondary cursor-pointer text-xs font-medium">A good answer conveys</summary>
          <p className="text-ink-secondary mt-1.5 leading-relaxed whitespace-pre-wrap">{reference}</p>
        </details>
      )}
      {children}
    </div>
  );
}

export function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="smooth-shadow-ring-xs smooth-ring-primary-border text-ink-secondary inline-block rounded px-1 font-sans text-[11px] leading-4">
      {children}
    </kbd>
  );
}

/**
 * What went wrong in this thread, in the reader's words — or that nothing
 * did. Saves itself (a pause in typing, or leaving the box), because a note
 * that needs a button is a note that does not get written.
 */
export function NoteBox({
  agent,
  threadId,
  autoFocus,
  onSaved,
  textareaRef,
}: {
  agent: string;
  threadId: string;
  autoFocus?: boolean;
  onSaved?: (n: { text: string; ok: boolean }) => void;
  textareaRef?: React.Ref<HTMLTextAreaElement>;
}) {
  const [text, setText] = useState("");
  const [ok, setOk] = useState(false);
  const [state, setState] = useState<"loading" | "idle" | "dirty" | "saving" | "saved" | "error">("loading");
  const [suggestion, setSuggestion] = useState<{ text: string; ok: boolean; why: string } | null>(null);
  const saved = useRef({ text: "", ok: false });
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  useEffect(() => {
    setState("loading");
    // A late answer for the thread before must not become this thread's note.
    let live = true;
    void getNoteFn({ data: { agent, threadId } }).then((r) => {
      if (!live) return;
      const n = r?.note;
      setSuggestion(r?.suggestion ?? null);
      saved.current = { text: n?.text ?? "", ok: n?.ok ?? false };
      setText(saved.current.text);
      setOk(saved.current.ok);
      setState("idle");
    });
    return () => {
      live = false;
    };
  }, [agent, threadId]);

  const save = useCallback(
    async (next: { text: string; ok: boolean }) => {
      if (next.text.trim() === saved.current.text.trim() && next.ok === saved.current.ok) return;
      setState("saving");
      const r = await saveNoteFn({ data: { agent, threadId, ...next } });
      if (!r.ok) return setState("error");
      saved.current = next;
      setState("saved");
      onSavedRef.current?.(next);
    },
    [agent, threadId],
  );

  // A pause in typing saves.
  useEffect(() => {
    if (state !== "dirty") return;
    const t = setTimeout(() => void save({ text, ok }), 900);
    return () => clearTimeout(t);
  }, [text, ok, state, save]);

  return (
    <section className="border-primary-border space-y-2 border-t pt-4">
      <div className="flex items-baseline gap-2">
        <label htmlFor={`note-${threadId}`} className="text-ink-primary text-xs font-medium">
          What went wrong?
        </label>
        <span className="text-ink-tertiary text-xs" aria-live="polite">
          {state === "saving" ? "Saving…" : state === "saved" ? "Saved" : state === "error" ? "Not saved — try again" : ""}
        </span>
        <label className="text-ink-secondary ml-auto flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={ok}
            disabled={state === "loading"}
            onChange={(e) => {
              const next = { text: e.target.checked ? "" : text, ok: e.target.checked };
              setOk(next.ok);
              setText(next.text);
              void save(next);
            }}
          />
          Looks fine
        </label>
      </div>
      {suggestion && (
        <div className="bg-primary-bg-hover space-y-1.5 rounded-lg px-3 py-2 text-sm">
          <div className="text-ink-secondary text-xs font-medium">The evals agent suggests</div>
          <p className="text-ink-primary">{suggestion.ok ? "Looks fine." : suggestion.text}</p>
          {suggestion.why && <p className="text-ink-tertiary text-xs">{suggestion.why}</p>}
          <div className="flex gap-3 pt-0.5 text-xs">
            <button
              type="button"
              onClick={() =>
                void resolveSuggestionFn({ data: { agent, threadId, accept: true } }).then((r) => {
                  if (!r.ok) return setState("error");
                  const next = { text: suggestion.text, ok: suggestion.ok };
                  saved.current = next;
                  setText(next.text);
                  setOk(next.ok);
                  setSuggestion(null);
                  setState("saved");
                  onSavedRef.current?.(next);
                })
              }
              className="text-ink-primary font-medium underline"
            >
              Use it
            </button>
            <button
              type="button"
              onClick={() => void resolveSuggestionFn({ data: { agent, threadId, accept: false } }).then(() => setSuggestion(null))}
              className="text-ink-secondary hover:text-ink-primary"
            >
              Dismiss
            </button>
            <span className="text-ink-tertiary">Or write your own below; yours replaces it.</span>
          </div>
        </div>
      )}
      <textarea
        id={`note-${threadId}`}
        ref={textareaRef}
        value={text}
        disabled={state === "loading" || ok}
        autoFocus={autoFocus}
        onChange={(e) => {
          setText(e.target.value);
          setState("dirty");
        }}
        onBlur={() => void save({ text, ok })}
        rows={3}
        placeholder={ok ? "Marked as fine." : "The first thing that went wrong, as the user would see it. “Recommended an overlay widget, which regulators reject.”"}
        className="smooth-shadow-ring-xs smooth-ring-primary-border bg-primary-bg text-ink-primary placeholder:text-ink-tertiary focus-visible:smooth-ring-primary-border-hover w-full rounded-lg px-3 py-2 text-sm outline-none disabled:opacity-60"
      />
    </section>
  );
}

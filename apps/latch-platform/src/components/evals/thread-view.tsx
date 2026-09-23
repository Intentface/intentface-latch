import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { getEvalThreadFn } from "@/lib/evals-server";
import { getNoteFn, saveNoteFn } from "@/lib/failures-server";
import { cn } from "@/lib/utils";
import { Markdown } from "@/components/ui/markdown";

/**
 * One thread as a reviewer needs it: what was asked, which tools ran, the
 * answer as its user saw it, and what a good answer conveys. Shared by the
 * results review and the reading queue, so a thread reads the same in both.
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
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof getEvalThreadFn>> | undefined>(undefined);
  useEffect(() => {
    setDetail(undefined);
    void getEvalThreadFn({ data: { agent, threadId } }).then(setDetail);
  }, [agent, threadId]);

  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3 text-sm">
      {caption && <div className="text-ink-tertiary text-xs">{caption}</div>}
      {detail === undefined ? (
        <Loader2 className="text-ink-tertiary size-4 animate-spin" />
      ) : detail === null ? (
        <p className="text-ink-tertiary">This thread is no longer available.</p>
      ) : (
        <>
          <Part label="Asked">{[detail.prompt, ...detail.followUps].join("\n\n")}</Part>
          {detail.tools.length > 0 && (
            <Part label={`Tools (${detail.tools.length} calls)`}>
              <span className="flex flex-wrap gap-1">
                {grouped(detail.tools).map((t) => (
                  <span key={t.tool} className="bg-primary-bg-hover text-ink-secondary rounded px-1.5 py-0.5 font-mono text-[11px]">
                    {t.tool}
                    {t.n > 1 ? ` ×${t.n}` : ""}
                    {t.stubbed ? " · simulated" : ""}
                  </span>
                ))}
              </span>
            </Part>
          )}
          <Part label="Answer" markdown>
            {detail.answer || "(no answer)"}
          </Part>
          {detail.reference && (
            <Part label="A good answer conveys" quiet>
              {detail.reference}
            </Part>
          )}
        </>
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

/** Calls to the same tool, counted, in first-call order. */
function grouped(tools: { tool: string; stubbed: boolean }[]) {
  const out = new Map<string, { tool: string; n: number; stubbed: boolean }>();
  for (const t of tools) {
    const g = out.get(t.tool) ?? out.set(t.tool, { tool: t.tool, n: 0, stubbed: false }).get(t.tool)!;
    g.n += 1;
    g.stubbed ||= t.stubbed;
  }
  return [...out.values()];
}

function Part({ label, quiet, markdown, children }: { label: string; quiet?: boolean; markdown?: boolean; children: React.ReactNode }) {
  return (
    <section>
      <div className="text-ink-secondary mb-1 text-xs font-medium">{label}</div>
      {/* The agent answers in markdown; show it the way its user saw it. */}
      {markdown && typeof children === "string" ? (
        <Markdown className="text-ink-primary text-sm leading-relaxed">{children}</Markdown>
      ) : (
        <div className={cn("leading-relaxed whitespace-pre-wrap", quiet ? "border-primary-border text-ink-secondary border-l-2 pl-3" : "text-ink-primary")}>
          {children}
        </div>
      )}
    </section>
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
  const saved = useRef({ text: "", ok: false });
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  useEffect(() => {
    setState("loading");
    void getNoteFn({ data: { agent, threadId } }).then((n) => {
      saved.current = { text: n?.text ?? "", ok: n?.ok ?? false };
      setText(saved.current.text);
      setOk(saved.current.ok);
      setState("idle");
    });
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

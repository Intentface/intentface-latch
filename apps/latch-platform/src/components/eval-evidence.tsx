import { useEffect, useState } from "react";
import { Check, ChevronDown, ChevronRight, TriangleAlert, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { correctEvalCheckFn, getEvalTranscriptFn } from "@/lib/server";
import type { CheckVerdict, EvalRun } from "@/lib/evals/store";
import type { Question } from "@/lib/evals/ask";
import { ConfigBadge, KindTag, present, pctOf } from "./eval-primitives";

/**
 * The conversation behind a verdict.
 *
 * Without this the correction buttons are close to useless: ruling "the judge
 * was wrong" means reading what the agent actually did, and there was no way
 * to. A verdict was a coloured mark with a tooltip, and a tooltip is not
 * evidence.
 *
 * Three things it must not get wrong, all of them real traps:
 *  - Tool RESULTS, not just tool names. Most checks ask whether an answer came
 *    from a tool result, so hiding the result makes them unjudgeable.
 *  - Truncation stays visible. The server marks cut content; styling the marker
 *    away would let someone rule confidently on evidence the judge never had.
 *  - When the run was SLICED, say so. A full transcript shown beside a verdict
 *    drawn from window 3 of 5 is worse than showing nothing.
 */

type Transcript = Awaited<ReturnType<typeof getEvalTranscriptFn>>;

interface Props {
  run: EvalRun;
  caseId: string;
  checkId: string;
  /** Every question in play for this case, shared merged with its own. */
  questions: Record<string, Question>;
  agent: string;
  onFocusCheck: (checkId: string) => void;
  onCorrected: (run: EvalRun) => void;
  onClose: () => void;
}

export function EvalEvidence({
  run,
  caseId,
  checkId,
  questions,
  agent,
  onFocusCheck,
  onCorrected,
  onClose,
}: Props) {
  const result = run.results.find((r) => r.caseId === caseId);
  const [transcript, setTranscript] = useState<Transcript>(null);
  const [loading, setLoading] = useState(false);

  const threadId = result?.threadId;
  useEffect(() => {
    if (!threadId) return setTranscript(null);
    let live = true;
    setLoading(true);
    void getEvalTranscriptFn({ data: { threadId } })
      .then((t) => live && setTranscript(t))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [threadId]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  if (!result) return null;
  const verdict = result.checks?.find((c) => c.id === checkId);
  const q = questions[checkId];

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} aria-hidden />
      <aside
        role="dialog"
        aria-label="Evidence"
        className="border-secondary-border bg-primary-bg fixed inset-y-0 right-0 z-50 flex w-full max-w-[680px] flex-col border-l shadow-xl"
      >
        <header className="border-secondary-border flex items-start justify-between gap-3 border-b px-4 py-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-ink-tertiary text-[11px] font-semibold uppercase tracking-wider">
                Evidence
              </span>
              <ConfigBadge label={run.configRef ?? "live"} />
            </div>
            <h2 className="text-ink-primary text-sm font-semibold">
              {result.caseName || result.caseId}
            </h2>
            {threadId && (
              <p className="text-ink-tertiary font-mono text-[11px]">thread {threadId}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close evidence"
            className="text-ink-tertiary hover:text-ink-primary"
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto">
          {verdict && (
            <section className="border-secondary-border space-y-3 border-b px-4 py-4">
              <div className="flex items-center justify-between gap-2">
                <span className="text-ink-primary font-mono text-xs">{checkId}</span>
                {q && <KindTag q={q} />}
              </div>
              {q && <p className="text-ink-primary text-[13px] leading-relaxed">{q.ask}</p>}

              <Answer v={verdict} q={q} />

              {(verdict.slices ?? 1) > 1 && (
                <div className="border-uncertain/50 bg-uncertain-muted text-uncertain-ink flex items-start gap-2 rounded-md border px-2.5 py-2 text-[11px] leading-relaxed">
                  <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
                  <span>
                    This conversation was too long to judge whole. It was cut into{" "}
                    {verdict.slices} overlapping windows and each was judged separately
                    {verdict.failedSlices?.length
                      ? ` — window${verdict.failedSlices.length > 1 ? "s" : ""} ${verdict.failedSlices.join(", ")} failed`
                      : ""}
                    . The judge did not see the whole transcript below at once.
                  </span>
                </div>
              )}

              <Ruling
                verdict={verdict}
                agent={agent}
                runId={run.id}
                caseId={caseId}
                onCorrected={onCorrected}
              />
            </section>
          )}

          <section className="border-secondary-border border-b px-4 py-4">
            <div className="mb-2 flex items-baseline justify-between">
              <h3 className="text-ink-tertiary text-[11px] font-semibold uppercase tracking-wider">
                Conversation
              </h3>
              <span className="text-ink-tertiary text-[11px]">what the judge read</span>
            </div>
            {loading && <p className="text-ink-tertiary text-xs">Loading…</p>}
            {!loading && !transcript && (
              <p className="text-ink-tertiary text-xs">
                {threadId
                  ? "This conversation is no longer stored."
                  : "This run predates transcript capture, so there is nothing to show. The next run will have one."}
              </p>
            )}
            {transcript && <Transcript messages={transcript.messages} />}
          </section>

          {result.checks && result.checks.length > 1 && (
            <section className="px-4 py-4">
              <h3 className="text-ink-tertiary mb-2 text-[11px] font-semibold uppercase tracking-wider">
                Other checks on this conversation
              </h3>
              <div className="space-y-1">
                {result.checks
                  .filter((c) => c.id !== checkId)
                  .map((c) => {
                    const p = present(c, c.human?.failed);
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => onFocusCheck(c.id)}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-xs transition-colors",
                          p.base === "fail"
                            ? "border-fail/30 bg-fail-muted hover:border-fail/60"
                            : "border-secondary-border hover:border-ink-tertiary/50",
                        )}
                      >
                        <span className={p.base === "fail" ? "text-fail-ink" : "text-pass-ink"}>
                          {p.base === "fail" ? (
                            <X className="size-3.5" strokeWidth={2.5} />
                          ) : (
                            <Check className="size-3.5" strokeWidth={2.5} />
                          )}
                        </span>
                        <span className="text-ink-primary min-w-0 flex-1 truncate font-mono">
                          {c.id}
                        </span>
                        <span className="text-ink-tertiary tabular-nums">{pctOf(c.confidence)}</span>
                      </button>
                    );
                  })}
              </div>
            </section>
          )}
        </div>
      </aside>
    </>
  );
}

/** The judge's answer, with the choice options it was picking between. */
function Answer({ v, q }: { v: CheckVerdict; q?: Question }) {
  const p = present(v, v.human?.failed);
  return (
    <div
      className={cn(
        "space-y-2 rounded-md border px-3 py-2.5",
        p.tone === "pass" && "border-pass/30 bg-pass-muted",
        p.tone === "fail" && "border-fail/40 bg-fail-muted",
        p.tone === "uncertain" && "border-uncertain hatch-uncertain",
      )}
    >
      <div className="flex items-baseline gap-2">
        <span
          className={cn(
            "font-mono text-sm font-semibold",
            p.base === "fail" ? "text-fail-ink" : "text-pass-ink",
          )}
        >
          {v.answer}
        </span>
        <span className="text-ink-tertiary text-[11px]">
          {p.uncertain ? "the judge was not sure — " : ""}
          {pctOf(v.confidence)} confident in that answer
        </span>
      </div>
      {/* A confidence bar, because 0.51 and 0.99 are not the same evidence and
          a number alone does not make that obvious at a glance. */}
      <div className="bg-secondary-bg h-1 overflow-hidden rounded-full">
        <div
          className={cn("h-full", p.uncertain ? "bg-uncertain" : p.base === "fail" ? "bg-fail" : "bg-pass")}
          style={{ width: `${Math.round(v.confidence * 100)}%` }}
        />
      </div>
      {q?.type === "choice" && (
        <div className="space-y-0.5 pt-0.5">
          {Object.entries(q.options).map(([name, meaning]) => (
            <div
              key={name}
              className={cn(
                "flex gap-2 text-[11px]",
                name === v.answer ? "text-ink-primary" : "text-ink-tertiary",
              )}
            >
              <span className="w-32 shrink-0 font-mono">
                {name === v.answer ? "▸ " : "  "}
                {name}
              </span>
              <span className="min-w-0 flex-1">{meaning}</span>
              {q.bad.includes(name) && <span className="text-fail-ink shrink-0">fails</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The human's call, recorded beside the judge's rather than over it.
 *
 * The PAIR is the evidence: it is the only thing that can answer whether this
 * judge is reliable on this question, which is what decides whether the check
 * may ever gate a release.
 */
function Ruling({
  verdict,
  agent,
  runId,
  caseId,
  onCorrected,
}: {
  verdict: CheckVerdict;
  agent: string;
  runId: string;
  caseId: string;
  onCorrected: (run: EvalRun) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-ink-tertiary">Was the judge right?</span>
      {([false, true] as const).map((failed) => (
        <Button
          key={String(failed)}
          size="sm"
          variant={verdict.human?.failed === failed ? "default" : "secondary"}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const res = await correctEvalCheckFn({
              data: { agent, runId, caseId, checkId: verdict.id, failed },
            });
            setBusy(false);
            if (!res.ok) return toast.error(res.error);
            onCorrected(res.run as EvalRun);
          }}
        >
          should {failed ? "fail" : "pass"}
        </Button>
      ))}
      {verdict.human && (
        <span className="text-ink-tertiary">
          {verdict.human.failed === verdict.failed ? "confirmed" : "corrected"} · judge said{" "}
          {verdict.failed ? "fail" : "pass"}
        </span>
      )}
    </div>
  );
}

type Message = NonNullable<Transcript>["messages"][number];

function Transcript({ messages }: { messages: Message[] }) {
  return (
    <div className="space-y-2">
      {messages.map((m, i) => (
        <div key={i} className="space-y-1.5">
          <div className="text-ink-tertiary text-[10px] font-semibold uppercase tracking-wider">
            {m.role}
          </div>
          {/* Tool calls BEFORE the reply, always. A reader shown the agent's own
              account of what it did first ends up grading the account; what it
              did is evidence, what it said about it is a claim. */}
          {m.toolCalls.map((tc, j) => (
            <ToolCall key={j} call={tc} />
          ))}
          {m.text && (
            <p className="text-ink-primary whitespace-pre-wrap text-xs leading-relaxed">{m.text}</p>
          )}
        </div>
      ))}
    </div>
  );
}

function ToolCall({ call }: { call: Message["toolCalls"][number] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-secondary-border rounded-md border">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs"
      >
        {open ? (
          <ChevronDown className="text-ink-tertiary size-3.5 shrink-0" />
        ) : (
          <ChevronRight className="text-ink-tertiary size-3.5 shrink-0" />
        )}
        <span className="text-ink-primary font-mono">{call.tool}</span>
        {call.blocked && <span className="text-fail-ink">blocked</span>}
        {/* A collapsed result has to say how much is hidden. A judge that read
            2,000 characters and a reader who sees none do not have the same
            evidence, and only one of them is about to overrule the other. */}
        {!open && call.result && (
          <span className="text-ink-tertiary ml-auto shrink-0 tabular-nums">
            {call.result.length.toLocaleString()} chars
          </span>
        )}
      </button>
      {open && (
        <div className="border-secondary-border space-y-2 border-t px-2 py-2">
          {call.args && (
            <div>
              <div className="text-ink-tertiary text-[10px] uppercase tracking-wide">arguments</div>
              <pre className="text-ink-secondary overflow-x-auto whitespace-pre-wrap break-all text-[11px]">
                {call.args}
              </pre>
            </div>
          )}
          <div>
            <div className="text-ink-tertiary text-[10px] uppercase tracking-wide">result</div>
            <pre className="text-ink-secondary max-h-72 overflow-auto whitespace-pre-wrap break-words text-[11px]">
              {call.result || "(no result)"}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

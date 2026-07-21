import { useState } from "react";
import { Check, ChevronDown, FlaskConical, Loader2, X } from "lucide-react";
import { cn, Message } from "@intentface/latch-ui";
import type { AppUIMessage, ToolPart } from "@intentface/latch-ui";
import type { AppMessage } from "@intentface/latch-core";
import type { CompactCaseResult, EvalProgressData } from "@/lib/evals/store";
import { loadHistory } from "@/lib/latch-client";

/** Mirror of run_evals' final output (agent-builder.ts). */
interface EvalRunOutput {
  runId: string;
  agentName: string;
  setName: string;
  passed: number;
  failed: number;
  total: number;
  previous: { runId: string; passed: number; total: number } | null;
  results: CompactCaseResult[];
}

/**
 * A `run_evals` tool call rendered as a live card. While the tool executes it
 * shows the streamed `data-eval-progress` part (cases tick in as each isolated
 * run finishes); once the result lands it shows the final score with the delta
 * vs the previous run. Every case row expands to its full transcript (same
 * lazy `loadHistory` pattern as SubagentThread).
 */
export function EvalRunCard({ part, progress }: { part: ToolPart; progress?: EvalProgressData }) {
  const p = part as {
    state?: string;
    input?: { agentName?: string; setName?: string };
    output?: (Partial<EvalRunOutput> & { error?: string }) | undefined;
    errorText?: string;
    approval?: { approved?: boolean };
  };
  const agent = p.input?.agentName ?? progress?.agentName ?? "agent";
  const setName = p.input?.setName ?? progress?.setName ?? "default";
  // An approved gate with no output yet IS the executing state on the approval
  // continuation (the part only re-emits once the tool produces its result).
  const executing = p.state === "approval-responded" && p.approval?.approved === true;
  const denied = p.state === "approval-responded" && p.approval?.approved === false;
  const running =
    p.state === "input-streaming" || p.state === "input-available" || executing;
  const errorText = p.state === "output-error" ? (p.errorText ?? "Eval run failed") : p.output?.error;
  const out = !errorText && p.state === "output-available" ? (p.output as EvalRunOutput) : undefined;
  // Live view only while the tool is still executing — the final output wins.
  const live = !out && !errorText && running ? progress : undefined;
  const rows = out?.results ?? live?.results ?? [];
  const passedSoFar = live ? live.results.filter((r) => r.pass).length : undefined;

  return (
    <div className="border-primary-border overflow-hidden rounded-lg border">
      <div className="flex items-center gap-2 px-3 py-2 text-sm">
        <FlaskConical className="text-ink-secondary size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          Evals · <span className="font-medium">{agent}</span>
          <span className="text-ink-tertiary"> · {setName}</span>
        </span>
        {running ? (
          <span className="text-ink-tertiary flex items-center gap-1.5 text-xs">
            <Loader2 className="size-3.5 animate-spin" />
            {live ? `${live.completed}/${live.total}` : "Running…"}
          </span>
        ) : out ? (
          <span className="text-xs">
            <span className={cn("font-medium", out.failed === 0 ? "text-(--accent)" : "text-ink-primary")}>
              {out.passed}/{out.total} passed
            </span>
            {out.previous && <Delta now={out.passed} prev={out.previous.passed} />}
          </span>
        ) : denied ? (
          <span className="text-ink-tertiary text-xs">Denied</span>
        ) : null}
      </div>

      {(out ?? live) && (
        <>
          <div className="bg-base mx-3 mb-2 h-1 overflow-hidden rounded-full">
            <div
              className={cn("h-full rounded-full bg-(--accent)", live && "transition-[width] duration-500")}
              style={{
                width: out
                  ? `${out.total ? (out.passed / out.total) * 100 : 0}%`
                  : `${live!.total ? ((passedSoFar ?? 0) / live!.total) * 100 : 0}%`,
              }}
            />
          </div>
          {rows.length > 0 && (
            <div className="border-primary-border divide-primary-border divide-y border-t">
              {rows.map((r) => (
                <CaseRow key={r.caseId} result={r} />
              ))}
            </div>
          )}
        </>
      )}

      {errorText && (
        <p className="text-destructive border-primary-border border-t px-3 py-2 text-xs">{errorText}</p>
      )}
    </div>
  );
}

function Delta({ now, prev }: { now: number; prev: number }) {
  const d = now - prev;
  if (d === 0) return <span className="text-ink-tertiary"> · ±0</span>;
  return (
    <span className={cn("font-medium", d > 0 ? "text-(--accent)" : "text-destructive")}>
      {" "}
      · {d > 0 ? "+" : ""}
      {d}
    </span>
  );
}

/** One case: pass/fail row, expandable to failure reasons + full transcript. */
function CaseRow({ result }: { result: CompactCaseResult }) {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<AppMessage[] | null>(null);
  const [loading, setLoading] = useState(false);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !msgs && result.threadId) {
      setLoading(true);
      const h = await loadHistory(result.threadId).catch(() => [] as AppMessage[]);
      setMsgs(h);
      setLoading(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        className="hover:bg-primary-hover flex w-full items-start gap-2 px-3 py-1.5 text-left transition-colors"
      >
        <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
          {result.pass ? (
            <Check className="size-3.5 text-(--accent)" />
          ) : (
            <X className="text-destructive size-3.5" />
          )}
        </span>
        <span className="min-w-0 flex-1 text-xs">
          <span className="text-ink-primary">{result.caseName}</span>
          {!result.pass && result.reasons.length > 0 && (
            <span className="text-ink-tertiary"> · {result.reasons.join("; ")}</span>
          )}
          {result.error && <span className="text-destructive"> · {result.error}</span>}
        </span>
        <ChevronDown
          className={cn("text-ink-tertiary mt-0.5 size-4 shrink-0 transition-transform", open && "rotate-180")}
        />
      </button>
      {open && (
        <div className="border-primary-border bg-base/40 space-y-3 border-t p-3">
          {result.toolCalls.length > 0 && (
            <p className="text-ink-tertiary text-xs">Tools: {result.toolCalls.join(", ")}</p>
          )}
          {loading ? (
            <p className="text-ink-tertiary text-xs">Loading transcript…</p>
          ) : msgs && msgs.length > 0 ? (
            msgs.map((m) => <Message key={m.id} message={m as unknown as AppUIMessage} />)
          ) : (
            <p className="text-ink-tertiary text-xs">
              {result.threadId ? "No messages." : "No transcript for this case."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

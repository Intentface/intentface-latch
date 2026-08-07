import { useCallback, useEffect, useRef, useState } from "react";
import { Pencil } from "lucide-react";
import { cn, Dialog } from "@intentface/latch-ui";
import { correctScoreFn, getRunScoresFn } from "@/lib/server";
import type { AttachedEvalScore } from "@/lib/server";
import { Button } from "@/components/ui/button";

const POLL_MS = 3_000;

/**
 * Poll the LOCAL run-scores store for the given run ids (the fast mirror the
 * judge dual-writes to). Returns scores by runId plus a manual `merge` the
 * drawer's re-evaluate uses to splice in fresh verdicts immediately.
 *
 * `enabled` gates polling to owners who opened the evals panel — normal chat
 * pays nothing. Polling pauses when the tab is hidden.
 */
export function useEvalScores(runIds: string[], enabled: boolean) {
  const [scores, setScores] = useState<Record<string, AttachedEvalScore[]>>({});
  // Stable key so the effect doesn't re-subscribe on every render.
  const key = runIds.join(",");

  const merge = useCallback((runId: string, next: AttachedEvalScore[]) => {
    setScores((prev) => ({ ...prev, [runId]: next }));
  }, []);

  const idsRef = useRef<string[]>([]);
  idsRef.current = runIds;

  useEffect(() => {
    if (!enabled || runIds.length === 0) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval>;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const res = await getRunScoresFn({ data: idsRef.current });
        if (!cancelled) setScores((prev) => ({ ...prev, ...res }));
      } catch {
        /* transient — next tick retries */
      }
    };
    void tick();
    timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);

  return { scores, merge };
}

/** The per-message row of score badges (below an assistant message). */
export function ScoreBadges({
  runId,
  scores,
  pending,
  canCorrect,
  onCorrected,
}: {
  runId?: string;
  scores?: AttachedEvalScore[];
  /** True while the live judge is expected but its verdicts haven't landed. */
  pending?: boolean;
  /** Owner: badges become clickable to correct the verdict. */
  canCorrect?: boolean;
  onCorrected?: (runId: string, score: AttachedEvalScore) => void;
}) {
  const [correcting, setCorrecting] = useState<AttachedEvalScore | null>(null);
  if (!scores?.length) {
    return pending ? (
      <div className="text-ink-tertiary mt-1 text-xs">judging…</div>
    ) : null;
  }
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {scores.map((s) => {
        const pass = s.value >= 0.5;
        const label = s.scale === "binary" ? (pass ? "✓" : "✗") : s.value.toFixed(2);
        const tip =
          s.source === "human"
            ? `${s.comment ?? ""}${
                s.aiValue != null
                  ? `\n(judge said ${s.scale === "binary" ? (s.aiValue >= 0.5 ? "✓" : "✗") : s.aiValue.toFixed(2)}${s.aiComment ? `: ${s.aiComment}` : ""})`
                  : ""
              }`
            : s.comment;
        const className = cn(
          "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs",
          pass ? "border-secondary-border text-ink-secondary" : "border-red-500/40 text-red-500",
          s.source === "rejudge" && "border-dashed",
          canCorrect && "cursor-pointer hover:bg-primary-hover",
        );
        const content = (
          <>
            {s.name} {label}
            {s.source === "human" && <Pencil className="size-3" />}
          </>
        );
        return canCorrect ? (
          <button key={s.name} type="button" title={tip} className={className} onClick={() => setCorrecting(s)}>
            {content}
          </button>
        ) : (
          <span key={s.name} title={tip} className={className}>
            {content}
          </span>
        );
      })}
      {correcting && runId && (
        <CorrectionDialog
          runId={runId}
          score={correcting}
          onClose={() => setCorrecting(null)}
          onSaved={(updated) => {
            onCorrected?.(runId, updated);
            setCorrecting(null);
          }}
        />
      )}
    </div>
  );
}

/** Correct one judge verdict: set the authoritative value + a required note. */
function CorrectionDialog({
  runId,
  score,
  onClose,
  onSaved,
}: {
  runId: string;
  score: AttachedEvalScore;
  onClose: () => void;
  onSaved: (score: AttachedEvalScore) => void;
}) {
  const binary = score.scale === "binary";
  const [value, setValue] = useState<number>(score.value);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!note.trim() || busy) return;
    setBusy(true);
    setError(null);
    const res = await correctScoreFn({ data: { runId, rubricName: score.name, value, comment: note.trim() } });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onSaved(res.score);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Content className="flex flex-col gap-3">
        <Dialog.Title>Correct “{score.name}”</Dialog.Title>
        <p className="text-ink-secondary text-xs">
          Judge scored{" "}
          <span className="text-ink-primary font-medium">
            {binary ? (score.value >= 0.5 ? "pass" : "fail") : score.value.toFixed(2)}
          </span>
          {score.comment ? ` — “${score.comment}”` : ""}. Set the correct value and say why.
        </p>

        {binary ? (
          <div className="flex gap-2">
            {[1, 0].map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={value === v}
                onClick={() => setValue(v)}
                className={cn(
                  "border-secondary-border flex-1 rounded-lg border px-3 py-1.5 text-sm",
                  value === v ? "bg-accent border-transparent text-white" : "text-ink-secondary hover:bg-secondary-hover",
                )}
              >
                {v === 1 ? "Pass ✓" : "Fail ✗"}
              </button>
            ))}
          </div>
        ) : (
          <label className="text-ink-secondary flex items-center gap-2 text-xs">
            Score (0–1)
            <input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={value}
              onChange={(e) => {
                // Clearing the field yields Number("") === NaN; ignore it and
                // keep the last valid value so we never persist NaN (→ null).
                const n = Number(e.target.value);
                if (Number.isFinite(n)) setValue(Math.max(0, Math.min(1, n)));
              }}
              className="border-secondary-border text-ink-primary w-24 rounded border bg-transparent px-2 py-1 text-sm"
            />
          </label>
        )}

        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Why is the judge wrong here? (required)"
          rows={3}
          className="border-secondary-border text-ink-primary w-full resize-none rounded-lg border bg-transparent p-2 text-sm"
        />
        {error && <p className="text-xs text-red-500">{error}</p>}
        <div className="flex justify-end gap-2">
          <Dialog.Close className="text-ink-secondary hover:text-ink-primary cursor-pointer rounded-lg px-3 text-sm" disabled={busy}>
            Cancel
          </Dialog.Close>
          <Button size="sm" onClick={save} disabled={!note.trim() || busy || !Number.isFinite(value)}>
            {busy ? "Saving…" : "Save correction"}
          </Button>
        </div>
      </Dialog.Content>
    </Dialog>
  );
}

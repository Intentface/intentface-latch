import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@intentface/latch-ui";
import { getRunScoresFn } from "@/lib/server";
import type { AttachedEvalScore } from "@/lib/server";

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
  scores,
  pending,
}: {
  scores?: AttachedEvalScore[];
  /** True while the live judge is expected but its verdicts haven't landed. */
  pending?: boolean;
}) {
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
        return (
          <span
            key={s.name}
            title={s.comment}
            className={cn(
              "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs",
              pass
                ? "border-secondary-border text-ink-secondary"
                : "border-red-500/40 text-red-500",
              s.source === "rejudge" && "border-dashed",
            )}
          >
            {s.name} {label}
          </span>
        );
      })}
    </div>
  );
}

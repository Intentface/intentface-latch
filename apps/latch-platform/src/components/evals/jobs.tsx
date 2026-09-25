import { useCallback, useEffect, useRef, useState } from "react"
import { Loader2 } from "lucide-react"
import { cancelJobFn, listJobsFn } from "@/lib/evals-server"
import type { JobRow } from "@/lib/evals-server"
import { cn } from "@/lib/utils"

/**
 * Runs in progress for a question set: polled while any is going, with a
 * banner that shows progress and can stop one. Shared by the Evals pages.
 */

export const isActive = (j: JobRow) => j.status === "running" || j.status === "judging"

/** Recent jobs for this set, polled while any is running; `onFinished` fires once per job that completes. */
export function useJobs(
  agent: string | undefined,
  datasetId: string | undefined,
  onFinished: (j: JobRow) => void
) {
  const [rows, setRows] = useState<JobRow[]>([])
  const seen = useRef(new Map<string, JobRow["status"]>())
  const finished = useRef(onFinished)
  finished.current = onFinished
  const [tick, setTick] = useState(0)
  const refresh = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    if (!agent || !datasetId) return setRows([])
    let stop = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      const next = await listJobsFn({ data: { agent, datasetId } })
      if (stop) return
      for (const j of next) {
        const was = seen.current.get(j.id)
        if (was && was !== "done" && j.status === "done") finished.current(j)
        seen.current.set(j.id, j.status)
      }
      setRows(next)
      if (next.some(isActive)) timer = setTimeout(() => void load(), 2500)
    }
    void load()
    return () => {
      stop = true
      clearTimeout(timer)
    }
  }, [agent, datasetId, tick])

  return { rows, refresh }
}

/** What is running now, and what went wrong recently. Finished runs speak through the Run picker. */
export function JobBanner({
  agent,
  jobs,
  onChanged,
}: {
  agent: string
  jobs: JobRow[]
  onChanged: () => void
}) {
  const recent = Date.now() - 30 * 60_000
  const shown = jobs.filter(
    (j) => isActive(j) || (j.status === "failed" && j.updatedAt > recent)
  )
  if (!shown.length) return null
  return (
    <div className="space-y-2">
      {shown.map((j) => {
        const pctDone = j.total ? Math.round((100 * j.done) / j.total) : 0
        const what =
          j.kind === "judge"
            ? `Judging ${j.total} threads`
            : `${j.versions.join(" vs ")} · ${j.questions} question${j.questions === 1 ? "" : "s"}${j.repeats > 1 ? ` × ${j.repeats} tries` : ""}`
        return (
          <div
            key={j.id}
            className="rounded-lg bg-primary-bg px-4 py-3 text-sm smooth-shadow-ring-xs smooth-ring-primary-border"
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {isActive(j) && (
                <Loader2 className="size-4 animate-spin text-ink-secondary" />
              )}
              <span className="font-medium text-ink-primary">
                {j.status === "failed"
                  ? "Run failed"
                  : j.status === "judging"
                    ? "Judging"
                    : j.kind === "judge"
                      ? "Judging"
                      : "Running"}
              </span>
              <span className="text-ink-secondary">{what}</span>
              <span className="text-ink-tertiary tabular-nums">
                {j.status === "judging"
                  ? `${j.total} threads run`
                  : `${j.done} of ${j.total}`}
                {j.failed > 0 && ` · ${j.failed} failed to run`}
                {j.cost !== null && ` · about $${j.cost.toFixed(2)}`}
              </span>
              {isActive(j) && (
                <button
                  type="button"
                  onClick={() =>
                    void cancelJobFn({ data: { agent, id: j.id } }).then(
                      onChanged
                    )
                  }
                  className="ml-auto text-ink-secondary hover:text-ink-primary"
                >
                  Stop
                </button>
              )}
            </div>
            {isActive(j) && (
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-primary-border">
                <div
                  className={cn(
                    "h-full rounded-full bg-ink-secondary transition-[width] duration-500",
                    j.status === "judging" && "animate-pulse"
                  )}
                  style={{
                    width: `${j.status === "judging" ? 100 : pctDone}%`,
                  }}
                />
              </div>
            )}
            {j.error && (
              <p className="mt-1 text-red-600 dark:text-red-400">{j.error}</p>
            )}
          </div>
        )
      })}
    </div>
  )
}


import { useEffect, useState } from "react"
import { ChevronLeft, Loader2, Plus } from "lucide-react"
import { estimateAgainFn, estimateRunFn, getRunOptionsFn, startAgainFn, startRunFn } from "@/lib/evals-server"
import type { Estimate } from "@/lib/evals/v2/jobs"
import { Popover } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

/**
 * Running from the results table: adding a column (a configuration answers
 * every input) and answering again (one more try for some inputs, into the
 * column the answers already live in). Both are priced before they start; above
 * the limit they ask once more, in place.
 */

export type Ref = { runId: string; version: string }
type Shown = { runId: string; version: string; run: { name: string | null; createdAt: number; questions: number; tries: number } }

const money = (x: number) => (x < 1 ? `${Math.max(1, Math.round(x * 100))}¢` : `$${x.toFixed(2)}`)
const day = (at: number) => new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" })
const item = "hover:bg-primary-bg-hover flex w-full flex-col items-start rounded-md px-2.5 py-1.5 text-left text-sm"
const hint = "text-ink-tertiary text-xs"

function Tries({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-ink-secondary">Tries per input</span>
      <div role="radiogroup" className="smooth-shadow-ring-xs smooth-ring-primary-border inline-flex rounded-lg p-0.5">
        {[1, 3].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={value === n}
            onClick={() => onChange(n)}
            className={cn("min-w-8 rounded-md px-2 py-0.5 tabular-nums", value === n ? "bg-primary-bg-active text-ink-primary font-medium" : "text-ink-secondary")}
          >
            {n}
          </button>
        ))}
      </div>
      <span className="text-ink-tertiary">{value > 1 ? "Tells small changes from noise" : "Enough for big changes"}</span>
    </div>
  )
}

/** The price, and above the limit a box to tick before the button works. */
function Bill({
  estimate,
  limit,
  sure,
  setSure,
}: {
  estimate: Estimate | null
  limit: number
  sure: boolean
  setSure: (b: boolean) => void
}) {
  if (!estimate)
    return (
      <p className="text-ink-tertiary flex items-center gap-2 text-xs">
        <Loader2 className="size-3.5 animate-spin" /> Working out the cost…
      </p>
    )
  const cost = estimate.cost
  return (
    <div className="space-y-1.5 text-xs">
      <p className="text-ink-secondary tabular-nums">
        {estimate.agentRuns} answer{estimate.agentRuns === 1 ? "" : "s"} · {cost === null ? "cost unknown" : `about ${money(cost)}`}
      </p>
      <p className="text-ink-tertiary">{estimate.basis}</p>
      {cost !== null && cost > limit && (
        <label className="text-ink-primary flex items-start gap-2 pt-1">
          <input type="checkbox" className="mt-0.5" checked={sure} onChange={(e) => setSure(e.target.checked)} />
          <span>More than ${limit}. I understand this will spend about {money(cost)}.</span>
        </label>
      )}
    </div>
  )
}

/**
 * The last header cell. Answers you already have come first — free — then
 * a configuration to run: pick it, see the price, start.
 */
export function AddColumn({
  agent,
  datasetId,
  rubricId,
  shown,
  hidden,
  onShow,
  onStarted,
}: {
  agent: string
  datasetId: string
  rubricId: string
  /** What is open now; the new column is compared with it. */
  shown: Ref[]
  hidden: Shown[]
  onShow: (r: Ref) => void
  onStarted: (r: Ref[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [options, setOptions] = useState<Awaited<ReturnType<typeof getRunOptionsFn>>>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const [tries, setTries] = useState(1)
  const [priced, setPriced] = useState<{ estimate: Estimate; reusable: { version: string; runId: string; as: string; at: number }[]; limit: number } | null>(null)
  const [sure, setSure] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setPicked(null)
    setError(null)
    void getRunOptionsFn({ data: { agent, datasetId } }).then(setOptions)
  }, [open, agent, datasetId])

  const inputIds = options?.questions.map((q) => q.id) ?? []
  useEffect(() => {
    setPriced(null)
    setSure(false)
    if (!picked || !inputIds.length) return
    let live = true
    void estimateRunFn({ data: { agent, datasetId, rubricId, versions: [picked], inputIds, repeats: tries } }).then((r) => {
      if (!live) return
      if (r.ok) setPriced({ estimate: r.estimate, reusable: r.reusable, limit: r.confirmTwiceAbove })
      else setError(r.error)
    })
    return () => {
      live = false
    }
    // inputIds follows options; listing it would re-price on every render.
  }, [picked, tries, options, agent, datasetId, rubricId])

  const start = async () => {
    if (!picked || !priced) return
    setBusy(true)
    const r = await startRunFn({
      data: { agent, datasetId, rubricId, versions: [picked], inputIds, repeats: tries, confirmedCost: priced.estimate.cost, compareWith: shown },
    })
    setBusy(false)
    if (!r.ok) return setError(r.error)
    setOpen(false)
    onStarted([{ runId: r.id, version: picked }])
  }
  const cost = priced?.estimate.cost ?? null
  const reuse = priced?.reusable.find((x) => x.version === picked)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          <button
            type="button"
            className="border-primary-border text-ink-secondary hover:text-ink-primary hover:bg-primary-bg-hover flex h-7 items-center gap-1 rounded-full border border-dashed px-3 text-xs whitespace-nowrap"
          />
        }
      >
        <Plus className="size-3.5" /> Run
      </Popover.Trigger>
      <Popover.Content align="start" className="w-[22rem] p-1.5">
        {!picked ? (
          <>
            <div className="text-ink-tertiary px-2.5 pt-1 pb-1 text-xs">Run on all {inputIds.length || "the"} inputs</div>
            {!options ? (
              <Loader2 className="text-ink-tertiary m-2.5 size-4 animate-spin" />
            ) : (
              options.versions.map((v) => (
                <button key={v.label} type="button" className={item} onClick={() => setPicked(v.label)}>
                  {v.label}
                  {v.note && <span className={hint}>{v.note}</span>}
                </button>
              ))
            )}
            {hidden.length > 0 && (
              <>
                <div className="text-ink-tertiary px-2.5 pt-2.5 pb-1 text-xs">Or show answers you already have · free</div>
                <ul className="max-h-60 overflow-y-auto">
                  {hidden.map((h) => (
                    <li key={`${h.runId}|${h.version}`}>
                      <button type="button" className={item} onClick={() => (setOpen(false), onShow({ runId: h.runId, version: h.version }))}>
                        {h.version}
                        <span className={cn(hint, "tabular-nums")}>
                          {h.run.name ? `${h.run.name} · ` : ""}
                          {day(h.run.createdAt)} · {h.run.questions} inputs{h.run.tries > 1 ? ` × ${h.run.tries} tries` : ""}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        ) : (
          <div className="space-y-3 p-2">
            <button type="button" onClick={() => setPicked(null)} className="text-ink-tertiary hover:text-ink-primary flex items-center gap-1 text-xs">
              <ChevronLeft className="size-3.5" /> Configurations
            </button>
            <div className="text-ink-primary text-sm font-medium">
              Run {picked} on {inputIds.length} inputs
            </div>
            <Tries value={tries} onChange={setTries} />
            {reuse && (
              <div className="bg-primary-bg-hover rounded-md px-2.5 py-2 text-xs">
                <span className="text-ink-secondary">
                  {picked} hasn't changed since {day(reuse.at)}, when it answered all of these.{" "}
                </span>
                <button type="button" className="text-ink-primary underline underline-offset-2" onClick={() => (setOpen(false), onShow({ runId: reuse.runId, version: reuse.as }))}>
                  Show those instead · free
                </button>
              </div>
            )}
            <Bill estimate={priced?.estimate ?? null} limit={priced ? priced.limit : 5} sure={sure} setSure={setSure} />
            {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
            <button
              type="button"
              disabled={!priced || busy || (cost !== null && cost > priced.limit && !sure)}
              onClick={() => void start()}
              className="bg-ink-primary text-primary-bg h-8 w-full rounded-md text-sm font-medium tabular-nums disabled:opacity-40"
            >
              {busy ? "Starting…" : `Run ${picked}${cost !== null ? ` · about ${money(cost)}` : ""}`}
            </button>
          </div>
        )}
      </Popover.Content>
    </Popover>
  )
}

/**
 * Answer some inputs again, on some columns: one more try each, added beside
 * the old answers. Used by a row's ↻, the selection bar and an answer.
 */
export function AgainPanel({
  agent,
  datasetId,
  rubricId,
  inputIds,
  columns,
  preset,
  onStarted,
}: {
  agent: string
  datasetId: string
  rubricId: string
  inputIds: string[]
  columns: (Ref & { label: string })[]
  /** Columns ticked to begin with; all when absent. */
  preset?: string[]
  onStarted: () => void
}) {
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(preset ?? columns.map((c) => c.label)))
  const [priced, setPriced] = useState<{ estimate: Estimate; skipped: { version: string; error?: string }[]; limit: number } | null>(null)
  const [sure, setSure] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const targets = columns.filter((c) => chosen.has(c.label)).map((c) => ({ runId: c.runId, version: c.version, inputIds }))
  const key = JSON.stringify(targets)

  useEffect(() => {
    setPriced(null)
    setSure(false)
    setError(null)
    if (!targets.length) return
    let live = true
    void estimateAgainFn({ data: { agent, datasetId, rubricId, targets } }).then((r) => {
      if (!live) return
      if (r.ok) setPriced({ estimate: r.estimate, skipped: r.skipped, limit: r.confirmTwiceAbove })
      else setError(r.error)
    })
    return () => {
      live = false
    }
    // targets is keyed by `key`; the array itself is new every render.
  }, [key, agent, datasetId, rubricId])

  const start = async () => {
    if (!priced) return
    setBusy(true)
    const r = await startAgainFn({ data: { agent, datasetId, rubricId, targets, confirmedCost: priced.estimate.cost } })
    setBusy(false)
    if (!r.ok) return setError(r.error)
    onStarted()
  }
  const cost = priced?.estimate.cost ?? null
  const blocked = !priced || busy || !targets.length || (cost !== null && cost > priced.limit && !sure) || priced.estimate.agentRuns === 0

  return (
    <div className="space-y-3 p-2">
      <div className="text-ink-primary text-sm font-medium">
        Answer {inputIds.length === 1 ? `input ${inputIds[0]}` : `${inputIds.length} inputs`} again
      </div>
      <p className={hint}>One more try each, beside the old answers. The score then counts every try.</p>
      <div className="space-y-1">
        {columns.map((c) => (
          <label key={c.label} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={chosen.has(c.label)}
              onChange={(e) => {
                const next = new Set(chosen)
                if (e.target.checked) next.add(c.label)
                else next.delete(c.label)
                setChosen(next)
              }}
            />
            {c.label}
          </label>
        ))}
      </div>
      {priced?.skipped.map((s) => (
        <p key={s.version} className="text-xs text-amber-700 dark:text-amber-400">
          {s.error}
        </p>
      ))}
      {targets.length > 0 && <Bill estimate={priced?.estimate ?? null} limit={priced?.limit ?? 5} sure={sure} setSure={setSure} />}
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      <button type="button" disabled={blocked} onClick={() => void start()} className="bg-ink-primary text-primary-bg h-8 w-full rounded-md text-sm font-medium tabular-nums disabled:opacity-40">
        {busy ? "Starting…" : `Answer again${cost !== null ? ` · about ${money(cost)}` : ""}`}
      </button>
    </div>
  )
}

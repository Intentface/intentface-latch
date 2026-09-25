import { useEffect, useState } from "react"
import { ChevronLeft, Columns2, Loader2, Plus } from "lucide-react"
import { createVariantFn, estimateAgainFn, getRunOptionsFn, priceRunsFn, startAgainFn, startRunFn } from "@/lib/evals-server"
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
const hint = "text-ink-tertiary text-xs"

function Tries({ value, onChange, compact }: { value: number; onChange: (n: number) => void; compact?: boolean }) {
  return (
    <div className="flex items-center gap-2 text-xs" title={value > 1 ? "Tells small changes from noise" : "Enough for big changes"}>
      <span className="text-ink-secondary">{compact ? "Tries" : "Tries per input"}</span>
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
      {!compact && <span className="text-ink-tertiary">{value > 1 ? "Tells small changes from noise" : "Enough for big changes"}</span>}
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
 * The last header cell: + Run. Every configuration with its price on the
 * right; a click runs it. One that already answered these inputs, unchanged,
 * is shown instead — free — with "run again" beside it. Above the limit the
 * row asks once more, in place.
 */
export function AddColumn({
  agent,
  datasetId,
  rubricId,
  shown,
  onShow,
  onStarted,
  first,
}: {
  agent: string
  datasetId: string
  rubricId: string
  /** What is open now; the new column is compared with it. */
  shown: Ref[]
  onShow: (r: Ref) => void
  onStarted: (r: Ref[]) => void
  /** The big button a set with no answers yet offers, instead of the header's "+ Run". */
  first?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [options, setOptions] = useState<Awaited<ReturnType<typeof getRunOptionsFn>>>(null)
  const [tries, setTries] = useState(1)
  const [prices, setPrices] = useState<NonNullable<Awaited<ReturnType<typeof priceRunsFn>>> | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [variantOpen, setVariantOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setVariantOpen(false)
    setConfirm(null)
    setError(null)
    void getRunOptionsFn({ data: { agent, datasetId } }).then(setOptions)
  }, [open, agent, datasetId])

  const labels = [...(options?.versions.map((v) => v.label) ?? []), ...(options?.variants.map((v) => `~${v.id}`) ?? [])]
  const labelKey = labels.join(",")
  useEffect(() => {
    setPrices(null)
    if (!open || !labels.length) return
    let live = true
    void priceRunsFn({ data: { agent, datasetId, rubricId, labels, repeats: tries } }).then((r) => live && setPrices(r))
    return () => {
      live = false
    }
    // labels is keyed by labelKey; the array is new every render.
  }, [open, labelKey, tries, agent, datasetId, rubricId])

  const nameOf = (label: string) => (label.startsWith("~") ? (options?.variants.find((v) => `~${v.id}` === label)?.name ?? label) : label)
  const run = async (label: string, force = false) => {
    const pr = prices?.prices.find((x) => x.label === label)
    if (!prices || !pr?.ok) return
    if (!force && pr.cost !== null && pr.cost > prices.limit) return setConfirm(label)
    setBusy(label)
    const r = await startRunFn({
      data: { agent, datasetId, rubricId, versions: [label], inputIds: prices.inputIds, repeats: tries, confirmedCost: pr.cost, compareWith: shown },
    })
    setBusy(null)
    if (!r.ok) return setError(r.error)
    setOpen(false)
    onStarted([{ runId: r.id, version: nameOf(label) }])
  }
  const row = (label: string, note: string | undefined) => {
    const pr = prices?.prices.find((x) => x.label === label)
    const reuse = pr?.ok ? pr.reuse : null
    const price = pr?.ok ? (pr.cost === null ? "cost unknown" : `about ${money(pr.cost)}`) : null
    return (
      <li key={label} className="rounded-md">
        <div className="hover:bg-primary-bg-hover flex items-center gap-3 rounded-md px-2.5 py-1.5">
          <button
            type="button"
            disabled={!pr?.ok || busy !== null}
            onClick={() => (reuse ? (setOpen(false), onShow({ runId: reuse.runId, version: reuse.as })) : void run(label))}
            title={note}
            className="flex min-w-0 flex-1 flex-col items-start text-left text-sm disabled:opacity-60"
          >
            <span className="text-ink-primary max-w-full truncate">{nameOf(label)}</span>
            {note && <span className="text-ink-tertiary max-w-full truncate text-xs">{note}</span>}
            {pr && !pr.ok && <span className="text-xs text-red-600 dark:text-red-400">{pr.error}</span>}
          </button>
          <span className="flex shrink-0 flex-col items-end text-xs tabular-nums">
            {busy === label ? (
              <Loader2 className="text-ink-tertiary size-3.5 animate-spin" />
            ) : !pr ? (
              <Loader2 className="text-ink-tertiary size-3 animate-spin" />
            ) : reuse ? (
              <>
                <span className="text-ink-secondary">answered {day(reuse.at)} · free</span>
                <button type="button" onClick={() => void run(label)} className="text-ink-tertiary hover:text-ink-primary underline underline-offset-2">
                  run again{price ? ` · ${price.replace("about ", "")}` : ""}
                </button>
              </>
            ) : (
              <span className="text-ink-secondary">{price}</span>
            )}
          </span>
        </div>
        {confirm === label && pr?.ok && pr.cost !== null && (
          <div className="bg-primary-bg-hover mx-1 mb-1 flex items-center gap-2 rounded-md px-2.5 py-2 text-xs">
            <span className="text-ink-primary flex-1">
              About {money(pr.cost)} — over ${prices?.limit}.
            </span>
            <button type="button" onClick={() => setConfirm(null)} className="text-ink-secondary hover:text-ink-primary">
              Cancel
            </button>
            <button type="button" onClick={() => void run(label, true)} className="bg-ink-primary text-primary-bg h-6 rounded px-2.5 font-medium">
              Run anyway
            </button>
          </div>
        )}
      </li>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          first ? (
            <button type="button" className="bg-ink-primary text-primary-bg h-9 rounded-lg px-4 text-sm font-medium" />
          ) : (
            <button
              type="button"
              className="border-primary-border text-ink-secondary hover:text-ink-primary hover:bg-primary-bg-hover flex h-7 items-center gap-1 rounded-full border border-dashed px-3 text-xs whitespace-nowrap"
            />
          )
        }
      >
        {first ? "Run a configuration" : <><Plus className="size-3.5" /> Run</>}
      </Popover.Trigger>
      <Popover.Content align="start" className="w-[24rem] p-1.5">
        {variantOpen && options ? (
          <VariantForm
            agent={agent}
            versions={options.versions.map((v) => v.label)}
            models={options.models}
            current={{ model: options.model, effort: options.effort }}
            onBack={() => setVariantOpen(false)}
            onMade={() => (setVariantOpen(false), void getRunOptionsFn({ data: { agent, datasetId } }).then(setOptions))}
          />
        ) : (
          <>
            <div className="flex items-center gap-2 px-2.5 pt-1 pb-1.5">
              <span className="text-ink-primary flex-1 text-xs font-medium">Run on all {prices?.inputIds.length ?? ""} inputs</span>
              <Tries value={tries} onChange={setTries} compact />
            </div>
            {!options ? (
              <Loader2 className="text-ink-tertiary m-2.5 size-4 animate-spin" />
            ) : (
              <ul>
                {options.versions.map((v) => row(v.label, v.note))}
                {options.variants.length > 0 && <li className="text-ink-tertiary px-2.5 pt-2 pb-0.5 text-[11px]">Variants</li>}
                {options.variants.map((v) => row(`~${v.id}`, v.note))}
                <li>
                  <button type="button" onClick={() => setVariantOpen(true)} className="hover:bg-primary-bg-hover flex w-full flex-col items-start rounded-md px-2.5 py-1.5 text-left text-sm">
                    <span className="text-ink-primary">+ New variant</span>
                    <span className="text-ink-tertiary text-xs">A version with one thing changed — model, reasoning effort, an instruction</span>
                  </button>
                </li>
              </ul>
            )}
            {error && <p className="px-2.5 pb-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
            {prices?.prices[0]?.ok && <p className="text-ink-tertiary px-2.5 pt-1 pb-1 text-[11px]">{prices.prices[0].basis}</p>}
          </>
        )}
      </Popover.Content>
    </Popover>
  )
}

/** Answers already on hand — a result from an earlier run — added as a column. Free: nothing runs. */
export function EarlierAnswers({ hidden, onShow }: { hidden: Shown[]; onShow: (r: Ref) => void }) {
  const [open, setOpen] = useState(false)
  if (!hidden.length) return null
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={<button type="button" className="text-ink-tertiary hover:text-ink-primary flex h-7 items-center gap-1 px-1.5 text-xs whitespace-nowrap" />}
      >
        <Columns2 className="size-3.5" /> Earlier answers
      </Popover.Trigger>
      <Popover.Content align="start" className="w-80 p-1.5">
        <div className="text-ink-tertiary px-2.5 pt-1 pb-1 text-xs">Add as a column — free, nothing runs</div>
        <ul className="max-h-72 overflow-y-auto">
          {hidden.map((h) => (
            <li key={`${h.runId}|${h.version}`}>
              <button
                type="button"
                onClick={() => (setOpen(false), onShow({ runId: h.runId, version: h.version }))}
                className="hover:bg-primary-bg-hover flex w-full min-w-0 flex-col items-start rounded-md px-2.5 py-1.5 text-left text-sm"
              >
                <span className="text-ink-primary max-w-full truncate">
                  {h.version} · {day(h.run.createdAt)}
                </span>
                <span className="text-ink-tertiary max-w-full truncate text-xs tabular-nums">
                  {h.run.name ? `${h.run.name} · ` : ""}
                  {h.run.questions} input{h.run.questions === 1 ? "" : "s"}
                  {h.run.tries > 1 ? ` × ${h.run.tries} tries` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
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

/** A variant: pick the version it starts from, and the one thing that differs. */
function VariantForm({
  agent,
  versions,
  models,
  current,
  onBack,
  onMade,
}: {
  agent: string
  versions: string[]
  models: string[]
  current: { model: string; effort: string | null }
  onBack: () => void
  onMade: (id: string, name: string) => void
}) {
  const [base, setBase] = useState(versions[0] ?? "live")
  const [what, setWhat] = useState<"model" | "effort" | "instructions">("model")
  // Start on a sibling of the current model — the usual question is "a smaller or bigger one of these?"
  const family = current.model.replace(/-[^-]*$/, "")
  const [model, setModel] = useState(models.find((m) => m !== current.model && m.startsWith(family)) ?? models.find((m) => m !== current.model) ?? current.model)
  const [effort, setEffort] = useState<"minimal" | "low" | "medium" | "high">(current.effort === "high" ? "low" : "high")
  const [line, setLine] = useState("")
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const box = "border-primary-border bg-primary-bg w-full rounded-md border px-2 py-1.5 text-[13px] outline-none"
  const make = async () => {
    setBusy(true)
    const r = await createVariantFn({
      data: { agent, base, name, change: what === "model" ? { model } : what === "effort" ? { effort } : { addInstructions: line } },
    })
    setBusy(false)
    if (!r.ok) return setError(r.error)
    onMade(r.id, r.name)
  }
  return (
    <div className="space-y-3 p-2">
      <button type="button" onClick={onBack} className="text-ink-tertiary hover:text-ink-primary flex items-center gap-1 text-xs">
        <ChevronLeft className="size-3.5" /> Configurations
      </button>
      <div className="text-ink-primary text-sm font-medium">New variant</div>
      <p className={hint}>Nothing is saved to the agent and users aren't affected. If it wins, make it a version in the agent builder.</p>
      <label className="block space-y-1">
        <span className={hint}>Based on</span>
        <select value={base} onChange={(e) => setBase(e.target.value)} className={box}>
          {versions.map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
      </label>
      <div className="space-y-1">
        <span className={hint}>What changes</span>
        <div role="radiogroup" className="smooth-shadow-ring-xs smooth-ring-primary-border inline-flex rounded-lg p-0.5 text-xs">
          {([["model", "Model"], ["effort", "Reasoning"], ["instructions", "An instruction"]] as const).map(([v, l]) => (
            <button key={v} type="button" role="radio" aria-checked={what === v} onClick={() => setWhat(v)} className={cn("rounded-md px-2.5 py-1", what === v ? "bg-primary-bg-active text-ink-primary font-medium" : "text-ink-secondary")}>
              {l}
            </button>
          ))}
        </div>
      </div>
      {what === "model" ? (
        <label className="block space-y-1">
          <span className={hint}>Model · now {current.model}</span>
          <select value={model} onChange={(e) => setModel(e.target.value)} className={box}>
            {models.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </label>
      ) : what === "effort" ? (
        <label className="block space-y-1">
          <span className={hint}>Reasoning effort · now {current.effort ?? "the model's default"}</span>
          <select value={effort} onChange={(e) => setEffort(e.target.value as typeof effort)} className={box}>
            {(["minimal", "low", "medium", "high"] as const).map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
      ) : (
        <label className="block space-y-1">
          <span className={hint}>Added at the end of the instructions</span>
          <textarea value={line} onChange={(e) => setLine(e.target.value)} rows={3} className={box} placeholder="e.g. Always open the document whose title names the question's subject before answering." />
        </label>
      )}
      <label className="block space-y-1">
        <span className={hint}>Name — optional, as its column will show it</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={48} className={box} placeholder={what === "model" ? `${base} · ${model.replace(/^claude-/, "")}` : what === "effort" ? `${base} · ${effort} effort` : `${base} + stricter sourcing`} />
      </label>
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      <button
        type="button"
        disabled={busy || (what === "instructions" && !line.trim())}
        onClick={() => void make()}
        className="bg-ink-primary text-primary-bg h-8 w-full rounded-md text-sm font-medium disabled:opacity-40"
      >
        {busy ? "Saving…" : "Continue to the price"}
      </button>
    </div>
  )
}

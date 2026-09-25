import { useEffect, useRef, useState } from "react"
import { Loader2, Plus, X } from "lucide-react"
import { editInputsFn, getChecksFn, getQuestionsFn, saveChecksFn } from "@/lib/evals-server"
import type { EvalGrid } from "@/lib/evals-server"
import type { Check } from "@/lib/evals/v2/model"
import { checkIdFor } from "@/lib/evals/v2/validate"
import Drawer from "@/components/ui/drawer"
import { EDITOR_DRAWER } from "@/components/evals/shell"
import { askEvalsAgent } from "@/components/evals/agent-panel"
import { cn } from "@/lib/utils"

/**
 * Inputs and what they expect, edited where the results are. An input and
 * its expectations are one thing, so they open in one drawer; the checks
 * every input gets open in another, reached from any input.
 */

type Input = EvalGrid["inputs"][number]

const label = "text-ink-tertiary text-xs"
const field =
  "border-primary-border bg-primary-bg-hover/40 focus:border-ink-tertiary w-full resize-none rounded-lg border px-3 py-2 text-[13px] leading-relaxed outline-none"

/** A textarea that grows with what it holds. */
function Grow(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${el.scrollHeight + 2}px`
  }, [props.value])
  return <textarea ref={ref} rows={1} {...props} className={cn(field, props.className)} />
}

/** A short list of lines — follow-ups, documents, things it must not say. */
function Lines({ values, onChange, placeholder, add }: { values: string[]; onChange: (v: string[]) => void; placeholder: string; add: string }) {
  return (
    <div className="space-y-1.5">
      {values.map((v, n) => (
        <div key={n} className="flex items-start gap-1.5">
          <Grow value={v} placeholder={placeholder} onChange={(e) => onChange(values.map((x, i) => (i === n ? e.target.value : x)))} />
          <button type="button" aria-label="Remove" onClick={() => onChange(values.filter((_, i) => i !== n))} className="text-ink-tertiary hover:text-ink-primary mt-2 shrink-0">
            <X className="size-3.5" />
          </button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...values, ""])} className="text-ink-secondary hover:text-ink-primary flex items-center gap-1 text-xs">
        <Plus className="size-3.5" /> {add}
      </button>
    </div>
  )
}

/**
 * One input: what the user sends, and what should happen. Everything saves
 * as it's typed; past answers stay as they were, and the next run uses the
 * new wording.
 */
export function InputDrawer({
  agent,
  datasetId,
  input,
  checks,
  results,
  onClose,
  onSaved,
  onOpenChecks,
}: {
  agent: string
  datasetId: string
  input: Input | null
  checks: EvalGrid["checks"]
  /** How each open column did on it, to open from here. */
  results: React.ReactNode
  onClose: () => void
  onSaved: () => void
  onOpenChecks: () => void
}) {
  const [draft, setDraft] = useState<{ prompt: string; followUps: string[]; answer: string; docs: string[]; mustNot: string[] } | null>(null)
  const [state, setState] = useState<"idle" | "saving" | "saved" | string>("idle")
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const dirty = useRef(false)

  useEffect(() => {
    if (!input) return setDraft(null)
    dirty.current = false
    setState("idle")
    setDraft({ prompt: input.prompt, followUps: input.followUps, answer: input.answer ?? "", docs: input.docs, mustNot: input.mustNot })
  }, [input])

  const save = async (d: NonNullable<typeof draft>) => {
    if (!input) return
    if (!d.prompt.trim()) return setState("An input needs something the user sends.")
    setState("saving")
    const r = await editInputsFn({
      data: {
        agent,
        datasetId,
        upserts: [{ id: input.id, prompt: d.prompt, followUps: d.followUps.filter((x) => x.trim()), answer: d.answer, docs: d.docs.filter((x) => x.trim()), mustNot: d.mustNot.filter((x) => x.trim()) }],
      },
    })
    setState(r.ok ? "saved" : r.error)
  }
  const change = (patch: Partial<NonNullable<typeof draft>>) => {
    if (!draft) return
    const next = { ...draft, ...patch }
    setDraft(next)
    dirty.current = true
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void save(next), 700)
  }
  const close = () => {
    clearTimeout(timer.current)
    if (dirty.current && draft) void save(draft).then(onSaved)
    else if (dirty.current) onSaved()
    onClose()
  }
  const remove = async () => {
    if (!input) return
    const r = await editInputsFn({ data: { agent, datasetId, deletes: [input.id] } })
    if (!r.ok) return setState(r.error)
    dirty.current = false
    onClose()
    onSaved()
  }

  return (
    <Drawer open={!!input} onOpenChange={(o) => !o && close()}>
      <Drawer.Content className={EDITOR_DRAWER}>
        {input && draft && (
          <div className="flex h-full flex-col">
            <Drawer.Header className="border-primary-border border-b px-5">
              <Drawer.Description className="text-ink-tertiary text-xs tabular-nums">Input {input.id}</Drawer.Description>
              <Drawer.Title className="text-ink-primary text-base">What the user sends, and what should happen</Drawer.Title>
            </Drawer.Header>
            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
              <div className="space-y-1.5">
                <div className={label}>The user sends</div>
                <Grow value={draft.prompt} onChange={(e) => change({ prompt: e.target.value })} aria-label="The user sends" />
                <div className={label}>Then asks</div>
                <Lines values={draft.followUps} onChange={(followUps) => change({ followUps })} placeholder="A follow-up in the same conversation" add="Then asks" />
              </div>

              <div className="space-y-3">
                <div className="text-ink-primary text-sm font-medium">What should happen</div>
                <div className="space-y-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className={label}>A good answer says</span>
                    <button
                      type="button"
                      className="text-ink-secondary hover:text-ink-primary text-xs underline underline-offset-2"
                      onClick={() => askEvalsAgent(`For ${agent}: draft what a good answer to input ${input.id} ("${input.prompt}") says, from the documents ${agent} can read, and save it to the input with edit_questions.`)}
                    >
                      Draft it from the documents
                    </button>
                  </div>
                  <Grow value={draft.answer} placeholder="What the answer should convey — the substance, not the wording" onChange={(e) => change({ answer: e.target.value })} />
                  <p className="text-ink-tertiary text-[11px]">The grader compares answers with this. Without it, it judges with nothing to compare against — far less reliable.</p>
                </div>
                <div className="space-y-1.5">
                  <div className={label}>Reads the document that holds the answer</div>
                  <Lines values={draft.docs} onChange={(docs) => change({ docs })} placeholder="e.g. accessibility.md" add="Document" />
                  <p className="text-ink-tertiary text-[11px]">Checked exactly from the tool log: a read must return this document.</p>
                </div>
                <div className="space-y-1.5">
                  <div className={label}>Must not say</div>
                  <Lines values={draft.mustNot} onChange={(mustNot) => change({ mustNot })} placeholder="e.g. that an overlay makes it compliant" add="Must not say" />
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between">
                  <span className="text-ink-primary text-sm font-medium">Checks every input gets</span>
                  <button type="button" onClick={onOpenChecks} className="text-ink-secondary hover:text-ink-primary text-xs underline underline-offset-2">
                    Edit for all
                  </button>
                </div>
                <ul className="text-ink-secondary space-y-1 text-[13px]">
                  {checks.map((c) => (
                    <li key={c.id} title={c.sentence}>
                      {c.label}
                      <span className="text-ink-tertiary text-xs"> · {c.kind === "counted" ? "exact, from the tool log" : "judged by the grader"}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="space-y-1.5">
                <div className="text-ink-primary text-sm font-medium">How it did</div>
                {results}
              </div>
            </div>
            <div className="border-primary-border flex items-center gap-3 border-t px-5 py-3 text-xs">
              <span className={cn(state !== "idle" && state !== "saving" && state !== "saved" ? "text-red-600 dark:text-red-400" : "text-ink-tertiary")}>
                {state === "idle" ? "Changes save as you type" : state === "saving" ? "Saving…" : state === "saved" ? "Saved" : state}
              </span>
              <span className="flex-1" />
              <button type="button" onClick={() => void remove()} className="text-ink-secondary hover:text-ink-primary underline underline-offset-2">
                Remove input
              </button>
            </div>
          </div>
        )}
      </Drawer.Content>
    </Drawer>
  )
}

/**
 * The composer: an input as a user would send it. Enter adds it; its drawer
 * opens so what should happen can be said straight away.
 */
export function Composer({ agent, datasetId, onAdded }: { agent: string; datasetId: string; onAdded: (id: string) => void }) {
  const [text, setText] = useState("")
  const [turns, setTurns] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const add = async () => {
    if (!text.trim() || busy) return
    setBusy(true)
    setError(null)
    const r = await editInputsFn({ data: { agent, datasetId, upserts: [{ prompt: text.trim(), followUps: turns.filter((t) => t.trim()) }] } })
    setBusy(false)
    if (!r.ok) return setError(r.error)
    setText("")
    setTurns([])
    const id = r.added[0]
    if (id) onAdded(id)
  }
  return (
    <div className="border-primary-border bg-primary-bg focus-within:border-ink-tertiary rounded-xl border px-3 pt-2 pb-1.5">
      <Grow
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault()
            void add()
          }
        }}
        placeholder="Add an input, as a user would send it — Enter to add, Shift+Enter for a new line"
        aria-label="Add an input"
        className="border-0 bg-transparent px-0.5 py-1 focus:border-0"
      />
      {turns.map((t, n) => (
        <div key={n} className="border-primary-border flex items-center gap-2 border-t border-dashed py-1">
          <span className="text-ink-tertiary w-16 shrink-0 text-[11px]">Then asks</span>
          <input
            value={t}
            onChange={(e) => setTurns(turns.map((x, i) => (i === n ? e.target.value : x)))}
            aria-label={`Follow-up ${n + 1}`}
            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
          />
          <button type="button" aria-label="Remove follow-up" onClick={() => setTurns(turns.filter((_, i) => i !== n))} className="text-ink-tertiary hover:text-ink-primary">
            <X className="size-3.5" />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-3 pt-1">
        <button type="button" onClick={() => setTurns([...turns, ""])} className="text-ink-secondary hover:text-ink-primary text-xs">
          + Then asks
        </button>
        {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
        <span className="flex-1" />
        <button type="button" disabled={!text.trim() || busy} onClick={() => void add()} className="bg-ink-primary text-primary-bg h-7 rounded-md px-3 text-xs font-medium disabled:opacity-40">
          {busy ? "Adding…" : "Add input"}
        </button>
      </div>
    </div>
  )
}

type Draft = { key: string; check: Check }

const AddMenu: { kind: "ask" | "mustnot" | "never"; name: string; hint: string }[] = [
  { kind: "ask", name: "Ask the grader", hint: "A yes/no question about every answer — e.g. Is the tone friendly?" },
  { kind: "mustnot", name: "Must not say", hint: "Something no answer may say — e.g. legal advice" },
  { kind: "never", name: "Never calls a tool", hint: "Exact, from the tool log — e.g. never send_email" },
]

/**
 * What every input is checked for. Saving makes a new version of the checks:
 * old grades stay with the version that gave them, and answers already there
 * can be graded under the new one for cents.
 */
export function ChecksDrawer({
  agent,
  rubricId,
  open,
  onClose,
  onSaved,
}: {
  agent: string
  rubricId: string
  open: boolean
  onClose: () => void
  /** A new version was saved; its checks haven't graded anything yet. */
  onSaved: () => void
}) {
  const [loaded, setLoaded] = useState<{ version: number; defaultJudge: string } | null>(null)
  const [rows, setRows] = useState<Draft[]>([])
  const [adding, setAdding] = useState(false)
  const [state, setState] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    if (!open) return
    setLoaded(null)
    setState(null)
    setDirty(false)
    void getChecksFn({ data: { agent, rubricId } }).then((r) => {
      if (!r) return setState("These checks couldn't be loaded.")
      setLoaded({ version: r.rubric.version, defaultJudge: r.rubric.defaultJudge })
      setRows((JSON.parse(r.rubric.checks) as Check[]).map((check) => ({ key: check.id, check })))
    })
  }, [open, agent, rubricId])

  const edit = (key: string, patch: Partial<Check>) => {
    setRows(rows.map((r) => (r.key === key ? { ...r, check: { ...r.check, ...patch } as Check } : r)))
    setDirty(true)
  }
  const add = (kind: (typeof AddMenu)[number]["kind"]) => {
    const taken = rows.map((r) => r.check.id)
    const key = `new-${Date.now()}`
    const check: Check =
      kind === "never"
        ? { kind: "counted", id: checkIdFor("never-calls", taken), label: "Never calls a tool", spec: { op: "never_called", tool: "" } }
        : kind === "mustnot"
          ? { kind: "asked", id: checkIdFor("must-not-say", taken), label: "Doesn't say it", ask: "Does the answer avoid saying: ", shape: { type: "boolean" } }
          : { kind: "asked", id: checkIdFor("grader-question", taken), label: "", ask: "", shape: { type: "boolean" } }
    setRows([...rows, { key, check }])
    setAdding(false)
    setDirty(true)
  }
  const save = async () => {
    if (!loaded) return
    setBusy(true)
    const checks = rows.map((r) =>
      // A question with no name is named by its first words.
      r.check.label.trim() ? r.check : { ...r.check, label: r.check.kind === "asked" ? r.check.ask.replace(/\?$/, "").slice(0, 48) : r.check.label },
    )
    const r = await saveChecksFn({ data: { agent, rubricId, defaultJudge: loaded.defaultJudge, checks: JSON.stringify(checks) } })
    setBusy(false)
    if (!r.ok) return setState(r.error)
    setLoaded({ ...loaded, version: r.version })
    setDirty(false)
    setState(`Saved as version ${r.version}. Answers already there aren't graded with it yet.`)
    onSaved()
  }

  return (
    <Drawer open={open} onOpenChange={(o) => !o && onClose()}>
      <Drawer.Content className={EDITOR_DRAWER}>
        <div className="flex h-full flex-col">
          <Drawer.Header className="border-primary-border border-b px-5">
            <Drawer.Description className="text-ink-tertiary text-xs tabular-nums">
              Applies to every input{loaded ? ` · version ${loaded.version}` : ""}
            </Drawer.Description>
            <Drawer.Title className="text-ink-primary text-base">Checks for every input</Drawer.Title>
          </Drawer.Header>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
            {!loaded ? (
              <Loader2 className="text-ink-tertiary size-4 animate-spin" />
            ) : (
              <ul className="divide-primary-border border-primary-border divide-y rounded-lg border">
                {rows.map(({ key, check: c }) => (
                  <li key={key} className="space-y-1.5 px-3 py-2.5">
                    <div className="flex items-start gap-2">
                      <input
                        value={c.label}
                        onChange={(e) => edit(key, { label: e.target.value })}
                        placeholder="Name, as the table shows it"
                        aria-label="Name"
                        className="text-ink-primary min-w-0 flex-1 bg-transparent text-[13px] font-medium outline-none"
                      />
                      <button type="button" aria-label={`Remove ${c.label || "check"}`} onClick={() => (setRows(rows.filter((r) => r.key !== key)), setDirty(true))} className="text-ink-tertiary hover:text-ink-primary">
                        <X className="size-3.5" />
                      </button>
                    </div>
                    {c.kind === "asked" ? (
                      <Grow value={c.ask} onChange={(e) => edit(key, { ask: e.target.value })} placeholder="A yes/no question about the answer" aria-label="Question for the grader" />
                    ) : c.spec.op === "never_called" ? (
                      <input
                        value={c.spec.tool}
                        onChange={(e) => edit(key, { spec: { op: "never_called", tool: e.target.value } })}
                        placeholder="Tool name — a * matches anything, e.g. *_send_email"
                        aria-label="Tool"
                        className={field}
                      />
                    ) : null}
                    <p className="text-ink-tertiary text-[11px]">
                      {c.kind === "counted" ? "Exact, from the tool log · free" : `Judged by the grader${c.judge ? ` (${c.judge})` : ""}`}
                      {c.kind === "asked" && !/good answer|REFERENCE|reference/i.test(c.ask) && !c.ask.toLowerCase().includes("tool") && " · no answer to compare against, so the least reliable kind"}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            {loaded && (
              <div>
                {adding ? (
                  <div className="border-primary-border rounded-lg border p-1">
                    {AddMenu.map((m) => (
                      <button key={m.kind} type="button" onClick={() => add(m.kind)} className="hover:bg-primary-bg-hover flex w-full flex-col items-start rounded-md px-2.5 py-1.5 text-left text-sm">
                        {m.name} <span className="text-ink-tertiary text-xs">{m.hint}</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <button type="button" onClick={() => setAdding(true)} className="text-ink-secondary hover:text-ink-primary flex items-center gap-1 text-[13px]">
                    <Plus className="size-3.5" /> Add a check for every input
                  </button>
                )}
              </div>
            )}
            <p className="text-ink-tertiary text-xs">
              For rules that hold everywhere. Anything about one input — its good answer, the document it should read — goes on that input.
            </p>
          </div>
          <div className="border-primary-border flex items-center gap-3 border-t px-5 py-3">
            <span className={cn("text-xs", state && !state.startsWith("Saved") ? "text-red-600 dark:text-red-400" : "text-ink-tertiary")}>{state ?? (dirty ? "Not saved" : "")}</span>
            <span className="flex-1" />
            <button type="button" disabled={!dirty || busy} onClick={() => void save()} className="bg-ink-primary text-primary-bg h-8 rounded-md px-3 text-sm font-medium disabled:opacity-40">
              {busy ? "Saving…" : "Save as a new version"}
            </button>
          </div>
        </div>
      </Drawer.Content>
    </Drawer>
  )
}

/** The set itself: who asks, how answers should read. The grader reads both. */
export function SetDetails({ agent, datasetId }: { agent: string; datasetId: string }) {
  const [a, setA] = useState<string | null>(null)
  const [n, setN] = useState("")
  const [state, setState] = useState<string | null>(null)
  useEffect(() => {
    void getQuestionsFn({ data: { agent, datasetId } }).then((r) => {
      setA(r?.dataset.audience ?? "")
      setN(r?.dataset.note ?? "")
    })
  }, [agent, datasetId])
  const save = async () => {
    const r = await editInputsFn({ data: { agent, datasetId, audience: a ?? "", note: n } })
    setState(r.ok ? "Saved" : r.error)
  }
  if (a === null) return <Loader2 className="text-ink-tertiary m-2 size-4 animate-spin" />
  return (
    <div className="space-y-2 p-2">
      <div className={label}>Who asks, in one line</div>
      <Grow value={a} onChange={(e) => setA(e.target.value)} placeholder="e.g. product teams at mid-size B2B companies" />
      <div className={label}>How answers should read</div>
      <Grow value={n} onChange={(e) => setN(e.target.value)} placeholder="e.g. free-standing advice, never cites the source" />
      <p className="text-ink-tertiary text-[11px]">The grader reads both, so a correct answer isn't marked down for its register.</p>
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => void save()} className="bg-ink-primary text-primary-bg h-7 rounded-md px-3 text-xs font-medium">
          Save
        </button>
        {state && <span className="text-ink-tertiary text-xs">{state}</span>}
      </div>
    </div>
  )
}

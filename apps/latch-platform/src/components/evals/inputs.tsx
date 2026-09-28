import { useEffect, useRef, useState } from "react"
import { FileText, Loader2, Paperclip, Plus, X } from "lucide-react"
import { editInputFilesFn, editInputsFn, getChecksFn, getQuestionsFn, getToolArgsFn, promoteJudgedFn, saveChecksFn, tryCheckFn } from "@/lib/evals-server"
import { ATTACHMENT_ACCEPT, ATTACHMENT_MAX_FILE_SIZE, formatFileSize } from "@/lib/ai/attachments"
import type { EvalGrid } from "@/lib/evals-server"
import type { CallExpectation, CallMatch, Check, JudgedItem } from "@/lib/evals/v2/model"
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
type FileMeta = { filename: string; mediaType: string; size: number }

/** A picked file as chat sends one: its contents as a data URL. */
const readFile = (f: File) =>
  new Promise<{ filename: string; mediaType: string; url: string }>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve({ filename: f.name, mediaType: f.type || "application/octet-stream", url: String(r.result) })
    r.onerror = () => reject(new Error(`Couldn't read ${f.name}.`))
    r.readAsDataURL(f)
  })

function FileChip({ file, onRemove }: { file: FileMeta; onRemove?: () => void }) {
  return (
    <span className="border-primary-border bg-primary-bg-hover/40 inline-flex h-7 max-w-[260px] items-center gap-1.5 rounded-md border px-2 text-xs">
      <FileText className="text-ink-tertiary size-3.5 shrink-0" />
      <span className="text-ink-primary truncate">{file.filename}</span>
      <span className="text-ink-tertiary shrink-0 tabular-nums">{formatFileSize(file.size)}</span>
      {onRemove && (
        <button type="button" aria-label={`Remove ${file.filename}`} onClick={onRemove} className="text-ink-tertiary hover:text-ink-primary">
          <X className="size-3" />
        </button>
      )}
    </span>
  )
}

/** A paperclip that opens the file picker; each chosen file is handed over as it's read. */
function Attach({ onPick, disabled }: { onPick: (files: File[]) => void; disabled?: boolean }) {
  const ref = useRef<HTMLInputElement>(null)
  return (
    <>
      <input
        ref={ref}
        type="file"
        multiple
        hidden
        accept={ATTACHMENT_ACCEPT}
        onChange={(e) => {
          onPick([...(e.target.files ?? [])])
          e.target.value = ""
        }}
      />
      <button type="button" disabled={disabled} onClick={() => ref.current?.click()} className="text-ink-secondary hover:text-ink-primary flex items-center gap-1 text-xs disabled:opacity-40">
        <Paperclip className="size-3.5" /> Attach
      </button>
    </>
  )
}

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

/** A short list of lines — follow-ups, things it must not say. */
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
  rubricId,
  knownTags = [],
  input,
  checks,
  results,
  onClose,
  onSaved,
  onOpenChecks,
}: {
  agent: string
  datasetId: string
  /** The checks a judge question can move to, and whose judges it can use. */
  rubricId: string | undefined
  /** Tags other inputs use, offered as you type. */
  knownTags?: string[]
  input: Input | null
  checks: EvalGrid["checks"]
  /** How each open column did on it, to open from here. */
  results: React.ReactNode
  onClose: () => void
  onSaved: () => void
  onOpenChecks: () => void
}) {
  const [draft, setDraft] = useState<Expectations | null>(null)
  const [tools, setTools] = useState<Tools>([])
  const [files, setFiles] = useState<FileMeta[]>([])
  const [uploading, setUploading] = useState(false)
  const [state, setState] = useState<"idle" | "saving" | "saved" | string>("idle")
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const dirty = useRef(false)

  useEffect(() => {
    if (!input) return setDraft(null)
    dirty.current = false
    setState("idle")
    setFiles(input.files)
    setDraft({
      prompt: input.prompt,
      followUps: input.followUps,
      answer: input.answer ?? "",
      mustNot: input.mustNot,
      mustSay: input.mustSay,
      // A plain yes/no question and a typed one are the same thing to edit.
      judged: [...input.asks.map((ask): JudgedItem => ({ ask, shape: { type: "boolean" } })), ...input.judged],
      decline: input.decline,
      calls: input.calls,
      tags: input.tags,
    })
  }, [input])
  const [judges, setJudges] = useState<{ list: string[]; fallback: string }>({ list: [], fallback: "jev-latest" })
  useEffect(() => {
    if (!openIdFor(input) || !rubricId) return
    void getChecksFn({ data: { agent, rubricId } }).then((r) => {
      if (r) setJudges({ list: r.judges.filter((id) => !NOT_A_JUDGE.test(id)), fallback: r.rubric.defaultJudge })
    })
  }, [input, agent, rubricId])
  // Once per input opened: the tools don't change while it's open.
  const openId = input?.id
  useEffect(() => {
    if (!openId) return
    void getToolArgsFn({ data: { agent, datasetId } }).then((t) => setTools(t ?? []))
  }, [openId, agent, datasetId])

  const save = async (d: NonNullable<typeof draft>) => {
    if (!input) return
    if (!d.prompt.trim()) return setState("An input needs something the user sends.")
    setState("saving")
    const r = await editInputsFn({
      data: {
        agent,
        datasetId,
        upserts: [
          {
            id: input.id,
            prompt: d.prompt,
            followUps: d.followUps.filter((x) => x.trim()),
            answer: d.answer,
            mustNot: d.mustNot.filter((x) => x.trim()),
            mustSay: d.mustSay.filter((x) => x.trim()),
            asks: [],
            judged: d.judged.filter((j) => j.ask.trim()),
            decline: d.decline,
            calls: d.calls.filter((c) => c.tool.trim()),
            tags: d.tags,
          },
        ],
      },
    })
    setState(r.ok ? (r.checksAdded.length ? `Saved — added “${r.checksAdded.join("” and “")}” to the checks, so this can be graded` : "saved") : r.error)
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
  const attach = async (picked: File[]) => {
    if (!input) return
    setUploading(true)
    for (const f of picked) {
      if (f.size > ATTACHMENT_MAX_FILE_SIZE) {
        setState(`${f.name} is over ${formatFileSize(ATTACHMENT_MAX_FILE_SIZE)}.`)
        continue
      }
      const r = await editInputFilesFn({ data: { agent, datasetId, inputId: input.id, add: await readFile(f) } })
      if (!r.ok) setState(r.error)
      else setFiles(r.files)
    }
    setUploading(false)
    dirty.current = true
  }
  const detach = async (n: number) => {
    if (!input) return
    const r = await editInputFilesFn({ data: { agent, datasetId, inputId: input.id, remove: n } })
    if (!r.ok) return setState(r.error)
    setFiles(r.files)
    dirty.current = true
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
                <Grow value={draft.prompt} onChange={(e) => change({ prompt: e.target.value })} aria-label="The user sends" className="text-[14px]" />
                <div className="flex flex-wrap items-center gap-2">
                  {files.map((f, n) => (
                    <FileChip key={`${f.filename}-${n}`} file={f} onRemove={() => void detach(n)} />
                  ))}
                  {uploading ? <Loader2 className="text-ink-tertiary size-3.5 animate-spin" /> : <Attach onPick={(fs) => void attach(fs)} />}
                  {files.length > 0 && <span className="text-ink-tertiary text-[11px]">Sent with the first message on every run</span>}
                </div>
                <div className={label}>Then asks</div>
                <Lines values={draft.followUps} onChange={(followUps) => change({ followUps })} placeholder="A follow-up in the same conversation" add="Then asks" />
              </div>

              <div className="space-y-1.5">
                <div className={label}>Tags</div>
                <TagsEditor tags={draft.tags} known={knownTags} onChange={(tags) => change({ tags })} />
                <p className="text-ink-tertiary text-[11px]">Groups this input belongs to — views show a group, and a check can apply to some groups only.</p>
              </div>

              <div className="space-y-2">
                <div className="text-ink-primary text-sm font-medium">What should happen</div>
                <ExpectationList
                  draft={draft}
                  change={change}
                  tools={tools}
                  judge={{
                    agent,
                    datasetId,
                    rubricId,
                    inputId: input.id,
                    judges: judges.list,
                    fallback: judges.fallback,
                    onPromote: async (n) => {
                      if (!rubricId) return "No checks to move it to."
                      clearTimeout(timer.current)
                      if (dirty.current) await save(draft)
                      const r = await promoteJudgedFn({ data: { agent, datasetId, rubricId, inputId: input.id, index: n } })
                      if (!r.ok) return r.error
                      dirty.current = false
                      setDraft({ ...draft, judged: draft.judged.filter((_, i) => i !== n) })
                      setState(`Moved — “${r.label}” is now a check every input gets (version ${r.version})`)
                      onSaved()
                      return null
                    },
                  }}
                  onDraftAnswer={() => askEvalsAgent(`For ${agent}: draft what a good answer to input ${input.id} ("${input.prompt}") says — from what ${agent} can look up with its tools, and what this input expects it to call — and save it to the input with edit_questions.`)}
                />
              </div>

              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between">
                  <span className="text-ink-primary text-sm font-medium">Checks every input gets</span>
                  <button type="button" onClick={onOpenChecks} className="text-ink-secondary hover:text-ink-primary text-xs underline underline-offset-2">
                    Edit for all
                  </button>
                </div>
                <ul className="divide-primary-border border-primary-border divide-y rounded-lg border text-[13px]">
                  {checks.map((c) => (
                    <li key={c.id} title={c.sentence} className="grid grid-cols-[96px_minmax(0,1fr)] gap-3 px-3 py-2">
                      <span className="text-ink-tertiary text-xs">{c.kind === "counted" ? "Tool log" : "Grader"}</span>
                      <span className="text-ink-primary">{c.label}</span>
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
              <span className={cn(state !== "idle" && state !== "saving" && !state.startsWith("Saved") && state !== "saved" ? "text-red-600 dark:text-red-400" : "text-ink-tertiary")}>
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

type Expectations = {
  prompt: string
  followUps: string[]
  answer: string
  mustNot: string[]
  mustSay: string[]
  judged: JudgedItem[]
  decline: boolean
  calls: CallExpectation[]
  tags: string[]
}
type JudgeContext = {
  agent: string
  datasetId: string
  rubricId: string | undefined
  inputId: string
  judges: string[]
  fallback: string
  /** Move question n to the checks every input gets; an error in words, or null. */
  onPromote: (n: number) => Promise<string | null>
}
/** Models that can't read an answer: the catalog also lists image, speech and embedding ones. */
const NOT_A_JUDGE = /image|embedding|tts|veo|lyria|realtime|-live|computer-use|deep-research|translate|audio/
const openIdFor = (i: { id: string } | null) => i?.id
type Tools = NonNullable<Awaited<ReturnType<typeof getToolArgsFn>>>
/** `edge-v2-kn_read_file` → `read_file`; a built-in like `read_file` stays whole. */
const short = (t: string) => {
  const cut = t.indexOf("_")
  return cut > 0 && t.slice(0, cut).includes("-") ? t.slice(cut + 1) : t
}
const OPS: Partial<Record<string, [CallMatch["op"], string][]>> = {
  text: [["contains", "contains"], ["equals", "is"], ["not_contains", "doesn't contain"], ["any", "is set"]],
  list: [["contains", "includes"], ["not_contains", "doesn't include"], ["any", "is set"]],
  number: [["equals", "is"], ["any", "is set"]],
  boolean: [["equals", "is"]],
  result: [["contains", "contains"], ["not_contains", "doesn't contain"]],
}
const TEXT_OPS: [CallMatch["op"], string][] = [["contains", "contains"], ["equals", "is"], ["not_contains", "doesn't contain"], ["any", "is set"]]
const opsFor = (type: string) => OPS[type] ?? TEXT_OPS

/**
 * One expected call: the tool from the agent's own list, then a match per
 * argument — picked from the arguments it actually sent before, with the
 * values it sent suggested — or on what came back.
 */
function CallEditor({ call, tools, onChange }: { call: CallExpectation; tools: Tools; onChange: (c: CallExpectation) => void }) {
  const tool = tools.find((t) => t.name === call.tool)
  const args = tool?.args ?? []
  const choices = [...args.map((a) => ({ name: a.name, type: a.type, seen: a.seen })), { name: "result", type: "result", seen: [] as string[] }]
  const box = "border-primary-border bg-primary-bg rounded-md border px-1.5 py-1 text-[13px] outline-none"
  const match = call.match ?? []
  const setMatch = (n: number, patch: Partial<CallMatch>) => onChange({ ...call, match: match.map((m, i) => (i === n ? { ...m, ...patch } : m)) })
  return (
    <div className="space-y-1.5">
      <select
        aria-label="Tool"
        value={call.tool}
        onChange={(e) => onChange({ tool: e.target.value, ...(call.never ? { never: true } : {}) })}
        className={cn(box, "max-w-full")}
      >
        {!call.tool && <option value="">Pick a tool…</option>}
        {!tools.some((t) => t.name === call.tool) && call.tool && <option value={call.tool}>{short(call.tool)}</option>}
        {tools.map((t) => {
          // Two servers can both have a read_file: name the server where the short names clash.
          const clash = tools.filter((x) => short(x.name) === short(t.name)).length > 1
          return (
            <option key={t.name} value={t.name}>
              {short(t.name)}
              {t.builtIn ? " · built-in" : clash ? ` (${t.name.slice(0, t.name.indexOf("_"))})` : ""}
              {t.called ? "" : " · not called yet"}
            </option>
          )
        })}
      </select>
      {!call.never &&
        match.map((m, n) => {
          const c = choices.find((x) => x.name === m.path) ?? { name: m.path, type: "text", seen: [] }
          const ops = opsFor(c.type)
          return (
            <div key={n} className="grid grid-cols-[minmax(0,1fr)_112px_minmax(0,1.3fr)_auto] items-center gap-1.5">
              <select aria-label="Argument" value={m.path} onChange={(e) => setMatch(n, { path: e.target.value, op: opsFor(choices.find((x) => x.name === e.target.value)?.type ?? "text")[0][0], value: "" })} className={box}>
                {choices.map((x) => (
                  <option key={x.name} value={x.name}>
                    {x.name === "result" ? "the result" : x.name}
                  </option>
                ))}
              </select>
              <select aria-label="Match" value={m.op} onChange={(e) => setMatch(n, { op: e.target.value as CallMatch["op"] })} className={box}>
                {ops.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
              {m.op === "any" ? (
                <span />
              ) : (
                <>
                  <input aria-label="Value" list={`seen-${call.tool}-${m.path}`} value={m.value ?? ""} onChange={(e) => setMatch(n, { value: e.target.value })} className={box} placeholder="value" />
                  <datalist id={`seen-${call.tool}-${m.path}`}>
                    {c.seen.map((v) => (
                      <option key={v} value={v} />
                    ))}
                  </datalist>
                </>
              )}
              <button type="button" aria-label="Remove match" onClick={() => onChange({ ...call, match: match.filter((_, i) => i !== n) })} className="text-ink-tertiary hover:text-ink-primary">
                <X className="size-3.5" />
              </button>
            </div>
          )
        })}
      {!call.never && call.tool && (
        <button
          type="button"
          onClick={() => {
            const free = choices.find((x) => !match.some((m) => m.path === x.name)) ?? choices[0]
            onChange({ ...call, match: [...match, { path: free.name, op: opsFor(free.type)[0][0], value: "" }] })
          }}
          className="text-ink-secondary hover:text-ink-primary text-[11px] underline underline-offset-2"
        >
          + {args.length ? `argument (${args.length} seen in past calls) or result` : "match on the result"}
        </button>
      )}
    </div>
  )
}

const inline =
  "text-ink-primary -mx-1.5 -my-1 w-[calc(100%+12px)] resize-none rounded-md border border-transparent bg-transparent px-1.5 py-1 text-[13px] leading-relaxed outline-none hover:border-[color:var(--color-primary-border)] focus:border-[color:var(--color-ink-tertiary)] focus:bg-[color:var(--color-primary-bg-hover)]"

/** A value edited where it sits: plain text until hovered or focused. */
function Inline(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${el.scrollHeight + 2}px`
  }, [props.value])
  return <textarea ref={ref} rows={1} {...props} className={cn(inline, props.className)} />
}

/**
 * What should happen, one row per expectation: its kind, its value edited in
 * place, how it's checked. + adds one; × removes it.
 */
function ExpectationList({
  draft,
  change,
  onDraftAnswer,
  tools,
  judge,
}: {
  draft: Expectations
  change: (p: Partial<Expectations>) => void
  onDraftAnswer: () => void
  tools: Tools
  judge: JudgeContext
}) {
  const [adding, setAdding] = useState(false)
  const [showAnswer, setShowAnswer] = useState(!!draft.answer)
  const focusLast = useRef<string | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  useEffect(() => {
    if (!focusLast.current) return
    const els = listRef.current?.querySelectorAll<HTMLTextAreaElement>(`[data-kind="${focusLast.current}"]`)
    els?.[els.length - 1]?.focus()
    focusLast.current = null
  })
  const row = (key: string, kind: string, how: string, editor: React.ReactNode, onRemove: () => void, extra?: React.ReactNode) => (
    <li key={key} className="grid grid-cols-[96px_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-0.5 px-3 py-2">
      <span className="text-ink-tertiary pt-1 text-xs">{kind}</span>
      <div className="min-w-0 space-y-1">
        {editor}
        {extra}
        <p className="text-ink-tertiary text-[11px]">{how}</p>
      </div>
      <button type="button" aria-label={`Remove ${kind.toLowerCase()}`} onClick={onRemove} className="text-ink-tertiary hover:text-ink-primary pt-1.5">
        <X className="size-3.5" />
      </button>
    </li>
  )
  const add = (kind: "answer" | "mustNot" | "mustSay" | "judged" | "decline" | "calls" | "never") => {
    setAdding(false)
    if (kind === "answer") setShowAnswer(true)
    else if (kind === "decline") change({ decline: true })
    else if (kind === "calls" || kind === "never") change({ calls: [...draft.calls, { tool: "", ...(kind === "never" ? { never: true } : {}) }] })
    else if (kind === "judged") change({ judged: [...draft.judged, { ask: "", shape: { type: "boolean" } }] })
    else change({ [kind]: [...draft[kind], ""] })
    focusLast.current = kind
  }
  const listRow = (key: "mustSay", kind: string, placeholder: string) =>
    draft[key].map((m, n) =>
      row(
        `${key}-${n}`,
        kind,
        "Judged by the grader, as a yes/no",
        <Inline data-kind={key} value={m} placeholder={placeholder} onChange={(e) => change({ [key]: draft[key].map((x, i) => (i === n ? e.target.value : x)) })} />,
        () => change({ [key]: draft[key].filter((_, i) => i !== n) }),
      ),
    )
  const rows = [
    ...(showAnswer || draft.answer
      ? [
          row(
            "answer",
            "Good answer",
            "Judged by the grader, against this",
            <Inline data-kind="answer" value={draft.answer} placeholder="What the answer should convey — the substance, not the wording" onChange={(e) => change({ answer: e.target.value })} />,
            () => (change({ answer: "" }), setShowAnswer(false)),
            <button type="button" onClick={onDraftAnswer} className="text-ink-secondary hover:text-ink-primary text-[11px] underline underline-offset-2">
              Draft it
            </button>,
          ),
        ]
      : []),
    ...draft.mustNot.map((m, n) =>
      row(
        `not-${n}`,
        "Must not say",
        "Judged by the grader, as a yes/no",
        <Inline data-kind="mustNot" value={m} placeholder="e.g. that an overlay makes it compliant" onChange={(e) => change({ mustNot: draft.mustNot.map((x, i) => (i === n ? e.target.value : x)) })} />,
        () => change({ mustNot: draft.mustNot.filter((_, i) => i !== n) }),
      ),
    ),
    ...listRow("mustSay", "Must say", "e.g. the August 2026 deadline"),
    ...draft.calls.map((c, n) =>
      row(
        `call-${n}`,
        c.never ? "Never calls" : "Calls a tool",
        c.never ? "Exact, from the tool log: no call to this tool" : "Exact, from the tool log: one call must match all of these",
        <CallEditor call={c} tools={tools} onChange={(next) => change({ calls: draft.calls.map((x, i) => (i === n ? next : x)) })} />,
        () => change({ calls: draft.calls.filter((_, i) => i !== n) }),
      ),
    ),
    ...(draft.decline
      ? [row("decline", "Should decline", "Judged by the grader, as a yes/no", <span className="text-ink-primary text-[13px]">A polite no, pointing somewhere useful</span>, () => change({ decline: false }))]
      : []),
    ...draft.judged.map((j, n) =>
      row(
        `judged-${n}`,
        "Ask the judge",
        j.shape.type === "boolean" ? "The judge answers yes or no" : j.shape.type === "choice" ? "The judge picks one label" : "The judge places it on the scale",
        <JudgedEditor
          item={j}
          judge={judge}
          index={n}
          onChange={(next) => change({ judged: draft.judged.map((x, i) => (i === n ? next : x)) })}
        />,
        () => change({ judged: draft.judged.filter((_, i) => i !== n) }),
      ),
    ),
  ]
  return (
    <div className="space-y-2">
      {rows.length > 0 ? (
        <ul ref={listRef} className="divide-primary-border border-primary-border divide-y rounded-lg border">
          {rows}
        </ul>
      ) : (
        <p className="text-ink-tertiary text-xs">Nothing yet — without a good answer, the grader has nothing to compare against.</p>
      )}
      {adding ? (
        <div className="border-primary-border rounded-lg border p-1">
          {!showAnswer && !draft.answer && (
            <button type="button" onClick={() => add("answer")} className="hover:bg-primary-bg-hover flex w-full flex-col items-start rounded-md px-2.5 py-1.5 text-left text-sm">
              Good answer <span className="text-ink-tertiary text-xs">What the answer should convey</span>
            </button>
          )}
          <button type="button" onClick={() => add("calls")} className="hover:bg-primary-bg-hover flex w-full flex-col items-start rounded-md px-2.5 py-1.5 text-left text-sm">
            Calls a tool <span className="text-ink-tertiary text-xs">e.g. get_weather with city Turku — checked exactly</span>
          </button>
          <button type="button" onClick={() => add("never")} className="hover:bg-primary-bg-hover flex w-full flex-col items-start rounded-md px-2.5 py-1.5 text-left text-sm">
            Doesn't call a tool <span className="text-ink-tertiary text-xs">e.g. never sends email without asking</span>
          </button>
          <button type="button" onClick={() => add("mustSay")} className="hover:bg-primary-bg-hover flex w-full flex-col items-start rounded-md px-2.5 py-1.5 text-left text-sm">
            Must say <span className="text-ink-tertiary text-xs">Something the answer has to include</span>
          </button>
          <button type="button" onClick={() => add("mustNot")} className="hover:bg-primary-bg-hover flex w-full flex-col items-start rounded-md px-2.5 py-1.5 text-left text-sm">
            Must not say <span className="text-ink-tertiary text-xs">e.g. legal advice</span>
          </button>
          {!draft.decline && (
            <button type="button" onClick={() => add("decline")} className="hover:bg-primary-bg-hover flex w-full flex-col items-start rounded-md px-2.5 py-1.5 text-left text-sm">
              Should decline <span className="text-ink-tertiary text-xs">The right answer is a polite no</span>
            </button>
          )}
          <button type="button" onClick={() => add("judged")} className="hover:bg-primary-bg-hover flex w-full flex-col items-start rounded-md px-2.5 py-1.5 text-left text-sm">
            Ask the judge <span className="text-ink-tertiary text-xs">About this answer — yes/no, one of a set of labels, or a scale</span>
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => setAdding(true)} className="text-ink-secondary hover:text-ink-primary flex items-center gap-1 text-[13px]">
          <Plus className="size-3.5" /> Add an expectation
        </button>
      )}
    </div>
  )
}

/**
 * The composer: an input as a user would send it. Enter adds it; its drawer
 * opens so what should happen can be said straight away.
 */
export function Composer({ agent, datasetId, onAdded }: { agent: string; datasetId: string; onAdded: (id: string) => void }) {
  const [text, setText] = useState("")
  const [turns, setTurns] = useState<string[]>([])
  const [picked, setPicked] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const add = async () => {
    if (!text.trim() || busy) return
    setBusy(true)
    setError(null)
    const r = await editInputsFn({ data: { agent, datasetId, upserts: [{ prompt: text.trim(), followUps: turns.filter((t) => t.trim()) }] } })
    if (!r.ok) return (setBusy(false), setError(r.error))
    const id = r.added[0]
    // The input exists now; its files go on one at a time.
    for (const f of id ? picked : []) {
      const a = await editInputFilesFn({ data: { agent, datasetId, inputId: id, add: await readFile(f) } })
      if (!a.ok) setError(a.error)
    }
    setBusy(false)
    setText("")
    setTurns([])
    setPicked([])
    if (id) onAdded(id)
  }
  return (
    <div className="border-primary-border bg-primary-bg focus-within:border-ink-tertiary rounded-xl border px-3 pt-2 pb-1.5">
      {picked.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-0.5 pb-1">
          {picked.map((f, n) => (
            <FileChip key={`${f.name}-${n}`} file={{ filename: f.name, mediaType: f.type, size: f.size }} onRemove={() => setPicked(picked.filter((_, i) => i !== n))} />
          ))}
        </div>
      )}
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
        <Attach
          onPick={(fs) => {
            const big = fs.find((f) => f.size > ATTACHMENT_MAX_FILE_SIZE)
            if (big) setError(`${big.name} is over ${formatFileSize(ATTACHMENT_MAX_FILE_SIZE)}.`)
            setPicked([...picked, ...fs.filter((f) => f.size <= ATTACHMENT_MAX_FILE_SIZE)].slice(0, 5))
          }}
        />
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

/** Tags as chips; Enter or comma adds one, known tags are offered as you type. */
export function TagsEditor({ tags, known, onChange, placeholder = "Add a tag, e.g. pdf" }: { tags: string[]; known: string[]; onChange: (t: string[]) => void; placeholder?: string }) {
  const [text, setText] = useState("")
  const clean = (t: string) => t.trim().toLowerCase().replace(/\s+/g, "-")
  const add = (t: string) => {
    const x = clean(t)
    if (x && !tags.includes(x)) onChange([...tags, x])
    setText("")
  }
  const offered = known.filter((k) => !tags.includes(k) && (!text || k.includes(clean(text)))).slice(0, 6)
  return (
    <div className="space-y-1.5">
      <div className="border-primary-border flex flex-wrap items-center gap-1.5 rounded-lg border px-2 py-1.5">
        {tags.map((t) => (
          <span key={t} className="bg-primary-bg-active text-ink-primary inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px]">
            {t}
            <button type="button" aria-label={`Remove tag ${t}`} onClick={() => onChange(tags.filter((x) => x !== t))} className="text-ink-tertiary hover:text-ink-primary">
              <X className="size-3" />
            </button>
          </span>
        ))}
        <input
          value={text}
          onChange={(e) => (e.target.value.endsWith(",") ? add(e.target.value.slice(0, -1)) : setText(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.preventDefault(), add(text))
            if (e.key === "Backspace" && !text && tags.length) onChange(tags.slice(0, -1))
          }}
          placeholder={tags.length ? "" : placeholder}
          aria-label="Add a tag"
          className="min-w-[8rem] flex-1 bg-transparent text-[13px] outline-none"
        />
      </div>
      {offered.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {offered.map((k) => (
            <button key={k} type="button" onClick={() => add(k)} className="border-primary-border text-ink-secondary hover:text-ink-primary rounded border border-dashed px-1.5 py-0.5 font-mono text-[11px]">
              + {k}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

type Shape = Extract<Check, { kind: "asked" }>["shape"]

/** One input's own judge question: what to ask, what comes back, who judges — tried on this input's answers, or moved to every input. */
function JudgedEditor({ item, judge, index, onChange }: { item: JudgedItem; judge: JudgeContext; index: number; onChange: (j: JudgedItem) => void }) {
  const [moving, setMoving] = useState<"idle" | "confirm" | "busy" | { error: string }>("idle")
  const check: Check = { kind: "asked", id: "try", label: item.ask || "question", ask: item.ask, shape: item.shape, ...(item.judge ? { judge: item.judge } : {}) }
  return (
    <div className="space-y-1.5">
      <Inline value={item.ask} data-kind="judged" placeholder="A question about this answer, e.g. Is the tone friendly?" onChange={(e) => onChange({ ...item, ask: e.target.value })} />
      <ShapeEditor shape={item.shape} onChange={(shape) => onChange({ ...item, shape })} />
      <label className="text-ink-tertiary flex items-center gap-1.5 text-[11px]">
        Judge
        <select
          value={item.judge ?? ""}
          onChange={(e) => onChange(e.target.value ? { ...item, judge: e.target.value } : { ask: item.ask, shape: item.shape })}
          className="border-primary-border bg-primary-bg rounded border px-1 py-0.5 font-mono text-[11px]"
        >
          <option value="">{judge.fallback} (default)</option>
          {judge.judges.filter((j) => j !== judge.fallback).map((j) => (
            <option key={j} value={j}>
              {j}
            </option>
          ))}
        </select>
      </label>
      {judge.rubricId && item.ask.trim() && (
        <>
          <TryCheck agent={judge.agent} rubricId={judge.rubricId} datasetId={judge.datasetId} check={check} inputId={judge.inputId} fallback={judge.fallback} />
          {moving === "confirm" ? (
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <span className="text-ink-secondary">Every input's answer will be judged on it from now on.</span>
              <button
                type="button"
                onClick={() => {
                  setMoving("busy")
                  void judge.onPromote(index).then((e) => setMoving(e ? { error: e } : "idle"))
                }}
                className="bg-ink-primary text-primary-bg rounded px-2 py-0.5 font-medium"
              >
                Move it
              </button>
              <button type="button" onClick={() => setMoving("idle")} className="text-ink-tertiary hover:text-ink-primary">
                Cancel
              </button>
            </div>
          ) : (
            <button type="button" disabled={moving === "busy"} onClick={() => setMoving("confirm")} className="text-ink-secondary hover:text-ink-primary block text-[11px] underline underline-offset-2 disabled:opacity-50">
              {moving === "busy" ? "Moving…" : "Use for every input"}
            </button>
          )}
          {typeof moving === "object" && <p className="text-[11px] text-red-600 dark:text-red-400">{moving.error}</p>}
        </>
      )}
    </div>
  )
}
const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")

/**
 * What the judge returns, in JEV's three types: yes/no (noul), one of a set
 * of labels (choice), or a place on an ordered scale (score). A choice starts
 * with an "other" label, as JEV advises when the list may not be exhaustive.
 */
function ShapeEditor({ shape, onChange }: { shape: Shape; onChange: (s: Shape) => void }) {
  const to = (type: Shape["type"]) => {
    if (type === shape.type) return
    if (type === "boolean") onChange({ type: "boolean" })
    else if (type === "choice")
      onChange({ type: "choice", options: { good: "What a good answer looks like", bad: "What a bad one looks like", other: "None of the above" }, bad: ["bad", "other"] })
    else
      onChange({
        type: "score",
        levels: [
          { name: "poor", means: "Fails what was asked" },
          { name: "fair", means: "Partly there" },
          { name: "good", means: "Does what was asked" },
        ],
        bad: 0,
      })
  }
  const tab = (t: Shape["type"], name: string) => (
    <button
      key={t}
      type="button"
      role="radio"
      aria-checked={shape.type === t}
      onClick={() => to(t)}
      className={cn("rounded px-2 py-0.5 font-mono text-[11px]", shape.type === t ? "bg-primary-bg-active text-ink-primary" : "text-ink-tertiary hover:text-ink-primary")}
    >
      {name}
    </button>
  )
  const row = "grid grid-cols-[18px_9rem_minmax(0,1fr)_auto] items-center gap-2"
  const small = "border-primary-border bg-primary-bg rounded border px-1.5 py-0.5 text-xs outline-none focus:border-ink-tertiary"
  return (
    <div className="space-y-1.5">
      <div role="radiogroup" aria-label="The judge returns" className="flex items-center gap-1">
        <span className="text-ink-tertiary mr-1 text-[11px]">The judge returns</span>
        {tab("boolean", "yes/no")}
        {tab("choice", "choice")}
        {tab("score", "score")}
      </div>
      {shape.type === "choice" && (
        <div className="space-y-1">
          {Object.entries(shape.options).map(([id, means], n, all) => {
            const fails = shape.bad.includes(id)
            const set = (nextId: string, nextMeans: string, nextFails: boolean) => {
              const options = Object.fromEntries(all.map(([k, m], i) => (i === n ? [nextId, nextMeans] : [k, m])))
              const bad = all.flatMap(([k], i) => (i === n ? (nextFails ? [nextId] : []) : shape.bad.includes(k) ? [k] : []))
              onChange({ type: "choice", options, bad })
            }
            return (
              <div key={n} className={row}>
                <button type="button" onClick={() => set(id, means, !fails)} title={fails ? "Counts as a fail — make it a pass" : "Counts as a pass — make it a fail"} className={cn("text-xs font-bold", fails ? "text-[color:var(--eval-bad-ink)]" : "text-[color:var(--eval-good-ink)]")}>
                  {fails ? "✕" : "✓"}
                </button>
                <input value={id} onChange={(e) => set(slug(e.target.value) || id, means, fails)} aria-label="Label" className={cn(small, "font-mono")} />
                <input value={means} onChange={(e) => set(id, e.target.value, fails)} aria-label="What it means" placeholder="What it means" className={small} />
                <button type="button" aria-label={`Remove ${id}`} disabled={all.length <= 2} onClick={() => onChange({ type: "choice", options: Object.fromEntries(all.filter((_, i) => i !== n)), bad: shape.bad.filter((b) => b !== id) })} className="text-ink-tertiary hover:text-ink-primary disabled:opacity-30">
                  <X className="size-3.5" />
                </button>
              </div>
            )
          })}
          <button
            type="button"
            onClick={() => {
              let id = "label"
              for (let k = 2; id in shape.options; k++) id = `label_${k}`
              onChange({ ...shape, options: { ...shape.options, [id]: "" } })
            }}
            className="text-ink-secondary hover:text-ink-primary text-[11px]"
          >
            + label
          </button>
          <p className="text-ink-tertiary text-[11px]">The judge picks one. ✓ passes, ✕ fails — click to switch.</p>
        </div>
      )}
      {shape.type === "score" && (
        <div className="space-y-1">
          {shape.levels.map((l, n) => {
            const fails = n <= (shape.bad ?? 0)
            const levels = (next: { name: string; means: string }[]) => onChange({ ...shape, levels: next })
            return (
              <div key={n}>
                <div className={row}>
                  <span className={cn("text-xs font-bold", fails ? "text-[color:var(--eval-bad-ink)]" : "text-[color:var(--eval-good-ink)]")}>{fails ? "✕" : "✓"}</span>
                  <input value={l.name} onChange={(e) => levels(shape.levels.map((x, i) => (i === n ? { ...x, name: slug(e.target.value) || x.name } : x)))} aria-label={`Level ${n + 1}`} className={cn(small, "font-mono")} />
                  <input value={l.means} onChange={(e) => levels(shape.levels.map((x, i) => (i === n ? { ...x, means: e.target.value } : x)))} aria-label="What it means" placeholder="What it means" className={small} />
                  <button type="button" aria-label={`Remove ${l.name}`} disabled={shape.levels.length <= 2} onClick={() => onChange({ ...shape, levels: shape.levels.filter((_, i) => i !== n), bad: Math.min(shape.bad ?? 0, shape.levels.length - 3) })} className="text-ink-tertiary hover:text-ink-primary disabled:opacity-30">
                    <X className="size-3.5" />
                  </button>
                </div>
                {n === (shape.bad ?? 0) && n < shape.levels.length - 1 && (
                  <div className="text-ink-tertiary my-0.5 ml-[26px] flex items-center gap-2 text-[10px]">
                    <i className="bg-ink-tertiary/50 h-px flex-1" /> pass line <i className="bg-ink-tertiary/50 h-px flex-1" />
                  </div>
                )}
              </div>
            )
          })}
          <div className="flex items-center gap-3 text-[11px]">
            <button type="button" onClick={() => onChange({ ...shape, levels: [...shape.levels, { name: `level_${shape.levels.length + 1}`, means: "" }] })} className="text-ink-secondary hover:text-ink-primary">
              + level
            </button>
            <label className="text-ink-tertiary flex items-center gap-1">
              Pass line above
              <select value={shape.bad ?? 0} onChange={(e) => onChange({ ...shape, bad: Number(e.target.value) })} className={cn(small, "font-mono")}>
                {shape.levels.slice(0, -1).map((l, n) => (
                  <option key={n} value={n}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="text-ink-tertiary text-[11px]">Worst first. The judge places the answer on this scale; at or below the pass line fails.</p>
        </div>
      )}
    </div>
  )
}

const AddMenu: { kind: "ask" | "mustnot" | "never"; name: string; hint: string }[] = [
  { kind: "ask", name: "Ask the judge", hint: "A question about every answer — yes/no, one of a set of labels, or a scale" },
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
  datasetId,
  knownTags = [],
  open,
  onClose,
  onSaved,
}: {
  agent: string
  rubricId: string
  /** Whose answers "Try it" grades. */
  datasetId: string | undefined
  /** Tags the inputs use — what a check can be limited to. */
  knownTags?: string[]
  open: boolean
  onClose: () => void
  /** A new version was saved; its checks haven't graded anything yet. */
  onSaved: () => void
}) {
  const [loaded, setLoaded] = useState<{ version: number; defaultJudge: string } | null>(null)
  const [judges, setJudges] = useState<string[]>([])
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
      // Judges that read text: the catalog also lists image, speech and embedding models.
      setJudges(r.judges.filter((id) => !/image|embedding|tts|veo|lyria|realtime|-live|computer-use|deep-research|translate|audio/.test(id)))
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
                      <>
                        <Grow
                          value={c.ask}
                          onChange={(e) => edit(key, { ask: e.target.value })}
                          placeholder={c.shape.type === "boolean" ? "A yes/no question about the answer — phrase it so yes is good" : c.shape.type === "choice" ? "What to decide about the answer, e.g. Where does the answer's substance come from?" : "What to rate, e.g. How long is the answer for what was asked?"}
                          aria-label="Question for the grader"
                        />
                        {c.fromInput ? (
                          // Its questions are each input's own items, each with its own type — nothing to shape here.
                          <p className="text-ink-tertiary text-[11px]">Asks each input's own items — must say, must not say, should decline, and its own judge questions — one by one. Edit them on the inputs.</p>
                        ) : (
                          <>
                            <ShapeEditor shape={c.shape} onChange={(shape) => edit(key, { shape })} />
                            {datasetId && <TryCheck agent={agent} rubricId={rubricId} datasetId={datasetId} check={c} fallback={loaded.defaultJudge} />}
                          </>
                        )}
                      </>
                    ) : c.spec.op === "never_called" ? (
                      <input
                        value={c.spec.tool}
                        onChange={(e) => edit(key, { spec: { op: "never_called", tool: e.target.value } })}
                        placeholder="Tool name — a * matches anything, e.g. *_send_email"
                        aria-label="Tool"
                        className={field}
                      />
                    ) : null}
                    <div className="flex items-start gap-2 text-[11px]">
                      <span className="text-ink-tertiary pt-2">Applies to</span>
                      <div className="min-w-0 flex-1">
                        <TagsEditor tags={c.appliesTo ?? []} known={knownTags} placeholder="Every input — or limit it to tags" onChange={(appliesTo) => edit(key, { appliesTo })} />
                      </div>
                    </div>
                    {c.kind === "asked" && (
                      <label className="text-ink-tertiary flex items-center gap-1.5 text-[11px]">
                        Judge
                        <select
                          value={c.judge ?? ""}
                          onChange={(e) => edit(key, { judge: e.target.value || undefined })}
                          className="border-primary-border bg-primary-bg rounded border px-1 py-0.5 font-mono text-[11px]"
                        >
                          <option value="">{loaded.defaultJudge} (default)</option>
                          {judges.filter((j) => j !== loaded.defaultJudge).map((j) => (
                            <option key={j} value={j}>
                              {j}
                            </option>
                          ))}
                        </select>
                        <span>{(c.judge ?? loaded.defaultJudge).startsWith("jev") ? "fast, decision-only, gives probabilities" : "a chat model — for questions that need more reasoning or context; slower, dearer"}</span>
                      </label>
                    )}
                    {c.kind === "counted" && <p className="text-ink-tertiary text-[11px]">Exact, from the tool log · free</p>}
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
            {loaded && <DescribeCheck agent={agent} rubricId={rubricId} onSent={onClose} />}
            <p className="text-ink-tertiary text-xs">
              For rules that hold everywhere. Anything about one input — its good answer, the tools it should call, what it must say — goes on that input.
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

/**
 * Grade the newest answer to five inputs with this check as it stands —
 * saved or not — to see the labels the judge gives and how sure it is.
 */
function TryCheck({
  agent,
  rubricId,
  datasetId,
  check,
  inputId,
  fallback,
}: {
  agent: string
  rubricId: string
  datasetId: string
  check: Check
  inputId?: string
  /** The checks' default judge, used when the check names none. */
  fallback: string
}) {
  const judge = check.kind === "asked" ? (check.judge ?? fallback) : "rule"
  // A JEV judge is a decision-only call; a chat model reads the whole thread for every answer.
  const cost = judge.startsWith("jev") ? "the judge only, cents" : `judged by ${judge} — a full model call per answer, more than cents`
  const [state, setState] = useState<"idle" | "busy" | { error: string } | Extract<Awaited<ReturnType<typeof tryCheckFn>>, { ok: true }>>("idle")
  const run = async () => {
    setState("busy")
    const r = await tryCheckFn({ data: { agent, rubricId, datasetId, check: JSON.stringify(check), ...(inputId ? { inputId } : {}) } })
    setState(r.ok ? r : { error: r.error })
  }
  return (
    <div className="space-y-1">
      <button type="button" disabled={state === "busy"} onClick={() => void run()} className="text-ink-secondary hover:text-ink-primary text-[11px] underline underline-offset-2 disabled:opacity-50">
        {state === "busy"
          ? "Grading…"
          : typeof state === "object" && "rows" in state
            ? "Try it again"
            : inputId
              ? `Try it on this input's answers · ${cost}`
              : `Try it on 5 answers · ${cost}`}
      </button>
      {typeof state === "object" && "error" in state && <p className="text-[11px] text-red-600 dark:text-red-400">{state.error}</p>}
      {typeof state === "object" && "rows" in state && (
        <ul className="border-primary-border space-y-0.5 border-l-2 pl-2">
          {state.rows.map((r) => (
            <li key={r.threadId} className="grid grid-cols-[14px_minmax(0,1fr)_auto] items-baseline gap-1.5 text-[11px]" title={r.prompt}>
              <span className={r.failed === null ? "text-ink-tertiary" : r.failed ? "text-[color:var(--eval-bad-ink)]" : "text-[color:var(--eval-good-ink)]"}>{r.failed === null ? "–" : r.failed ? "✕" : "✓"}</span>
              <span className="text-ink-secondary truncate">{inputId ? `${r.version}${r.attempt ? ` · try ${r.attempt + 1}` : ""}` : `#${r.inputId} ${r.prompt}`}</span>
              <span className="text-ink-tertiary font-mono tabular-nums">
                {r.answer ?? "not graded"}
                {r.score !== null ? ` · ${r.score.toFixed(1)}` : r.confidence !== null ? ` · ${Math.round(r.confidence * 100)}%` : ""}
              </span>
            </li>
          ))}
          <li className="text-ink-tertiary text-[10px]">Judged by {state.judge} · not saved — the table is unchanged</li>
        </ul>
      )}
    </div>
  )
}

/** Say what to check in words; the Evals agent picks the type, writes the labels, and asks before saving. */
function DescribeCheck({ agent, rubricId, onSent }: { agent: string; rubricId: string; onSent: () => void }) {
  const [text, setText] = useState("")
  const send = () => {
    if (!text.trim()) return
    askEvalsAgent(
      `For ${agent}, checks ${rubricId}: write one check every input gets, for this: "${text.trim()}". Pick what the judge returns — yes/no, choice or score — write its question and labels, then add it with edit_checks for me to approve. Say in one line why that type.`,
    )
    setText("")
    onSent()
  }
  return (
    <div className="border-primary-border space-y-1.5 rounded-lg border border-dashed p-2.5">
      <div className="text-ink-secondary text-xs">Or describe it, and the Evals agent writes it</div>
      <Grow
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault()
            send()
          }
        }}
        placeholder="e.g. whether the answer is too short, about right, or too long for what was asked"
        aria-label="Describe a check"
      />
      <div className="flex items-center gap-2">
        <span className="text-ink-tertiary text-[11px]">It picks yes/no, choice or score, and asks before saving.</span>
        <span className="flex-1" />
        <button type="button" disabled={!text.trim()} onClick={send} className="bg-ink-primary text-primary-bg h-7 rounded-md px-3 text-xs font-medium disabled:opacity-40">
          Write it
        </button>
      </div>
    </div>
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

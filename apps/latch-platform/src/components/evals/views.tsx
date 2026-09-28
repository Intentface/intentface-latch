import { useState } from "react"
import { Plus, X } from "lucide-react"
import { Tabs } from "@intentface/chat/tabs"
import { removeViewFn, saveViewFn } from "@/lib/evals-server"
import { Popover } from "@/components/ui/popover"
import { TagsEditor } from "@/components/evals/inputs"
import { cn } from "@/lib/utils"

export type ViewRow = { id: string; name: string; tags: string[] }

const tab =
  "data-[selected]:bg-primary-bg-active data-[selected]:text-ink-primary text-ink-secondary hover:text-ink-primary group flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--acc)]"

/**
 * The views of a set, as tabs above the table: All, then each saved view — a
 * name and the tags whose inputs it shows. Closing a tab removes the view
 * (the inputs and their answers stay). "+ New view" saves another.
 */
export function ViewTabs({
  agent,
  datasetId,
  views,
  value,
  counts,
  knownTags,
  onChange,
  onSaved,
}: {
  agent: string
  datasetId: string
  views: ViewRow[]
  /** The open view's id, or "all". */
  value: string
  /** Inputs per tab, by id ("all" included). */
  counts: Record<string, number>
  knownTags: string[]
  onChange: (id: string) => void
  onSaved: (id?: string) => void
}) {
  const items = ["all", ...views.map((v) => v.id)]
  const nameOf = (id: string) => (id === "all" ? "All" : (views.find((v) => v.id === id)?.name ?? id))
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Tabs.Root
        items={items}
        onItemsChange={(next) => {
          // A closed tab is a removed view; All can't be closed.
          const gone = items.filter((id) => id !== "all" && !next.includes(id))
          for (const id of gone) void removeViewFn({ data: { agent, datasetId, id } }).then(() => onSaved())
        }}
        value={value}
        onValueChange={(v) => onChange(v ?? "all")}
        selectOnClose="adjacent"
      >
        <Tabs.List aria-label="Views" className="flex flex-wrap items-center gap-1">
          {(id) => (
            <Tabs.Trigger value={id} className={tab} title={id === "all" ? "Every input" : `Inputs tagged ${views.find((v) => v.id === id)?.tags.join(" or ")}`}>
              <span className="font-medium">{nameOf(id)}</span>
              <span className="text-ink-tertiary tabular-nums">{counts[id] ?? 0}</span>
              {id !== "all" && (
                <Tabs.Action>
                  <Tabs.Close aria-label={`Remove the view ${nameOf(id)}`} className="text-ink-tertiary hover:text-ink-primary -mr-1 opacity-0 group-hover:opacity-100 group-data-[selected]:opacity-100">
                    <X className="size-3" />
                  </Tabs.Close>
                </Tabs.Action>
              )}
            </Tabs.Trigger>
          )}
        </Tabs.List>
      </Tabs.Root>
      <NewView agent={agent} datasetId={datasetId} knownTags={knownTags} onSaved={onSaved} />
    </div>
  )
}

function NewView({ agent, datasetId, knownTags, onSaved }: { agent: string; datasetId: string; knownTags: string[]; onSaved: (id?: string) => void }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [tags, setTags] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const save = async () => {
    if (busy) return
    setBusy(true)
    const r = await saveViewFn({ data: { agent, datasetId, name, tags } })
    setBusy(false)
    if (!r.ok) return setError(r.error)
    setOpen(false)
    setName("")
    setTags([])
    setError(null)
    onSaved(r.id)
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Popover.Trigger render={<button type="button" className="text-ink-tertiary hover:text-ink-primary flex h-7 items-center gap-1 rounded-md px-2 text-xs" />}>
        <Plus className="size-3.5" /> New view
      </Popover.Trigger>
      <Popover.Content align="start" className="w-80 space-y-2.5 p-3">
        <div className="text-ink-primary text-sm font-medium">New view</div>
        <p className="text-ink-tertiary text-xs">A tab that shows only some inputs — the ones with any of these tags — and scores each column on them.</p>
        <input
          id="new-view-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name, e.g. PDF evals"
          aria-label="View name"
          className="border-primary-border bg-primary-bg w-full rounded-md border px-2.5 py-1.5 text-[13px] outline-none"
        />
        <TagsEditor tags={tags} known={knownTags} onChange={setTags} placeholder="Tags it shows, e.g. pdf" />
        {knownTags.length === 0 && <p className="text-ink-tertiary text-[11px]">No input has a tag yet — add tags to inputs in their drawer first.</p>}
        {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
        <button type="button" onClick={() => void save()} disabled={busy || !name.trim() || !tags.length} className={cn("bg-ink-primary text-primary-bg h-8 w-full rounded-md text-sm font-medium disabled:opacity-40")}>
          {busy ? "Saving…" : "Save view"}
        </button>
      </Popover.Content>
    </Popover>
  )
}

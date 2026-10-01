import { useEffect, useState } from "react";
import { Check, ChevronDown, Plus } from "lucide-react";
import { Popover } from "@/components/ui/popover";
import type { CandidateSummary } from "@/lib/server";

const ago = (at: number) => {
  const m = Math.round((Date.now() - at) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

/**
 * What the editor is editing: the live version, or one of the agent's
 * candidates — named, unpublished configurations everyone who can edit the
 * agent shares. Typing on live starts a new candidate; nothing goes live
 * until one is published.
 */
export function CandidateSwitcher({
  liveVersion,
  candidates,
  current,
  title,
  saved,
  saveError,
  onPick,
  onNew,
  onRename,
}: {
  liveVersion: number | null;
  candidates: CandidateSummary[];
  /** The candidate being edited; null = looking at live. */
  current: string | null;
  title: string;
  saved: boolean;
  /** Why the last autosave failed, if it did. */
  saveError?: string | null;
  onPick: (id: string | null) => void;
  onNew: () => void;
  onRename: (title: string) => Promise<string | null>;
}) {
  const [open, setOpen] = useState(false);
  const [draftTitle, setDraftTitle] = useState(title);
  const [renameError, setRenameError] = useState<string | null>(null);
  useEffect(() => setDraftTitle(title), [title]);
  const live = liveVersion == null ? "Live" : `Live · v${liveVersion}`;
  const row = "hover:bg-primary-bg-hover flex w-full items-start gap-2 rounded-md px-2.5 py-1.5 text-left text-sm";

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <Popover open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          render={
            <button
              type="button"
              className="border-primary-border bg-primary-bg hover:bg-primary-bg-hover flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-sm"
            />
          }
        >
          {current ? (
            <span className="rounded-full bg-amber-500/15 px-1.5 py-px text-[11px] font-medium text-amber-700 dark:text-amber-400">Candidate</span>
          ) : (
            <span className="rounded-full bg-emerald-500/15 px-1.5 py-px text-[11px] font-medium text-emerald-700 dark:text-emerald-400">Live</span>
          )}
          {/* A candidate's name is the box beside this, where it is renamed. */}
          {!current && liveVersion != null && <span className="text-ink-primary">v{liveVersion}</span>}
          <ChevronDown className="text-ink-tertiary size-3.5" />
        </Popover.Trigger>
        <Popover.Content align="start" className="w-80 p-1">
          <button type="button" className={row} onClick={() => (setOpen(false), onPick(null))}>
            <Check className={`mt-0.5 size-3.5 shrink-0 ${current ? "invisible" : ""}`} />
            <span className="flex flex-col">
              <span className="text-ink-primary">{live}</span>
              <span className="text-ink-tertiary text-xs">What people get now. Editing it starts a candidate.</span>
            </span>
          </button>
          {candidates.length > 0 && <div className="text-ink-tertiary px-2.5 pt-2 pb-0.5 text-[11px]">Candidates</div>}
          {candidates.map((c) => (
            <button key={c.id} type="button" className={row} onClick={() => (setOpen(false), onPick(c.id))}>
              <Check className={`mt-0.5 size-3.5 shrink-0 ${current === c.id ? "" : "invisible"}`} />
              <span className="flex min-w-0 flex-col">
                <span className="text-ink-primary truncate">{c.title}</span>
                <span className="text-ink-tertiary text-xs">
                  {c.mine ? "Yours" : "A teammate's"} · edited {ago(c.updatedAt)}
                  {c.baseVersion != null && liveVersion != null && c.baseVersion !== liveVersion ? ` · from v${c.baseVersion}, live is v${liveVersion}` : ""}
                </span>
              </span>
            </button>
          ))}
          <div className="border-primary-border my-1 border-t" />
          <button type="button" className={row} onClick={() => (setOpen(false), onNew())}>
            <Plus className="mt-0.5 size-3.5 shrink-0" />
            <span className="flex flex-col">
              <span className="text-ink-primary">New candidate</span>
              <span className="text-ink-tertiary text-xs">A copy of live to try something on. Evals can run it as a column.</span>
            </span>
          </button>
        </Popover.Content>
      </Popover>

      {current && (
        <>
          <input
            aria-label="Candidate name"
            value={draftTitle}
            onChange={(e) => (setDraftTitle(e.target.value.slice(0, 48)), setRenameError(null))}
            onBlur={() => void (draftTitle.trim() && draftTitle !== title ? onRename(draftTitle).then(setRenameError) : setDraftTitle(title))}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            className="border-primary-border text-ink-primary h-7 w-48 rounded-md border bg-transparent px-2 text-sm"
          />
          {saveError ? (
            <span className="text-red-600 dark:text-red-400">Not saved — {saveError}</span>
          ) : (
            <span className="text-ink-tertiary">{saved ? "Saved · not live" : "Not live"}</span>
          )}
          {renameError && <span className="text-red-600 dark:text-red-400">{renameError}</span>}
        </>
      )}
    </div>
  );
}

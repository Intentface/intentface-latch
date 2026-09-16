import { useEffect, useState } from "react";
import { Loader2, RotateCcw, X } from "lucide-react";
import type { AgentVersionMeta } from "@intentface/latch-agent-builder";
import type { AgentRecord, AgentScope } from "@/lib/agent-store";
import { diffRecords, fieldLabel, type RecordDiff } from "@/lib/record-diff";
import { DiffView } from "@/components/record-diff-view";
import {
  activateAgentVersionFn,
  getAgentVersionFn,
  listAgentVersionsFn,
} from "@/lib/server";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Publish history for one agent: the version list, a diff of what each version
 * changed, and the two ways back.
 *
 * The two ways back are deliberately different verbs, because they answer
 * different questions:
 *   • "Production is wrong, undo it"  → Make live. Moves the pointer, instant,
 *     appends nothing.
 *   • "Start from that one and edit"  → Restore, which loads it into the draft
 *     and leaves publishing to the user.
 */

const ago = (ms: number): string => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d}d ago`;
};

/** How a version came about, when it wasn't a person in this editor. */
const sourceNote = (source?: string): string | null => {
  if (source === "builder-agent") return "via agent builder";
  if (source === "backfill") return "before version history";
  if (source === "api") return "via API";
  return null;
};

export function AgentVersionsDrawer({
  agent,
  scope,
  open,
  onClose,
  onRestore,
  onActivated,
}: {
  agent: string;
  scope: AgentScope;
  open: boolean;
  onClose: () => void;
  /** Load this version's record into the editor's draft. */
  onRestore: (record: AgentRecord, version: number) => void;
  /** A version was made live — the editor re-reads its status. */
  onActivated: () => void;
}) {
  const [versions, setVersions] = useState<AgentVersionMeta[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [diff, setDiff] = useState<RecordDiff | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setVersions(null);
    setSelected(null);
    setDiff(null);
    listAgentVersionsFn({ data: { name: agent, scope } })
      .then((v) => {
        if (cancelled) return;
        setVersions(v);
        setSelected(v[0]?.version ?? null);
      })
      .catch(() => !cancelled && setError("Couldn't load history."));
    return () => {
      cancelled = true;
    };
  }, [open, agent, scope]);

  // Diffing a version needs BOTH sides, so the one before it is fetched too.
  // v1 has no predecessor and renders as "no changes recorded" rather than as
  // an all-added diff, which would be noise, not information.
  useEffect(() => {
    if (selected == null) return;
    let cancelled = false;
    setDiff(null);
    const load = async () => {
      const [after, before] = await Promise.all([
        getAgentVersionFn({ data: { name: agent, scope, version: selected } }),
        selected > 1
          ? getAgentVersionFn({ data: { name: agent, scope, version: selected - 1 } })
          : Promise.resolve(null),
      ]);
      if (cancelled) return;
      setDiff(diffRecords(before ?? undefined, (after ?? undefined) as Partial<AgentRecord>));
    };
    void load().catch(() => !cancelled && setError("Couldn't load that version."));
    return () => {
      cancelled = true;
    };
  }, [selected, agent, scope]);

  if (!open) return null;

  const restore = async (version: number) => {
    setBusy(true);
    setError(null);
    try {
      const rec = await getAgentVersionFn({ data: { name: agent, scope, version } });
      if (!rec) {
        setError("That version is no longer available.");
        return;
      }
      onRestore(rec as AgentRecord, version);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const makeLive = async (version: number) => {
    setBusy(true);
    setError(null);
    try {
      const res = await activateAgentVersionFn({ data: { name: agent, scope, version } });
      if (!res.ok) {
        setError(res.error ?? "Couldn't make that version live.");
        return;
      }
      const next = await listAgentVersionsFn({ data: { name: agent, scope } });
      setVersions(next);
      onActivated();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-primary-bg smooth-shadow-ring-lg fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col">
      <div className="border-primary-border flex items-center justify-between border-b px-4 py-3">
        <div>
          <h2 className="text-ink-primary text-sm font-semibold">Version history</h2>
          <p className="text-ink-secondary text-xs">{agent}</p>
        </div>
        <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Close">
          <X className="size-4" />
        </Button>
      </div>

      {error && <p className="text-destructive px-4 pt-3 text-xs">{error}</p>}

      <div className="flex-1 overflow-auto px-4 py-3">
        {versions === null ? (
          <Loader2 className="text-ink-secondary size-4 animate-spin" />
        ) : versions.length === 0 ? (
          <p className="text-ink-secondary text-xs">
            No published versions yet. The first time you publish, it lands here.
          </p>
        ) : (
          <ol className="space-y-1">
            {versions.map((v) => {
              const isSelected = v.version === selected;
              const note = sourceNote(v.source);
              return (
                <li key={v.version}>
                  <button
                    type="button"
                    onClick={() => setSelected(v.version)}
                    className={cn(
                      "w-full rounded-lg px-2 py-2 text-left transition-colors",
                      isSelected ? "bg-muted" : "hover:bg-muted/60",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-ink-primary text-xs font-medium">v{v.version}</span>
                      {v.published && (
                        <span className="rounded-full bg-emerald-500/15 px-1.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
                          LIVE
                        </span>
                      )}
                      <span className="text-ink-secondary ml-auto text-[11px]">
                        {ago(v.createdAt)}
                      </span>
                    </div>
                    {v.message && (
                      <p className="text-ink-primary mt-0.5 text-[11px]">{v.message}</p>
                    )}
                    <p className="text-ink-secondary mt-0.5 text-[11px]">
                      {v.changedFields?.length
                        ? v.changedFields.map(fieldLabel).join(", ")
                        : "first version"}
                      {note ? ` · ${note}` : ""}
                    </p>
                  </button>

                  {isSelected && (
                    <div className="space-y-3 px-2 pt-2 pb-3">
                      {diff ? <DiffView diff={diff} /> : <Loader2 className="size-3 animate-spin" />}
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => restore(v.version)}
                        >
                          <RotateCcw className="size-3" /> Restore to draft
                        </Button>
                        {!v.published && (
                          <Button
                            type="button"
                            size="sm"
                            disabled={busy}
                            onClick={() => makeLive(v.version)}
                          >
                            Make live
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}

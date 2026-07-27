import { useEffect, useState } from "react";
import { Loader2, Plus, Sparkles, Trash2, X } from "lucide-react";
import type { AttachedEval } from "@/lib/agent-store";
import {
  draftRubricFn,
  getAgentEvalsFn,
  saveAgentEvalsFn,
} from "@/lib/server";
import { Button } from "@/components/ui/button";

/** localStorage key for the per-agent "Evaluate this agent" toggle (owner-only). */
const toggleKey = (agent: string) => `latch:evals-drawer:${agent}`;

/** Whether the drawer is enabled for this agent (owner opt-in, per browser). */
export function useEvalsDrawerToggle(agent: string) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    setOn(localStorage.getItem(toggleKey(agent)) === "1");
  }, [agent]);
  const set = (next: boolean) => {
    setOn(next);
    localStorage.setItem(toggleKey(agent), next ? "1" : "0");
  };
  return [on, set] as const;
}

const blankRubric = (): AttachedEval => ({
  name: "",
  prompt: "",
  scale: "binary",
  enabled: true,
});

/**
 * The right-side evals drawer: a DRAFT scratchpad over the agent's attached
 * rubrics. Edits/toggles/adds stay local until "Save to agent"; the parent owns
 * the draft so its "Re-evaluate" actions judge against these exact rubrics.
 */
export function EvalsDrawer({
  agent,
  draft,
  setDraft,
  onClose,
  onReevaluate,
  reevaluating,
}: {
  agent: string;
  draft: AttachedEval[];
  setDraft: (evals: AttachedEval[]) => void;
  onClose: () => void;
  /** Re-judge every visible message against the current draft. */
  onReevaluate: () => void;
  reevaluating: boolean;
}) {
  const [saved, setSaved] = useState<AttachedEval[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [quality, setQuality] = useState("");
  const [showAdd, setShowAdd] = useState(false);

  // Load the persisted rubrics once; seed the draft from them.
  useEffect(() => {
    let cancelled = false;
    getAgentEvalsFn({ data: agent })
      .then((res) => {
        if (cancelled) return;
        setSaved(res.evals);
        setDraft(res.evals);
        setLoading(false);
      })
      .catch((e) => {
        // Always clear loading + surface the error, else the drawer is stuck on
        // "Loading rubrics…" forever (plus an unhandled rejection).
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load rubrics.");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);

  const update = (i: number, patch: Partial<AttachedEval>) =>
    setDraft(draft.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const remove = (i: number) => setDraft(draft.filter((_, j) => j !== i));

  const save = async () => {
    setSaving(true);
    setError(null);
    const res = await saveAgentEvalsFn({ data: { agent, evals: draft } });
    setSaving(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setSaved(res.evals);
    setDraft(res.evals);
  };

  const draftWithAI = async () => {
    setDrafting(true);
    setError(null);
    const res = await draftRubricFn({ data: { agent, quality } });
    setDrafting(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setDraft([...draft, ...res.rubrics]);
    setQuality("");
    setShowAdd(false);
  };

  return (
    <aside className="border-secondary-border bg-secondary flex h-full w-80 shrink-0 flex-col border-l">
      <header className="border-secondary-border flex items-center justify-between border-b px-4 py-3">
        <div>
          <div className="text-ink-primary text-sm font-semibold">Evals</div>
          <div className="text-ink-tertiary text-xs">{agent}</div>
        </div>
        <button
          type="button"
          aria-label="Close evals"
          onClick={onClose}
          className="text-ink-tertiary hover:text-ink-primary"
        >
          <X className="size-4" />
        </button>
      </header>

      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {loading && (
          <div className="text-ink-tertiary flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" /> Loading rubrics…
          </div>
        )}

        {!loading && draft.length === 0 && !showAdd && (
          <div className="text-ink-secondary space-y-3 text-sm">
            <p>No evals yet. Add a rubric to score every response against a quality you care about.</p>
          </div>
        )}

        {draft.map((r, i) => (
          <div key={i} className="border-secondary-border bg-primary rounded-lg border p-3">
            <div className="mb-2 flex items-center gap-2">
              <input
                type="checkbox"
                checked={r.enabled}
                onChange={(e) => update(i, { enabled: e.target.checked })}
                aria-label={`Enable ${r.name || "rubric"}`}
              />
              <input
                value={r.name}
                onChange={(e) => update(i, { name: e.target.value })}
                placeholder="kebab-name"
                className="border-secondary-border text-ink-primary min-w-0 flex-1 rounded border bg-transparent px-2 py-1 text-xs"
              />
              <select
                value={r.scale}
                onChange={(e) => update(i, { scale: e.target.value as "binary" | "score" })}
                className="border-secondary-border rounded border bg-transparent px-1 py-1 text-xs"
              >
                <option value="binary">binary</option>
                <option value="score">score</option>
              </select>
              <button
                type="button"
                aria-label="Remove rubric"
                onClick={() => remove(i)}
                className="text-ink-tertiary hover:text-ink-primary"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
            <textarea
              value={r.prompt}
              onChange={(e) => update(i, { prompt: e.target.value })}
              placeholder="What one observable quality should a good response have?"
              rows={3}
              className="border-secondary-border text-ink-primary w-full resize-none rounded border bg-transparent p-2 text-xs"
            />
          </div>
        ))}

        {showAdd ? (
          <div className="border-secondary-border bg-primary space-y-2 rounded-lg border p-3">
            <div className="text-ink-secondary text-xs">Describe the quality to measure; AI drafts the rubric.</div>
            <textarea
              value={quality}
              onChange={(e) => setQuality(e.target.value)}
              placeholder="e.g. stays on the agent's topic and refuses off-scope asks"
              rows={2}
              className="border-secondary-border text-ink-primary w-full resize-none rounded border bg-transparent p-2 text-xs"
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={draftWithAI} disabled={drafting || !quality.trim()}>
                {drafting ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                Draft
              </Button>
              <Button size="sm" variant="outline" onClick={() => setDraft([...draft, blankRubric()])}>
                Blank
              </Button>
              <button
                type="button"
                onClick={() => setShowAdd(false)}
                className="text-ink-tertiary hover:text-ink-primary ml-auto text-xs"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            className="border-secondary-border text-ink-secondary hover:bg-primary-hover flex w-full items-center justify-center gap-1 rounded-lg border border-dashed py-2 text-xs"
          >
            <Plus className="size-3.5" /> Add rubric
          </button>
        )}

        {error && <p className="text-xs text-red-500">{error}</p>}
      </div>

      <footer className="border-secondary-border space-y-2 border-t p-4">
        <Button
          size="sm"
          variant="outline"
          className="w-full"
          onClick={onReevaluate}
          disabled={reevaluating || draft.length === 0}
        >
          {reevaluating && <Loader2 className="mr-1 size-3.5 animate-spin" />}
          Re-evaluate messages
        </Button>
        <Button size="sm" className="w-full" onClick={save} disabled={saving || !dirty}>
          {saving && <Loader2 className="mr-1 size-3.5 animate-spin" />}
          {dirty ? "Save to agent" : "Saved"}
        </Button>
        {dirty && <p className="text-ink-tertiary text-center text-xs">Unsaved draft — affects only re-evaluate until saved.</p>}
      </footer>
    </aside>
  );
}

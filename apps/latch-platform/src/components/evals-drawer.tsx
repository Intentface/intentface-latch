import { useEffect, useState } from "react";
import { Loader2, Plus, Sparkles, Trash2, X } from "lucide-react";
import type { AttachedEval } from "@/lib/agent-store";
import { validateTrigger } from "@/lib/observability/trigger";
import type { EvalTrigger } from "@/lib/observability/trigger";
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

// ── Trigger presets: the form face of the structural trigger DSL ────────────
// The common conditions are a select + number + checkbox; anything the form
// can't express round-trips through the "custom" JSON field untouched.

type TriggerPreset = "always" | "first" | "turnN" | "everyN" | "custom";

const isDepthOptIn = (t: EvalTrigger): boolean =>
  t.kind === "depth" && t.gte === 0 && t.eq === undefined && t.lte === undefined;

/** Recognize a bare form-shaped turn leaf (exactly one comparator, no extras). */
function turnPresetOf(t: EvalTrigger): { preset: TriggerPreset; n: number } | null {
  if (t.kind !== "turn") return null;
  const { eq, gte, lte, everyNth } = t;
  if (eq !== undefined && gte === undefined && lte === undefined && everyNth === undefined) {
    return { preset: eq === 1 ? "first" : "turnN", n: eq };
  }
  if (everyNth !== undefined && eq === undefined && gte === undefined && lte === undefined) {
    return { preset: "everyN", n: everyNth };
  }
  return null;
}

/** Map a stored trigger back to form state; unrecognized shapes → "custom". */
function presetOf(t: EvalTrigger | undefined): {
  preset: TriggerPreset;
  n: number;
  subagents: boolean;
} {
  if (!t) return { preset: "always", n: 1, subagents: false };
  if (isDepthOptIn(t)) return { preset: "always", n: 1, subagents: true };
  const bare = turnPresetOf(t);
  if (bare) return { ...bare, subagents: false };
  if (t.kind === "all" && t.of.length === 2 && isDepthOptIn(t.of[1])) {
    const inner = turnPresetOf(t.of[0]);
    if (inner) return { ...inner, subagents: true };
  }
  return { preset: "custom", n: 1, subagents: false };
}

/** Build the trigger a form state means; "always at the top level" → undefined. */
function triggerFor(preset: TriggerPreset, n: number, subagents: boolean): EvalTrigger | undefined {
  const base: EvalTrigger | undefined =
    preset === "first"
      ? { kind: "turn", eq: 1 }
      : preset === "turnN"
        ? { kind: "turn", eq: Math.max(1, Math.round(n) || 1) }
        : preset === "everyN"
          ? { kind: "turn", everyNth: Math.max(1, Math.round(n) || 1) }
          : undefined;
  if (!subagents) return base;
  const depth: EvalTrigger = { kind: "depth", gte: 0 };
  return base ? { kind: "all", of: [base, depth] } : depth;
}

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
  // Raw text of per-rubric "custom" trigger JSON while it's being edited —
  // the draft only takes a trigger once the text parses.
  const [customJson, setCustomJson] = useState<Record<number, string | undefined>>({});

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
  const remove = (i: number) => {
    setDraft(draft.filter((_, j) => j !== i));
    // Indices shift — drop in-progress custom JSON rather than misattach it.
    setCustomJson({});
  };

  const setPreset = (i: number, r: AttachedEval, preset: TriggerPreset, n: number, subagents: boolean) => {
    if (preset === "custom") {
      const seed = r.trigger ?? { kind: "turn", eq: 1 };
      setCustomJson({ ...customJson, [i]: JSON.stringify(seed) });
      update(i, { trigger: seed });
      return;
    }
    setCustomJson((prev) => {
      const next = { ...prev };
      delete next[i];
      return next;
    });
    update(i, { trigger: triggerFor(preset, n, subagents) });
  };

  // A custom trigger must parse AND pass the DSL validator (trigger.ts is
  // dependency-free, so it runs client-side) — a structurally wrong value
  // would otherwise land in the draft silently and only error at Save time.
  const parseCustom = (text: string): EvalTrigger | null => {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
    return validateTrigger(value) === null ? (value as EvalTrigger) : null;
  };

  const setCustomText = (i: number, text: string) => {
    setCustomJson({ ...customJson, [i]: text });
    if (!text.trim()) {
      update(i, { trigger: undefined });
      return;
    }
    const trigger = parseCustom(text);
    // Invalid → keep the last valid trigger; the field shows the error state.
    if (trigger) update(i, { trigger });
  };

  const customInvalid = (i: number): boolean => {
    const text = customJson[i];
    if (text === undefined || !text.trim()) return false;
    return parseCustom(text) === null;
  };

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

        {draft.map((r, i) => {
          const isCustom = customJson[i] !== undefined || presetOf(r.trigger).preset === "custom";
          const form = presetOf(r.trigger);
          return (
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
            <div className="text-ink-tertiary mt-2 flex flex-wrap items-center gap-2 text-xs">
              <span>When</span>
              <select
                value={isCustom ? "custom" : form.preset}
                onChange={(e) =>
                  setPreset(i, r, e.target.value as TriggerPreset, form.n, form.subagents)
                }
                aria-label="When the judge runs"
                className="border-secondary-border rounded border bg-transparent px-1 py-0.5"
              >
                <option value="always">every turn</option>
                <option value="first">first turn</option>
                <option value="turnN">turn №</option>
                <option value="everyN">every Nth turn</option>
                <option value="custom">custom (JSON)</option>
              </select>
              {!isCustom && (form.preset === "turnN" || form.preset === "everyN") && (
                <input
                  type="number"
                  min={1}
                  value={form.n}
                  onChange={(e) =>
                    setPreset(i, r, form.preset, Number(e.target.value), form.subagents)
                  }
                  aria-label="Turn number"
                  className="border-secondary-border w-14 rounded border bg-transparent px-1 py-0.5"
                />
              )}
              {!isCustom && (
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={form.subagents}
                    onChange={(e) => setPreset(i, r, form.preset, form.n, e.target.checked)}
                  />
                  subagents
                </label>
              )}
              <span className="ml-auto">Sees</span>
              <select
                value={r.context ?? "turn"}
                onChange={(e) =>
                  update(i, {
                    context:
                      e.target.value === "turn"
                        ? undefined
                        : (e.target.value as "chat" | "loop"),
                  })
                }
                aria-label="What the judge sees"
                className="border-secondary-border rounded border bg-transparent px-1 py-0.5"
              >
                <option value="turn">this turn</option>
                <option value="chat">whole chat</option>
                <option value="loop">full loop</option>
              </select>
            </div>
            {isCustom && (
              <textarea
                value={customJson[i] ?? JSON.stringify(r.trigger ?? null)}
                onChange={(e) => setCustomText(i, e.target.value)}
                placeholder='e.g. {"kind":"all","of":[{"kind":"turn","gte":2},{"kind":"toolCalled","name":"spawn_agent"}]}'
                rows={2}
                aria-label="Custom trigger JSON"
                className={`mt-2 w-full resize-none rounded border bg-transparent p-2 font-mono text-xs ${
                  customInvalid(i) ? "border-red-500" : "border-secondary-border"
                } text-ink-primary`}
              />
            )}
          </div>
          );
        })}

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

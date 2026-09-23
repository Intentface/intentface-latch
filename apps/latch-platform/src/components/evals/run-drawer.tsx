import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { estimateRunFn, getRunOptionsFn, startRunFn } from "@/lib/evals-server";
import type { Estimate } from "@/lib/evals/v2/jobs";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import Drawer from "@/components/ui/drawer";
import { EDITOR_DRAWER, Field } from "@/components/evals/shell";

/**
 * Starting a run costs real money, so the drawer leads with the bill: what
 * it will run, what that cost last time, and a start button that names the
 * amount. It defaults to a few questions once — enough to see whether a
 * change does anything before paying to measure how much.
 */

type Options = NonNullable<Awaited<ReturnType<typeof getRunOptionsFn>>>;
type Scope = "few" | "all" | "pick";
const FEW = 3;

export function RunDrawer({
  open,
  agent,
  datasetId,
  rubricId,
  onClose,
  onStarted,
}: {
  open: boolean;
  agent: string;
  datasetId: string;
  rubricId: string;
  onClose: () => void;
  onStarted: (jobId: string) => void;
}) {
  const [options, setOptions] = useState<Options | null>(null);
  const [versions, setVersions] = useState<string[]>([]);
  const [scope, setScope] = useState<Scope>("few");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [repeats, setRepeats] = useState(1);
  const [estimate, setEstimate] = useState<{ estimate: Estimate; same: string[]; confirmTwiceAbove: number } | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [sure, setSure] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setOptions(null);
    setError(null);
    void getRunOptionsFn({ data: { agent, datasetId } }).then((o) => {
      setOptions(o);
      // Live against the draft is the comparison worth paying for; live alone otherwise.
      if (o) setVersions(o.versions.some((v) => v.label === "@draft") ? ["live", "@draft"] : ["live"]);
    });
  }, [open, agent, datasetId]);

  const inputIds = useMemo(() => {
    const all = options?.questions.map((q) => q.id) ?? [];
    return scope === "all" ? all : scope === "few" ? all.slice(0, FEW) : all.filter((id) => picked.has(id));
  }, [options, scope, picked]);

  // Re-price whenever the selection changes; a stale price must never be the one confirmed.
  useEffect(() => {
    if (!open || !options) return;
    setEstimate(null);
    setSure(false);
    if (!versions.length || !inputIds.length) return;
    setEstimating(true);
    const t = setTimeout(() => {
      void estimateRunFn({ data: { agent, datasetId, rubricId, versions, inputIds, repeats } })
        .then((r) => {
          if (r.ok) (setEstimate(r), setError(null));
          else setError(r.error);
        })
        .finally(() => setEstimating(false));
    }, 250);
    return () => clearTimeout(t);
  }, [open, options, agent, datasetId, rubricId, versions, inputIds, repeats]);

  const cost = estimate?.estimate.cost ?? null;
  const twice = cost !== null && estimate && cost > estimate.confirmTwiceAbove;
  const canStart = !!estimate && !estimating && !starting && (!twice || sure);

  const start = async () => {
    if (!estimate) return;
    setStarting(true);
    setError(null);
    const r = await startRunFn({ data: { agent, datasetId, rubricId, versions, inputIds, repeats, confirmedCost: cost } });
    setStarting(false);
    if (!r.ok) return setError(r.error);
    onStarted(r.id);
  };

  const shownQuestions = (options?.questions ?? []).filter(
    (q) => !filter.trim() || `${q.id} ${q.prompt}`.toLowerCase().includes(filter.trim().toLowerCase()),
  );

  return (
    <Drawer open={open} onOpenChange={(o) => !o && onClose()}>
      <Drawer.Content className={EDITOR_DRAWER}>
        <div className="flex h-full flex-col">
          <Drawer.Header className="border-primary-border border-b px-5">
            <Drawer.Title className="text-ink-primary">New run</Drawer.Title>
            <Drawer.Description className="text-ink-tertiary text-xs">
              Runs the agent on each question, then judges every thread. Tools that take actions are simulated, never performed.
            </Drawer.Description>
          </Drawer.Header>

          {!options ? (
            <div className="p-5">
              <Loader2 className="text-ink-tertiary size-4 animate-spin" />
            </div>
          ) : (
            <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-4">
              <Field id="run-versions" label="Versions" hint="Two versions on the same questions is a comparison; one is a measurement.">
                <div id="run-versions" className="space-y-1">
                  {options.versions.map((v) => (
                    <label key={v.label} className="hover:bg-primary-bg-hover flex cursor-pointer items-baseline gap-2.5 rounded-md px-2 py-1.5 text-sm">
                      <input
                        type="checkbox"
                        checked={versions.includes(v.label)}
                        onChange={(e) => setVersions(e.target.checked ? [...versions, v.label] : versions.filter((x) => x !== v.label))}
                      />
                      <span className="text-ink-primary font-medium">{v.label}</span>
                      {v.note && <span className="text-ink-tertiary truncate text-xs">{v.note}</span>}
                    </label>
                  ))}
                </div>
              </Field>

              <Field id="run-scope" label="Questions">
                <div id="run-scope" className="space-y-1 text-sm">
                  {(
                    [
                      ["few", `The first ${Math.min(FEW, options.questions.length)}`, "Cheap. Enough to see whether a change does anything at all."],
                      ["all", `All ${options.questions.length}`, "What it takes to tell a real change from chance."],
                      ["pick", "Choose", "The ones a change is meant to fix, or the ones that failed."],
                    ] as const
                  ).map(([value, label, hint]) => (
                    <label key={value} className="hover:bg-primary-bg-hover flex cursor-pointer items-baseline gap-2.5 rounded-md px-2 py-1.5">
                      <input type="radio" name="run-scope" checked={scope === value} onChange={() => setScope(value)} />
                      <span className="text-ink-primary font-medium">{label}</span>
                      <span className="text-ink-tertiary text-xs">{hint}</span>
                    </label>
                  ))}
                </div>
                {scope === "pick" && (
                  <div className="smooth-shadow-ring-xs smooth-ring-primary-border mt-2 rounded-lg">
                    <div className="border-primary-border flex items-center gap-2 border-b p-2">
                      <Input id="run-filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter" className="h-7 flex-1" />
                      <span className="text-ink-tertiary text-xs tabular-nums">{picked.size} chosen</span>
                    </div>
                    <ul className="max-h-56 overflow-y-auto py-1">
                      {shownQuestions.map((q) => (
                        <li key={q.id}>
                          <label className="hover:bg-primary-bg-hover flex cursor-pointer items-baseline gap-2 px-2.5 py-1 text-sm">
                            <input
                              type="checkbox"
                              checked={picked.has(q.id)}
                              onChange={(e) => {
                                const next = new Set(picked);
                                if (e.target.checked) next.add(q.id);
                                else next.delete(q.id);
                                setPicked(next);
                              }}
                            />
                            <span className="text-ink-tertiary w-6 shrink-0 text-xs tabular-nums">{q.id}</span>
                            <span className="text-ink-primary line-clamp-1">{q.prompt}</span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </Field>

              <Field id="run-repeats" label="Tries per question" hint="The same agent answers differently each time. One try per question cannot tell a change from that noise; three can.">
                <div id="run-repeats" role="radiogroup" className="smooth-shadow-ring-xs smooth-ring-primary-border inline-flex rounded-lg p-0.5">
                  {[1, 2, 3, 5].map((n) => (
                    <button
                      key={n}
                      type="button"
                      role="radio"
                      aria-checked={repeats === n}
                      onClick={() => setRepeats(n)}
                      className={cn(
                        "min-w-10 rounded-md px-3 py-1 text-sm tabular-nums",
                        repeats === n ? "bg-primary-bg-active text-ink-primary font-medium" : "text-ink-secondary hover:text-ink-primary",
                      )}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </Field>
            </div>
          )}

          <div className="border-primary-border space-y-3 border-t px-5 py-4">
            <Bill estimate={estimate} estimating={estimating} empty={!versions.length || !inputIds.length} />
            {twice && (
              <label className="text-ink-primary flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-0.5" checked={sure} onChange={(e) => setSure(e.target.checked)} />
                <span>I understand this will spend about ${cost.toFixed(2)}.</span>
              </label>
            )}
            {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
            <div className="flex items-center justify-end gap-2">
              <button type="button" onClick={onClose} className="text-ink-secondary hover:text-ink-primary px-3 py-1.5 text-sm">
                Cancel
              </button>
              <button
                type="button"
                disabled={!canStart}
                onClick={() => void start()}
                className="bg-ink-primary text-primary-bg rounded-md px-3 py-1.5 text-sm font-medium tabular-nums disabled:opacity-50"
              >
                {starting ? "Starting…" : cost === null ? "Start run" : `Start run · about $${cost.toFixed(2)}`}
              </button>
            </div>
          </div>
        </div>
      </Drawer.Content>
    </Drawer>
  );
}

function Bill({ estimate, estimating, empty }: { estimate: { estimate: Estimate; same: string[] } | null; estimating: boolean; empty: boolean }) {
  if (empty) return <p className="text-ink-tertiary text-sm">Pick at least one version and one question.</p>;
  if (!estimate || estimating)
    return (
      <p className="text-ink-tertiary flex items-center gap-2 text-sm">
        <Loader2 className="size-3.5 animate-spin" /> Working out the cost…
      </p>
    );
  const e = estimate.estimate;
  return (
    <div className="space-y-1 text-sm">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-ink-primary tabular-nums">
          {e.agentRuns} agent run{e.agentRuns === 1 ? "" : "s"} · {e.judgeCalls} judge call{e.judgeCalls === 1 ? "" : "s"}
        </span>
        <span className="text-ink-primary text-[15px] font-semibold tabular-nums">{e.cost === null ? "Unknown" : `about $${e.cost.toFixed(2)}`}</span>
      </div>
      <p className="text-ink-tertiary text-xs">{e.basis} Judge calls are not included.</p>
      {estimate.same.length > 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          {estimate.same.join(" and ")} {estimate.same.length === 1 ? "is" : "are"} the same configuration as another version you picked. Comparing them measures noise, not a change.
        </p>
      )}
    </div>
  );
}

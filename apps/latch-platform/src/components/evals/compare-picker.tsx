import { ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover } from "@/components/ui/popover";

/**
 * Pick the results to compare: any version from any run of this question set.
 * One is the baseline; the others are compared against it question by
 * question. Picking a whole run compares its versions with each other — the
 * fairest comparison, since everything but the agent was held fixed.
 */

export type Result = { runId: string; version: string };
export type RunInfo = {
  runId: string;
  versions: string[];
  questions: number;
  tries: number;
  name: string | null;
  createdAt: number;
};

/** `runId|version` pairs, comma-separated — how the choice travels in the URL. */
export const encodeResults = (rs: Result[]) => rs.map((r) => `${r.runId}|${r.version}`).join(",");
export const decodeResults = (s: string | undefined): Result[] =>
  (s ?? "")
    .split(",")
    .map((p) => p.split("|"))
    .filter((p): p is [string, string] => p.length === 2 && !!p[0] && !!p[1])
    .map(([runId, version]) => ({ runId, version }));

const same = (a: Result, b: Result) => a.runId === b.runId && a.version === b.version;

export function ComparePicker({
  runs,
  selected,
  labels,
  runLabel,
  onChange,
}: {
  runs: RunInfo[];
  /** What the grid is showing now, baseline first. */
  selected: Result[];
  /** The grid's names for the selected columns, in the same order. */
  labels: string[];
  runLabel: (r: RunInfo) => string;
  /** A new choice, baseline first; a run id alone means "that run's versions". */
  onChange: (next: { results: Result[] } | { run: string }) => void;
}) {
  const toggle = (r: Result) => {
    const has = selected.some((s) => same(s, r));
    const next = has ? selected.filter((s) => !same(s, r)) : [...selected, r];
    if (next.length) onChange({ results: next });
  };
  const makeBaseline = (r: Result) => onChange({ results: [r, ...selected.filter((s) => !same(s, r))] });

  return (
    <Popover>
      <Popover.Trigger
        render={
          <button
            type="button"
            className="border-primary-border bg-primary-bg text-ink-primary hover:bg-primary-bg-hover flex h-8 max-w-[28rem] items-center gap-2 rounded-lg border px-2.5 text-sm"
          />
        }
      >
        <span className="truncate">{labels.join(" vs ") || "Pick results"}</span>
        <ChevronsUpDown className="text-ink-tertiary size-3.5 shrink-0" />
      </Popover.Trigger>
      <Popover.Content align="start" className="w-[26rem] p-0">
        <div className="border-primary-border border-b px-3 py-2.5">
          <div className="text-ink-primary text-sm font-medium">Compare results</div>
          <p className="text-ink-tertiary mt-0.5 text-xs">
            Tick any versions from any runs. The baseline is what the others are measured against, on the questions both answered.
          </p>
        </div>
        <ul className="max-h-96 overflow-y-auto py-1">
          {runs.map((run) => (
            <li key={run.runId} className="px-1.5 py-1">
              <div className="flex items-center gap-2 px-1.5 py-1">
                <span className="text-ink-secondary min-w-0 flex-1 truncate text-xs font-medium">{runLabel(run)}</span>
                <button
                  type="button"
                  onClick={() => onChange({ run: run.runId })}
                  className="text-ink-tertiary hover:text-ink-primary shrink-0 text-xs underline-offset-2 hover:underline"
                >
                  Just this run
                </button>
              </div>
              {run.versions.map((version) => {
                const r = { runId: run.runId, version };
                const at = selected.findIndex((s) => same(s, r));
                const on = at >= 0;
                return (
                  <div key={version} className="hover:bg-primary-bg-hover flex items-center gap-2 rounded-md px-1.5 py-1 text-sm">
                    <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                      <input type="checkbox" checked={on} onChange={() => toggle(r)} disabled={on && selected.length === 1} />
                      <span className={cn("truncate", on ? "text-ink-primary" : "text-ink-secondary")}>{version}</span>
                    </label>
                    {on &&
                      (at === 0 ? (
                        <span className="text-ink-primary shrink-0 text-xs font-medium">Baseline</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => makeBaseline(r)}
                          className="text-ink-tertiary hover:text-ink-primary shrink-0 text-xs underline-offset-2 hover:underline"
                        >
                          Make baseline
                        </button>
                      ))}
                  </div>
                );
              })}
            </li>
          ))}
        </ul>
      </Popover.Content>
    </Popover>
  );
}

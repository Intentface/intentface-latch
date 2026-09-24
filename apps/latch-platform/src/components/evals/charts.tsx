import { useMemo, useState } from "react";
import type { EvalGrid, RunPoint } from "@/lib/evals-server";
import { cn } from "@/lib/utils";
import { passColor } from "@/components/evals/ui";

// ─── Questions × checks ────────────────────────────────────────────────────

/**
 * Where each question fails: questions down, checks across (one column per
 * version under each check), each cell the question's pass rate for that
 * check on that version. A rate says how often; this says which questions —
 * a row that is red across the board is a question the agent cannot answer,
 * a column that is red is a check nothing passes.
 */
export function QuestionHeatmap({ grid, onOpen }: { grid: EvalGrid; onOpen: (c: { checkId: string; version: string }) => void }) {
  const rows = useMemo(() => {
    const byQ = new Map<string, { prompt: string; cells: Map<string, { passed: number; total: number }> }>();
    for (const v of grid.verdicts) {
      const q = byQ.get(v.inputId) ?? byQ.set(v.inputId, { prompt: v.prompt, cells: new Map() }).get(v.inputId)!;
      const k = `${v.checkId}|${v.version}`;
      const c = q.cells.get(k) ?? q.cells.set(k, { passed: 0, total: 0 }).get(k)!;
      c.total += 1;
      if (!v.failed) c.passed += 1;
    }
    return [...byQ]
      .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
      .map(([id, q]) => ({ id, ...q }));
  }, [grid]);
  const single = grid.attempts === 1;

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] table-fixed border-separate border-spacing-[2px] text-xs tabular-nums">
        <colgroup>
          <col className="w-[16rem]" />
          {grid.checks.flatMap((c) => grid.versions.map((v) => <col key={`${c.id}|${v}`} />))}
        </colgroup>
        <thead>
          <tr>
            <th className="bg-primary-bg sticky left-0 z-10" />
            {grid.checks.map((c) => (
              <th
                key={c.id}
                colSpan={grid.versions.length}
                className="text-ink-secondary min-w-24 px-1 pb-1 text-left align-bottom font-medium"
                title={c.sentence}
              >
                <span className="line-clamp-2">{c.label}</span>
              </th>
            ))}
          </tr>
          <tr>
            <th className="bg-primary-bg text-ink-tertiary sticky left-0 z-10 pr-3 pb-1 text-left font-normal">Question</th>
            {grid.checks.flatMap((c) =>
              grid.versions.map((v) => (
                <th key={`${c.id}|${v}`} className="text-ink-tertiary pb-1 text-center font-normal">
                  {v}
                </th>
              )),
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <th scope="row" className="bg-primary-bg sticky left-0 z-10 pr-3 text-left font-normal" title={r.prompt}>
                <span className="line-clamp-2">
                  <span className="text-ink-tertiary mr-1.5">#{r.id}</span>
                  <span className="text-ink-primary">{r.prompt}</span>
                </span>
              </th>
              {grid.checks.flatMap((c) =>
                grid.versions.map((v) => {
                  const cell = r.cells.get(`${c.id}|${v}`);
                  if (!cell) return <td key={`${c.id}|${v}`} className="text-ink-tertiary bg-primary-bg-hover h-8 rounded-[3px] text-center">—</td>;
                  const rate = cell.passed / cell.total;
                  const label = single ? (rate === 1 ? "pass" : "fail") : `${Math.round(rate * 100)}%`;
                  return (
                    <td key={`${c.id}|${v}`} className="h-8 p-0">
                      <button
                        type="button"
                        onClick={() => onOpen({ checkId: c.id, version: v })}
                        title={`#${r.id} · ${c.label} · ${v}: ${cell.passed} of ${cell.total} passed`}
                        className="text-ink-primary focus-visible:ring-ring h-8 w-full rounded-[3px] outline-none hover:brightness-95 focus-visible:ring-2 dark:hover:brightness-125"
                        style={{ background: passColor(rate) }}
                      >
                        {label}
                      </button>
                    </td>
                  );
                }),
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="text-ink-tertiary mt-3 flex items-center gap-2 text-xs">
        <span>Fails</span>
        <span className="h-2 w-40 rounded-full" style={{ background: "linear-gradient(90deg, var(--eval-bad), var(--eval-mid), var(--eval-good))" }} />
        <span>Passes</span>
        <span className="ml-2">{single ? "One try per question." : `Share of ${grid.attempts} tries that passed.`} Click a cell to read its threads.</span>
      </div>
    </div>
  );
}

// ─── Pass rate vs cost ─────────────────────────────────────────────────────

const W = 720;
const H = 320;
const PAD = { l: 48, r: 24, t: 16, b: 40 };

function niceTicks(max: number, n = 5) {
  const step = Math.pow(10, Math.floor(Math.log10(max / n)));
  const unit = [1, 2, 2.5, 5, 10].map((m) => m * step).find((s) => max / s <= n) ?? step * 10;
  return Array.from({ length: Math.ceil(max / unit) + 1 }, (_, i) => +(i * unit).toFixed(6));
}

/**
 * Every version in every run of this question set, placed by what a thread
 * cost and how often its verdicts passed. Up and to the left is better; the
 * dotted line joins the runs nothing beat on both at once.
 */
export function CostChart({ points, current }: { points: RunPoint[]; current?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const priced = points.filter((p): p is RunPoint & { costPerThread: number } => p.costPerThread !== null);
  if (!priced.length) return <p className="text-ink-tertiary text-sm">No run of this set has cost data yet.</p>;

  // Fit both axes to the data, with a margin: empty range is wasted ink.
  const costs = priced.map((p) => p.costPerThread);
  const rates = priced.map((p) => p.passRate);
  const span = Math.max(...costs) - Math.min(...costs) || Math.max(...costs) * 0.5;
  const allTicks = niceTicks(Math.max(...costs) + span * 0.25);
  const xLo = Math.max(0, Math.min(...costs) - span * 0.25);
  const xTicks = allTicks.filter((t, i) => t >= xLo || allTicks[i + 1] > xLo);
  const xMin = xTicks[0];
  const xMax = xTicks[xTicks.length - 1];
  const yMin = Math.max(0, Math.floor((Math.min(...rates) - 0.1) * 10) / 10);
  const yMax = Math.min(1, Math.ceil((Math.max(...rates) + 0.1) * 10) / 10);
  const yTicks = Array.from({ length: Math.round((yMax - yMin) * 10) + 1 }, (_, i) => +(yMin + i * 0.1).toFixed(2));
  const x = (c: number) => PAD.l + ((c - xMin) / (xMax - xMin)) * (W - PAD.l - PAD.r);
  const y = (r: number) => PAD.t + (1 - (r - yMin) / (yMax - yMin)) * (H - PAD.t - PAD.b);
  // Pareto: cheapest first, keep each point that passes more than every cheaper one.
  const frontier: typeof priced = [];
  for (const p of [...priced].sort((a, b) => a.costPerThread - b.costPerThread || b.passRate - a.passRate))
    if (!frontier.length || p.passRate > frontier[frontier.length - 1].passRate) frontier.push(p);
  const versions = [...new Set(priced.map((p) => p.version))];
  const tone = (v: string) => (v === "live" ? "var(--color-ink-secondary)" : v === "@draft" ? "var(--color-accent)" : "var(--color-ink-tertiary)");
  const h = hover === null ? null : priced[hover];

  return (
    <div className="relative">
      <div className="text-ink-secondary mb-2 flex flex-wrap items-center gap-4 text-xs">
        {versions.map((v) => (
          <span key={v} className="flex items-center gap-1.5">
            <span
              className="inline-block size-2.5 rounded-full border-2"
              style={v === "live" || v === "@draft" ? { background: tone(v), borderColor: tone(v) } : { borderColor: tone(v) }}
            />
            {v}
          </span>
        ))}
        <span className="flex items-center gap-1.5">
          <svg width="18" height="4" aria-hidden>
            <line x1="0" y1="2" x2="18" y2="2" stroke="currentColor" strokeWidth="2" strokeDasharray="2 3" />
          </svg>
          Best for its cost
        </span>
        <span className="text-ink-tertiary">Bigger point: this run</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Pass rate against cost per thread, one point per version per run">
        {yTicks.map((t, i) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="var(--color-primary-border)" strokeDasharray={i === 0 ? undefined : "2 4"} />
            <text x={PAD.l - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize="11" fill="var(--color-ink-tertiary)">
              {Math.round(t * 100)}%
            </text>
          </g>
        ))}
        {xTicks.map((t) => (
          <text key={t} x={x(t)} y={H - PAD.b + 18} textAnchor="middle" fontSize="11" fill="var(--color-ink-tertiary)">
            ${t.toFixed(t < 0.1 ? 3 : 2)}
          </text>
        ))}
        <text x={(PAD.l + W - PAD.r) / 2} y={H - 4} textAnchor="middle" fontSize="11" fill="var(--color-ink-secondary)">
          Cost per thread
        </text>
        {frontier.length > 1 && (
          <polyline
            points={frontier.map((p) => `${x(p.costPerThread)},${y(p.passRate)}`).join(" ")}
            fill="none"
            stroke="var(--color-ink-tertiary)"
            strokeWidth="1.5"
            strokeDasharray="2 4"
          />
        )}
        {priced.map((p, i) => (
          <g key={`${p.runId}|${p.version}`} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} className="cursor-default">
            {/* A generous hit target; the mark itself stays small. */}
            <circle cx={x(p.costPerThread)} cy={y(p.passRate)} r="14" fill="transparent" />
            <circle
              cx={x(p.costPerThread)}
              cy={y(p.passRate)}
              r={p.runId === current ? 6 : 4.5}
              fill={p.version === "live" || p.version === "@draft" ? tone(p.version) : "var(--color-primary-bg)"}
              stroke={p.version === "live" || p.version === "@draft" ? "var(--color-primary-bg)" : tone(p.version)}
              strokeWidth="2"
              opacity={hover === null || hover === i ? 1 : 0.35}
            />
          </g>
        ))}
      </svg>
      {h && (
        <div
          className={cn("border-primary-border bg-primary-bg pointer-events-none absolute z-10 rounded-md border px-2.5 py-1.5 text-xs shadow-sm")}
          style={{ left: `${(x(h.costPerThread) / W) * 100}%`, top: `${(y(h.passRate) / H) * 100}%`, transform: "translate(-50%, calc(-100% - 12px))" }}
        >
          <div className="text-ink-primary font-medium">
            {h.version} · {new Date(h.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
          </div>
          <div className="text-ink-secondary tabular-nums">
            {Math.round(h.passRate * 100)}% of {h.verdicts} verdicts passed · ${h.costPerThread.toFixed(3)} a thread · {h.threads} threads
          </div>
        </div>
      )}
    </div>
  );
}

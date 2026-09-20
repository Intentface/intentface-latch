import { useState } from "react";
import type { EvalRun } from "@/lib/evals/store";

/**
 * Configurations compared the way a model benchmark is read: quality against
 * what it cost to get.
 *
 * Quality alone ranks nothing. A configuration that scores two points higher
 * for four times the money is a different decision from one that scores the
 * same for half, and a column of pass rates cannot express that. So the two
 * measures share one plot and the table underneath carries the detail.
 *
 * Form notes, since they are easy to get wrong:
 *  - ONE series. Every point is a configuration of the same agent, so there is
 *    no categorical palette to assign and nothing to validate — identity comes
 *    from a direct label, which is also more legible than a legend at this size.
 *  - The table is the workhorse. At three runs a scatter is sparse; it earns
 *    its place by showing the TRADEOFF, which a sorted column cannot.
 *  - Cheaper and better is up-and-left, and the plot says so once rather than
 *    making every reader work out which way is good.
 */

const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
const money = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : `${(n * 100).toFixed(1)}¢`);
const secs = (ms: number) => (ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}m` : `${(ms / 1000).toFixed(0)}s`);
const compact = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

interface Point {
  run: EvalRun;
  label: string;
  rate: number;
  cost: number;
  total: number;
  /** Nothing scores as well for as little — worth considering. */
  frontier: boolean;
  /** The configuration that beats it on BOTH quality and cost, if one does. */
  beatenBy?: string;
}

/**
 * Dominance, which is the verdict a two-axis benchmark exists to produce.
 *
 * A reader can rank a column. What they cannot do by eye is answer "is this
 * one worth it?", and the answer is often simply no: a configuration another
 * one beats on quality AND cost is not a tradeoff, it is a mistake, and saying
 * so beats leaving it as an exercise. Everything not dominated is on the
 * frontier — those are the real choices, and they are genuine tradeoffs.
 */
const pointsOf = (runs: EvalRun[]): Point[] => {
  const base = runs.map((run) => {
    const total = run.passCount + run.failCount;
    return {
      run,
      label: run.configRef ?? "live",
      rate: total ? run.passCount / total : 0,
      cost: run.metrics?.agentCost ?? 0,
      total,
      frontier: false,
    };
  });
  return base.map((p) => {
    // Only meaningful once cost was measured; without it nothing dominates.
    const beats =
      p.cost > 0
        ? base.filter(
            (o) =>
              o !== p &&
              o.cost > 0 &&
              o.rate >= p.rate &&
              o.cost <= p.cost &&
              (o.rate > p.rate || o.cost < p.cost),
          )
        : [];
    const best = [...beats].sort((a, b) => b.rate - a.rate || a.cost - b.cost)[0];
    return { ...p, frontier: p.cost > 0 && beats.length === 0, beatenBy: best?.label };
  });
};

export function EvalBenchmark({ runs }: { runs: EvalRun[] }) {
  const [hovered, setHovered] = useState<string | null>(null);
  const points = pointsOf([...runs].sort((a, b) => a.createdAt - b.createdAt));
  if (points.length === 0) return null;
  // Runs recorded before cost was captured have nothing to show. A column of
  // em-dashes reads as broken rather than as "not measured yet", so the
  // columns appear only once something can fill them.
  const measured = points.some((p) => p.run.metrics);

  const best = Math.max(...points.map((p) => p.rate));
  const cheapest = Math.min(...points.filter((p) => p.cost > 0).map((p) => p.cost), Infinity);
  const plottable = points.filter((p) => p.cost > 0);

  return (
    <section className="space-y-3">
      <div className="flex items-baseline gap-2">
        <h3 className="text-ink-secondary text-[11px] font-medium uppercase tracking-wide">Configurations</h3>
        <span className="text-ink-tertiary text-xs">
          what each one scored, and what it cost to find out
        </span>
      </div>

      <div className={`grid gap-3 ${plottable.length >= 2 ? "lg:grid-cols-[minmax(0,1fr)_minmax(0,320px)]" : ""}`}>
        <BenchTable
          points={points}
          best={best}
          cheapest={cheapest}
          measured={measured}
          hovered={hovered}
          onHover={setHovered}
        />
        {plottable.length >= 2 ? (
          <TradeoffPlot points={plottable} hovered={hovered} onHover={setHovered} />
        ) : null}
      </div>
    </section>
  );
}

function BenchTable({
  points,
  best,
  cheapest,
  measured,
  hovered,
  onHover,
}: {
  points: Point[];
  best: number;
  cheapest: number;
  measured: boolean;
  hovered: string | null;
  onHover: (id: string | null) => void;
}) {
  return (
    <div className={`border-secondary-border overflow-x-auto rounded border ${measured ? "" : "max-w-2xl"}`}>
      <table className="w-full text-xs tabular-nums">
        <thead>
          <tr className="border-secondary-border text-ink-tertiary border-b text-left">
            <th className="p-2 font-normal">configuration</th>
            <th className="p-2 text-right font-normal">
              passed <Higher />
            </th>
            {measured && (
              <>
                <th className="p-2 text-right font-normal">
                  agent cost <Lower />
                </th>
                <th className="p-2 text-right font-normal">judging</th>
                <th className="p-2 text-right font-normal">
                  time <Lower />
                </th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {points.map((p) => {
            const m = p.run.metrics;
            return (
              <tr
                key={p.run.id}
                onMouseEnter={() => onHover(p.run.id)}
                onMouseLeave={() => onHover(null)}
                className={`border-secondary-border border-b last:border-0 ${
                  hovered === p.run.id ? "bg-secondary-bg" : ""
                }`}
              >
                <td className="text-ink-primary p-2">
                  {p.label}
                  {p.beatenBy && (
                    <span
                      className="border-uncertain/50 bg-uncertain-muted text-uncertain-ink ml-2 rounded border px-1 py-px text-[9px] font-semibold uppercase tracking-wide"
                      title={`${p.beatenBy} passed at least as many checks for no more money`}
                    >
                      beaten by {p.beatenBy}
                    </span>
                  )}
                  <span className="text-ink-tertiary ml-2">
                    {new Date(p.run.createdAt).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </td>
                <td className="p-2">
                  {/* A bar, because the column's job is comparison and a
                      column of percentages makes the eye do arithmetic. It
                      runs from zero — this is a rate, and a fitted axis on a
                      bar is the lie the scatter is allowed to avoid.
                      Rate and count stay together: 100% of three cases and
                      91% of a hundred are not the same claim. */}
                  <div className="flex items-center justify-end gap-2">
                    <div className="bg-secondary-bg h-2 w-24 shrink-0 overflow-hidden rounded-sm">
                      <div
                        className={`h-full rounded-sm ${
                          p.rate >= best ? "bg-pass" : "bg-ink-tertiary/40"
                        }`}
                        style={{ width: `${Math.max(p.rate * 100, p.rate > 0 ? 2 : 0)}%` }}
                      />
                    </div>
                    <span
                      className={`w-9 text-right ${p.rate >= best ? "text-pass-ink" : "text-ink-primary"}`}
                    >
                      {pct(p.rate)}
                    </span>
                    <span className="text-ink-tertiary w-10 text-right">
                      {p.run.passCount}/{p.total}
                    </span>
                  </div>
                </td>
                {measured && (
                  <>
                    <td className="p-2 text-right">
                      <span
                        className={
                          p.cost > 0 && p.cost <= cheapest ? "text-pass-ink" : "text-ink-primary"
                        }
                      >
                        {p.cost > 0 ? money(p.cost) : "—"}
                      </span>
                    </td>
                    <td className="text-ink-tertiary p-2 text-right">
                      {m ? `${m.judgeCalls} calls · ${compact(m.judgeTokensIn)} tok` : "—"}
                    </td>
                    <td className="text-ink-tertiary p-2 text-right">{m ? secs(m.durationMs) : "—"}</td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Pass rate against agent cost.
 *
 * Three things here exist because the first render was wrong:
 *
 *  - The y-axis FITS THE DATA rather than starting at zero. A working suite
 *    scores 75-100%, so a 0-100% axis spends two thirds of the plot on empty
 *    space and squashes the only variation anyone cares about. Both ends are
 *    labelled, which is what keeps a fitted axis honest.
 *  - Labels FLIP to the left of their mark in the right third, or the longest
 *    configuration name runs off the frame.
 *  - Labels NUDGE vertically off each other. Two configurations that score the
 *    same for nearly the same money are the interesting case, and they are
 *    exactly the case that lands two labels on top of each other.
 */
function TradeoffPlot({
  points,
  hovered,
  onHover,
}: {
  points: Point[];
  hovered: string | null;
  onHover: (id: string | null) => void;
}) {
  const W = 320;
  const H = 200;
  const pad = { t: 22, r: 14, b: 30, l: 40 };

  const costs = points.map((p) => p.cost);
  const lo = Math.min(...costs);
  const hi = Math.max(...costs);
  const span = hi - lo || hi || 1;
  const xMin = Math.max(0, lo - span * 0.25);
  const xMax = hi + span * 0.25;

  // Fit the rate axis to the data, with a floor so a single point still has a
  // plot around it, and never a domain of zero height.
  const rates = points.map((p) => p.rate);
  const rLo = Math.min(...rates);
  const rHi = Math.max(...rates);
  const rSpan = Math.max(rHi - rLo, 0.08);
  const yMin = Math.max(0, rLo - rSpan * 0.35);
  const yMax = Math.min(1, rHi + rSpan * 0.35);

  const x = (c: number) => pad.l + ((c - xMin) / (xMax - xMin)) * (W - pad.l - pad.r);
  const y = (r: number) => pad.t + (1 - (r - yMin) / (yMax - yMin)) * (H - pad.t - pad.b);

  // Greedy vertical nudge: walk marks top-down and push any label that would
  // sit within 11px of the one above it.
  const laid = [...points]
    .map((p) => ({ p, cx: x(p.cost), cy: y(p.rate) }))
    .sort((a, b) => a.cy - b.cy)
    .reduce<{ p: Point; cx: number; cy: number; ly: number }[]>((acc, m) => {
      const prev = acc[acc.length - 1];
      const ly = prev && m.cy - prev.ly < 11 ? prev.ly + 11 : m.cy;
      acc.push({ ...m, ly });
      return acc;
    }, []);

  return (
    <figure className="border-secondary-border relative m-0 rounded border p-2">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label="Pass rate against agent cost per configuration"
      >
        {[yMin, (yMin + yMax) / 2, yMax].map((r, i) => (
          <g key={i}>
            <line
              x1={pad.l}
              x2={W - pad.r}
              y1={y(r)}
              y2={y(r)}
              className="stroke-secondary-border"
              strokeWidth={1}
            />
            <text x={pad.l - 6} y={y(r) + 3} textAnchor="end" className="fill-ink-tertiary text-[9px]">
              {pct(r)}
            </text>
          </g>
        ))}

        <text x={pad.l} y={11} className="fill-ink-tertiary text-[9px]">
          ← cheaper · better ↑
        </text>
        <text x={pad.l} y={H - 8} className="fill-ink-tertiary text-[9px]">
          {money(xMin)}
        </text>
        <text x={W - pad.r} y={H - 8} textAnchor="end" className="fill-ink-tertiary text-[9px]">
          {money(xMax)}
        </text>

        {/* The frontier: everything on it is a real choice, everything below
            is beaten outright. Drawn once so the reader does not have to
            recompute it per point. */}
        {(() => {
          const f = points.filter((p) => p.frontier).sort((a, b) => a.cost - b.cost);
          if (f.length < 2) return null;
          return (
            <polyline
              points={f.map((p) => `${x(p.cost)},${y(p.rate)}`).join(" ")}
              fill="none"
              className="stroke-pass"
              strokeWidth={1.5}
              strokeDasharray="3 2"
            />
          );
        })()}

        {laid.map(({ p, cx, cy, ly }) => {
          const on = hovered === p.run.id;
          const flip = cx > W * 0.62;
          return (
            <g
              key={p.run.id}
              onMouseEnter={() => onHover(p.run.id)}
              onMouseLeave={() => onHover(null)}
              className="cursor-default"
            >
              <circle cx={cx} cy={cy} r={14} fill="transparent" />
              {/* A leader only when the label had to move, so the plot stays
                  quiet in the common case. */}
              {Math.abs(ly - cy) > 1 && (
                <line
                  x1={cx}
                  y1={cy}
                  x2={flip ? cx - 8 : cx + 8}
                  y2={ly - 3}
                  className="stroke-secondary-border"
                  strokeWidth={1}
                />
              )}
              <circle
                cx={cx}
                cy={cy}
                r={on ? 6 : 4.5}
                className={p.frontier ? "fill-pass stroke-card" : "fill-card stroke-ink-tertiary"}
                strokeWidth={2}
              />
              <text
                x={flip ? cx - 9 : cx + 9}
                y={ly}
                textAnchor={flip ? "end" : "start"}
                className={`text-[9px] ${on ? "fill-ink-primary" : "fill-ink-secondary"}`}
              >
                {p.label}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className="text-ink-tertiary px-1 pb-1 text-[10px]">
        pass rate vs agent cost · axis fitted to the data · filled marks are on the frontier, hollow
        ones are beaten by a cheaper, better configuration
      </figcaption>
    </figure>
  );
}


/** Which direction is good, said once in the header rather than per row. */
const Higher = () => (
  <span className="text-ink-tertiary/70 text-[9px]" title="higher is better" aria-label="higher is better">
    ▲
  </span>
);
const Lower = () => (
  <span className="text-ink-tertiary/70 text-[9px]" title="lower is better" aria-label="lower is better">
    ▼
  </span>
);

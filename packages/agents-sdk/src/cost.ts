/**
 * cost.ts — spend tracking and a hard ceiling, as one extension.
 *
 * Two moments do all the work. `step_end` prices what a step used; `step_start`
 * refuses to begin a step that would overrun. The check goes BEFORE the model
 * call rather than after, because a limit you only notice once you have blown
 * through it is a report, not a limit.
 *
 * Cached input is priced separately. Most providers bill a cache read at a
 * fraction of the normal input rate and a cache write at a premium, so pricing
 * that only looks at `inputTokens` overcharges every cached turn — which on a
 * long agent conversation is most of them.
 *
 * Unpriced models are a deliberate stopping point, not a free pass. If a limit
 * is set and a step runs on a model with no price, the spend cannot be known,
 * so the run stops. Set `unpriced: "free"` to opt out of that.
 */
import { defineExtension, type Extension, type StepInfo, type StepUsage } from "./extension.js";

/** Price per MILLION tokens, in whatever currency unit you are counting. */
export interface ModelPrice {
  input: number;
  output: number;
  /** Defaults to `input`, i.e. no cache discount. */
  cacheRead?: number;
  /** Defaults to `input`, i.e. no cache-write premium. */
  cacheWrite?: number;
}

export interface Spend {
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  steps: number;
}

export interface SpendReport extends Spend {
  runId: string;
  /** Includes `startingSpend`, so this is what a limit is compared against. */
  cumulative: number;
  /** What is left of the ceiling. `undefined` when no limit is set. Never below zero. */
  remaining?: number;
  /** Models seen in this run that had no price. */
  unpriced: string[];
  /** Set when the run was stopped by the limit rather than finishing. */
  stoppedByLimit?: boolean;
}

export interface CostOptions {
  /**
   * Prices by model id. Lookup is exact first, then the longest matching
   * prefix, so `"claude-sonnet-5"` covers `"claude-sonnet-5-20260101"`.
   */
  pricing: Record<string, ModelPrice>;
  /** Stop before any step that would push cumulative spend over this. */
  limit?: number;
  /** Spend already on the clock: a monthly budget, an org total, a per-user tally. */
  startingSpend?: number | (() => number | Promise<number>);
  /** Show the running cost to the reader. The model never sees it. */
  notify?: boolean | ((s: Spend) => string | undefined);
  /** Called after every step and once when the run ends. Persist your tally here. */
  onSpend?: (report: SpendReport) => void | Promise<void>;
  /** What an unpriced model means. Default `"stop"` when a limit is set, else `"free"`. */
  unpriced?: "stop" | "free";
  /** Fail the run on a bookkeeping error rather than reporting and carrying on. */
  critical?: boolean;
  /**
   * Distinguishes one budget from another in error reports. Layered ceilings —
   * an org limit and a per-user limit — are two instances of this extension, and
   * both would otherwise report as `cost`.
   */
  name?: string;
}

const PER_MILLION = 1_000_000;

/** Exact match, then the longest prefix, so a dated model id inherits its family price. */
export function priceFor(
  pricing: Record<string, ModelPrice>,
  modelId: string,
): ModelPrice | undefined {
  const exact = Object.prototype.hasOwnProperty.call(pricing, modelId) ? pricing[modelId] : undefined;
  if (exact) return exact;
  let best: ModelPrice | undefined;
  let bestLen = 0;
  for (const [key, price] of Object.entries(pricing))
    if (modelId.startsWith(key) && key.length > bestLen) {
      best = price;
      bestLen = key.length;
    }
  return best;
}

/**
 * What one step costs. Cache reads and writes are removed from the plain input
 * count first, so a token is never billed twice.
 */
export function costOfStep(usage: StepUsage, price: ModelPrice): number {
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const plainInput = Math.max(0, (usage.inputTokens ?? 0) - cacheRead - cacheWrite);
  const readRate = price.cacheRead ?? price.input;
  const writeRate = price.cacheWrite ?? price.input;
  return (
    (plainInput * price.input +
      cacheRead * readRate +
      cacheWrite * writeRate +
      (usage.outputTokens ?? 0) * price.output) /
    PER_MILLION
  );
}

/**
 * Only for display. Costs are NOT rounded in the report: rounding each write
 * makes the error compound in a ledger that accumulates over thousands of
 * turns. Callers format at the edge.
 */
const display = (n: number) => n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");

export function costTracking(options: CostOptions): Extension {
  const unpriced = options.unpriced ?? (options.limit !== undefined ? "stop" : "free");

  return defineExtension(
    options.name ?? "cost",
    (ext) => {
      const spend: Spend = {
        cost: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        steps: 0,
      };
      const unpricedModels = new Set<string>();
      let starting: number | undefined;
      let stoppedByLimit = false;

      const cumulative = () => (starting ?? 0) + spend.cost;

      const report = (runId: string): SpendReport => ({
        ...spend,
        runId,
        cumulative: cumulative(),
        ...(options.limit === undefined
          ? {}
          : { remaining: Math.max(0, options.limit - cumulative()) }),
        unpriced: [...unpricedModels],
        ...(stoppedByLimit ? { stoppedByLimit: true } : {}),
      });

      // Resolve the starting balance once, before the first step, so a budget
      // that lives elsewhere is read exactly one time per run.
      ext.on("before_agent_start", async () => {
        const s = options.startingSpend;
        starting = typeof s === "function" ? await s() : (s ?? 0);
        return undefined;
      });

      ext.on("step_start", () => {
        if (options.limit === undefined) return undefined;
        // Refuse to start a step we already cannot afford. Checking after the
        // call would let a single step overrun by any amount.
        if (cumulative() >= options.limit) {
          stoppedByLimit = true;
          return { stop: true };
        }
        if (unpriced === "stop" && unpricedModels.size) {
          stoppedByLimit = true;
          return { stop: true };
        }
        return undefined;
      });

      ext.on("step_end", async (_messages, info: StepInfo) => {
        const price = priceFor(options.pricing, info.model.modelId);
        if (!price) unpricedModels.add(info.model.modelId);

        spend.steps += 1;
        spend.inputTokens += info.usage.inputTokens ?? 0;
        spend.outputTokens += info.usage.outputTokens ?? 0;
        spend.cacheReadTokens += info.usage.cacheReadTokens ?? 0;
        spend.cacheWriteTokens += info.usage.cacheWriteTokens ?? 0;
        if (price) spend.cost += costOfStep(info.usage, price);

        await options.onSpend?.(report(info.runId));

        if (!options.notify) return undefined;
        const text =
          typeof options.notify === "function"
            ? options.notify({ ...spend })
            : `${spend.steps} step${spend.steps === 1 ? "" : "s"} · ${spend.inputTokens + spend.outputTokens} tokens` +
              (spend.cacheReadTokens ? ` (${spend.cacheReadTokens} cached)` : "") +
              ` · ${display(spend.cost)}`;
        return text == null ? undefined : { append: [{ type: "data-cost", data: text } as never] };
      });

      ext.on("agent_end", async ({ runId }) => {
        await options.onSpend?.(report(runId));
      });
    },
    { critical: options.critical ?? false },
  ) as Extension;
}

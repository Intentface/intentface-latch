import type { TurnTrigger } from "./telemetry.js";

/**
 * Limits — per org / user / agent budgets on turns, tokens and cost.
 *
 * The split is the same as every other seam: the HOST decides which counters a
 * turn counts against and what the caps are (`limitsFor` — derived from the
 * principal, the agent and how the turn started), and where the counters live
 * (`LimitStore`, a table the drizzle package implements). The RUNTIME counts
 * and enforces:
 *
 *   • admission — before a turn opens, the turn is RESERVED: one atomic
 *     increment of every policy's turn counter that returns the new count. The
 *     first policy whose count is now over its cap refuses the turn with
 *     {@link LimitExceededError} (the HTTP handler maps it to 429 +
 *     Retry-After) and the reservation is released. Increment-then-check means
 *     N concurrent requests against a one-turn cap get counts 1..N and exactly
 *     one is admitted — there is no read-then-write window to race through.
 *     Token and cost caps are checked against usage already settled; an
 *     in-flight turn's spend lands at settlement, so those caps can be
 *     overshot by at most the concurrent in-flight turns (bounded further by
 *     the mid-turn stop).
 *   • mid-turn — the tool loop stops once this turn's tokens reach the
 *     tightest remaining token budget (the model's last text is kept; no
 *     further steps run). Without this a single long agentic turn could blow
 *     through a whole day's budget after being admitted at 99%.
 *   • settlement — tokens and cost are added to every policy's counter when
 *     the turn finishes (resumes and subagent turns included).
 *
 * Windows are fixed, aligned to the epoch: `windowStart = floor(now / windowMs)
 * * windowMs`. Fixed windows are what people expect from "per day" / "per
 * hour", cost one row per (key, window) and need no sliding-log storage. A
 * refusal says when the window turns over.
 */

/** One limit: a counter, a time window and the caps within it. */
export interface LimitPolicy {
  /**
   * The counter's name. Runs that return the same key share one counter, so
   * name the level in it: `org:o1` for a whole organization, `user:o1:u1` for
   * one person, `agent:o1:research` for one agent.
   */
  key: string;
  /**
   * How long one window lasts, in ms: `HOUR_MS`, `DAY_MS`, or your own.
   * Windows are fixed, not rolling: a daily limit resets at midnight UTC.
   */
  windowMs: number;
  /** The caps within one window. Leave a cap out for no limit on it. */
  max: {
    /**
     * Runs started. Safe under load: many requests at once can't all slip
     * through. A resumed run doesn't count again; a subagent run does.
     */
    turns?: number;
    /**
     * Input plus output tokens. A run that reaches the limit part-way stops
     * there and keeps the answer so far. Runs already in progress can take
     * the total over by what they spend.
     */
    tokens?: number;
    /**
     * Cost, in the currency of your `pricing`. Like `tokens`, runs already in
     * progress can take it over. Always 0 without `pricing`.
     */
    cost?: number;
  };
  /**
   * How the refusal names this limit to the user, for example
   * `"your organization's daily token budget"`.
   */
  label?: string;
}

/** What has been counted against one policy in the current window. */
export interface LimitUsage {
  turns: number;
  tokens: number;
  cost: number;
}

export interface LimitWindowRef {
  key: string;
  windowStart: number;
  windowMs: number;
}

/**
 * Counter storage — one row per (key, window). Both methods must be atomic per
 * row (the drizzle implementation upserts with `SET n = n + excluded.n`).
 */
export interface LimitStore {
  /** Current usage for each window ref; absent rows read as zero. */
  read(refs: LimitWindowRef[]): Promise<Record<string, LimitUsage>>;
  /**
   * Add usage to each window (creating the row) and return each window's usage
   * AFTER the add, keyed by `usageKey`. Atomic per row and the returned value
   * must be the row's post-increment state (`INSERT … ON CONFLICT DO UPDATE …
   * RETURNING`): admission reserves a turn with it. Partial usage: omitted
   * fields add 0; negative values release a reservation.
   */
  add(entries: (LimitWindowRef & { usage: Partial<LimitUsage> })[]): Promise<Record<string, LimitUsage>>;
  /** Drop windows that ended before `before` (retention; called by `runtime.cron()`). */
  prune?(before: number): Promise<void>;
}

/** The limits seam as `createRuntime({ limits })` takes it. */
/** What `limits` in the runtime config takes. */
export interface LatchLimits<P> {
  /**
   * Where the counters are kept: `createPostgresLimitStore` or
   * `createSqliteLimitStore` from `@intentface/latch-drizzle`.
   */
  store: LimitStore;
  /**
   * Returns the limits this run counts against. Called before every run, so
   * keep it fast; reading the customer's plan from a cache is fine. Return
   * `[]` for no limits.
   *
   * A typical setup returns one limit per level: the organization's monthly
   * tokens, the user's daily requests, and a tighter budget for an expensive
   * agent. `trigger` lets background runs (schedules, webhooks) count against
   * different limits from people chatting.
   */
  limitsFor(input: {
    /** Who the run is for. */
    principal: P;
    /** The agent being run, by name. */
    agent: string;
    /** How the run started: a chat message, a schedule, a resumed run, and so on. */
    trigger: TurnTrigger;
  }): LimitPolicy[] | Promise<LimitPolicy[]>;
  /**
   * Called when a run is refused for being over a limit. For metrics and
   * alerts; it must not throw.
   */
  onRefused?(input: {
    principal: P;
    agent: string;
    trigger: TurnTrigger;
    /** The limit that refused the run. */
    policy: LimitPolicy;
    /** What had been used in the current window. */
    usage: LimitUsage;
    /** How long until the window resets, in ms. */
    retryAfterMs: number;
  }): void | Promise<void>;
}

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** The start of the fixed window containing `now`. */
export const windowStartOf = (now: number, windowMs: number): number =>
  Math.floor(now / windowMs) * windowMs;

/** `LimitWindowRef` for a policy at `now`. */
export const windowRef = (policy: LimitPolicy, now: number): LimitWindowRef => ({
  key: policy.key,
  windowStart: windowStartOf(now, policy.windowMs),
  windowMs: policy.windowMs,
});

/**
 * Map key for one window in `LimitStore.read`'s result. The window LENGTH is
 * part of it: the same counter key may carry a per-hour and a per-day policy,
 * and their aligned windows share a start on the hour.
 */
export const usageKey = (ref: LimitWindowRef): string =>
  `${ref.key}@${ref.windowStart}/${ref.windowMs}`;

const ZERO: LimitUsage = { turns: 0, tokens: 0, cost: 0 };

/**
 * Thrown (and mapped to HTTP 429) when a turn is refused at admission.
 * `code` is stable so hosts can match it structurally.
 */
export class LimitExceededError extends Error {
  readonly code = "limit_exceeded" as const;
  constructor(
    readonly policy: LimitPolicy,
    readonly usage: LimitUsage,
    /** Milliseconds until the window turns over and the budget resets. */
    readonly retryAfterMs: number,
  ) {
    const what = policy.label ?? `the ${describeWindow(policy.windowMs)} limit for ${policy.key}`;
    super(`Limit reached: ${what}. Try again in ${describeDuration(retryAfterMs)}.`);
    this.name = "LimitExceededError";
  }
}

export function isLimitExceededError(e: unknown): e is LimitExceededError {
  return (e as { code?: string } | null)?.code === "limit_exceeded";
}

/**
 * Admission decision over usage that ALREADY includes this turn's reservation
 * (`nextTurn: false`), or over settled usage when the turn is to be counted on
 * top (`nextTurn: true`). Returns the first exhausted policy, or null when every
 * budget has room.
 */
export function exceededPolicy(
  policies: LimitPolicy[],
  usage: Record<string, LimitUsage>,
  now: number,
  opts: { nextTurn: boolean },
): { policy: LimitPolicy; usage: LimitUsage; retryAfterMs: number } | null {
  for (const policy of policies) {
    const ref = windowRef(policy, now);
    const u = usage[usageKey(ref)] ?? ZERO;
    const turns = u.turns + (opts.nextTurn ? 1 : 0);
    const over =
      (policy.max.turns !== undefined && turns > policy.max.turns) ||
      (policy.max.tokens !== undefined && u.tokens >= policy.max.tokens) ||
      (policy.max.cost !== undefined && u.cost >= policy.max.cost);
    if (over) return { policy, usage: u, retryAfterMs: ref.windowStart + ref.windowMs - now };
  }
  return null;
}

/**
 * The tightest remaining token budget across policies (for the mid-turn stop),
 * or undefined when no policy caps tokens.
 */
export function remainingTokens(
  policies: LimitPolicy[],
  usage: Record<string, LimitUsage>,
  now: number,
): number | undefined {
  let min: number | undefined;
  for (const policy of policies) {
    if (policy.max.tokens === undefined) continue;
    const u = usage[usageKey(windowRef(policy, now))] ?? ZERO;
    const left = Math.max(0, policy.max.tokens - u.tokens);
    min = min === undefined ? left : Math.min(min, left);
  }
  return min;
}

function describeWindow(ms: number): string {
  if (ms % DAY_MS === 0) return ms === DAY_MS ? "daily" : `${ms / DAY_MS}-day`;
  if (ms % HOUR_MS === 0) return ms === HOUR_MS ? "hourly" : `${ms / HOUR_MS}-hour`;
  if (ms % MINUTE_MS === 0) return ms === MINUTE_MS ? "per-minute" : `${ms / MINUTE_MS}-minute`;
  return `${Math.round(ms / 1000)}s`;
}

function describeDuration(ms: number): string {
  const s = Math.ceil(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.ceil(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.ceil(m / 60);
  if (h < 36) return `${h} h`;
  return `${Math.ceil(h / 24)} d`;
}

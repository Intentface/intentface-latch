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
 *   • admission — before a turn opens, every policy is read for its current
 *     window; the first exhausted one refuses the turn with
 *     {@link LimitExceededError} (the HTTP handler maps it to 429 + Retry-After).
 *     The turn itself is counted at admission, so concurrent turns can't all
 *     squeeze through a nearly-full window.
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

/** One counter a turn counts against, plus its caps in the window. */
export interface LimitPolicy {
  /** Stable counter key — e.g. `org:o1`, `user:o1:u1`, `agent:o1:support`. Name the scope in it. */
  key: string;
  /** Fixed window length in ms (see `MINUTE_MS` … `DAY_MS`). */
  windowMs: number;
  /** Caps within one window. An omitted cap is unlimited. */
  max: {
    /** Turns admitted (a resume doesn't count; a subagent turn does). */
    turns?: number;
    /** Input + output tokens. */
    tokens?: number;
    /** Cost in the pricing seam's currency (0 when no pricing is configured). */
    cost?: number;
  };
  /** How a refusal names this budget to the user, e.g. "your organization's daily token budget". */
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
  /** Add usage to each window (creating the row). Partial usage: omitted fields add 0. */
  add(entries: (LimitWindowRef & { usage: Partial<LimitUsage> })[]): Promise<void>;
  /** Drop windows that ended before `before` (retention; called by `runtime.cron()`). */
  prune?(before: number): Promise<void>;
}

/** The limits seam as `createRuntime({ limits })` takes it. */
export interface LatchLimits<P> {
  store: LimitStore;
  /**
   * The counters this turn counts against. Empty → unlimited. Called per turn
   * (admission), so it may read a policy table; keep it cheap.
   */
  limitsFor(input: {
    principal: P;
    /** The agent ref as resolved for the turn. */
    agent: string;
    trigger: TurnTrigger;
  }): LimitPolicy[] | Promise<LimitPolicy[]>;
  /** A turn was refused. For metrics/alerts; must not throw. */
  onRefused?(input: {
    principal: P;
    agent: string;
    trigger: TurnTrigger;
    policy: LimitPolicy;
    usage: LimitUsage;
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

/** Storage key for a (key, window) pair in `LimitStore.read`'s result. */
export const usageKey = (ref: LimitWindowRef): string => `${ref.key}@${ref.windowStart}`;

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
 * Admission decision. `nextTurn` = the turn being admitted counts as one more
 * (`false` for a resume, which was admitted when it first ran). Returns the
 * first exhausted policy, or null when every budget has room.
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

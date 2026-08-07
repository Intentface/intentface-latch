/**
 * Memory-sweep tuning. Kept import-cycle-free (no ./latch import) — both the
 * composition root and the sweep read these.
 */

const int = (env: string | undefined, fallback: number): number => {
  const n = env ? Number.parseInt(env, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Chat idle time before its transcript is eligible for extraction. */
export const MEMORY_IDLE_MS = int(process.env.MEMORY_IDLE_MINUTES, 60) * 60_000;
/** Minimum time between consolidations of one scope. */
export const MEMORY_COOLDOWN_MS = int(process.env.MEMORY_COOLDOWN_HOURS, 6) * 3_600_000;
/** Index entries unrecalled for this long become expiry candidates. */
export const MEMORY_EXPIRE_MS = int(process.env.MEMORY_EXPIRE_DAYS, 30) * 86_400_000;
/** Transcript excerpt cap handed to the extractor (characters). */
export const MEMORY_EXTRACTION_MAX_CHARS = 30_000;
/** Per-tick work caps — bound the cron function's runtime. */
export const MEMORY_EXTRACTION_CANDIDATES = 10; // max extractions per tick
export const MEMORY_EXTRACTION_CONCURRENCY = 3; // parallel extraction workers
export const MEMORY_CONSOLIDATIONS_PER_TICK = 2;
/** Claim-lease TTLs. */
export const MEMORY_EXTRACTION_LEASE_MS = 120_000;
export const MEMORY_CONSOLIDATION_LEASE_MS = 300_000;
/** Failure backoff / parking intervals. */
export const MEMORY_FAILURE_BACKOFF_MS = 2 * 3_600_000;
export const MEMORY_PARK_MS = 24 * 3_600_000;

/**
 * Backoff after `failures` consecutive failed attempts: the base interval
 * doubled per failure, capped at the park interval.
 *
 * A flat retry interval is fine for outages, which clear on their own. It is
 * wrong for a deterministic failure — an index rewrite the consolidator keeps
 * reproducing invalid, say — where nothing changes between attempts and the
 * scope buys a model run every base interval forever. Failing work still must
 * never be dropped (that is how memories vanish), so it keeps its place in the
 * queue and only gets rarer: 2h, 4h, 8h, 16h, then daily.
 */
export const memoryFailureBackoffMs = (failures: number): number =>
  Math.min(MEMORY_FAILURE_BACKOFF_MS * 2 ** Math.max(0, failures - 1), MEMORY_PARK_MS);

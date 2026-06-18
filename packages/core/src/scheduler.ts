/**
 * The Scheduler seam.
 *
 * Something has to drive the reaper (`runtime.sweep()`) on a cadence. That
 * "something" is pluggable: a long-running node uses the in-process interval
 * scheduler below; a serverless deploy points a platform cron at an HTTP route
 * that calls `sweep()`. Either way the work is the same and multi-node safe —
 * reclaiming a run is an atomic, exactly-once DB transition, so firing `sweep()`
 * on every node at once is fine (only one wins each run).
 */
export interface Scheduler {
  /** Begin firing `onTick` on the configured cadence. Idempotent. */
  start(): void;
  /** Stop firing. Resolves once no further ticks will start. */
  stop(): Promise<void>;
}

export interface IntervalSchedulerConfig {
  /** Cadence in ms. */
  intervalMs: number;
  /** The work to run each tick (e.g. `() => runtime.sweep()`). */
  onTick: () => Promise<void> | void;
  /** Observe tick errors (a throwing tick never stops the loop). */
  onError?: (error: unknown) => void;
}

/**
 * A single-process interval scheduler. Ticks never overlap (a slow tick skips
 * the next fire rather than stacking), and the timer is `unref`'d so it won't
 * keep a Node process alive on its own.
 */
export function createIntervalScheduler(
  config: IntervalSchedulerConfig,
): Scheduler {
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;
  let inFlight: Promise<void> | undefined;

  const fire = async () => {
    if (running) return; // don't stack ticks
    running = true;
    inFlight = (async () => {
      try {
        await config.onTick();
      } catch (error) {
        config.onError?.(error);
      } finally {
        running = false;
      }
    })();
    await inFlight;
  };

  return {
    start() {
      if (timer !== undefined) return;
      timer = setInterval(() => void fire(), config.intervalMs);
      (timer as { unref?: () => void }).unref?.();
    },
    async stop() {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      await inFlight; // let an in-progress tick finish
    },
  };
}

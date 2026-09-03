/**
 * Per-channel debounce around "run one tick". Events wake a channel; the tick
 * runs once the channel has been quiet for `quietMs`, or `maxWaitMs` after the
 * first wake if the channel never goes quiet (a mention runs it now).
 * One tick at a time per channel: a wake during a run re-arms after it ends,
 * so nothing queued is left behind. Timers are in-process; the inbox is
 * durable, so a restart just runs the tick for whatever is still queued.
 */
export interface Ticker {
  wake(channel: string, opts?: { now?: boolean }): void;
  /** Resolves when no tick is running or scheduled for the channel (tests, shutdown). */
  idle(channel: string): Promise<void>;
  stop(): void;
}

export function createTicker(deps: {
  quietMs: number;
  /** Upper bound on how long a busy channel can postpone its tick (default 4 × quietMs). */
  maxWaitMs?: number;
  /** Run one tick. Return true when more is already waiting (run again). */
  run: (channel: string) => Promise<boolean>;
  /** Retry delay when the tick failed (default 30 s). */
  retryMs?: number;
  /** Per-error retry delay, e.g. a budget refusal's retry-after; undefined → `retryMs`. */
  retryDelay?: (e: unknown) => number | undefined;
  onError?: (channel: string, e: unknown) => void;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}): Ticker {
  const setT = deps.setTimeout ?? globalThis.setTimeout;
  const clearT = deps.clearTimeout ?? globalThis.clearTimeout;
  const retryMs = deps.retryMs ?? 30_000;
  const maxWaitMs = deps.maxWaitMs ?? deps.quietMs * 4;
  const now = () => Date.now();
  type Slot = {
    timer?: ReturnType<typeof globalThis.setTimeout>;
    /** When the current wait started (the first wake since the last tick). */
    since?: number;
    running?: Promise<void>;
    rearm: boolean;
    waiters: (() => void)[];
  };
  const slots = new Map<string, Slot>();
  let stopped = false;

  const slot = (c: string): Slot => {
    let s = slots.get(c);
    if (!s) slots.set(c, (s = { rearm: false, waiters: [] }));
    return s;
  };

  const settle = (c: string) => {
    const s = slots.get(c);
    if (!s || s.timer || s.running) return;
    slots.delete(c);
    for (const w of s.waiters) w();
  };

  function arm(c: string, delay: number) {
    const s = slot(c);
    if (s.timer) clearT(s.timer);
    s.timer = setT(() => {
      s.timer = undefined;
      void fire(c);
    }, delay);
  }

  /** Quiet-period arm that never pushes the tick past `maxWaitMs` from the first wake. */
  function armDebounced(c: string) {
    const s = slot(c);
    s.since ??= now();
    arm(c, Math.max(0, Math.min(deps.quietMs, s.since + maxWaitMs - now())));
  }

  async function fire(c: string) {
    const s = slot(c);
    if (s.running) {
      s.rearm = true;
      return;
    }
    s.since = undefined;
    s.running = (async () => {
      // Run until the tick reports nothing more waiting and no wake arrived meanwhile.
      for (;;) {
        s.rearm = false;
        let again = false;
        try {
          again = await deps.run(c);
        } catch (e) {
          deps.onError?.(c, e);
          if (!stopped) arm(c, deps.retryDelay?.(e) ?? retryMs);
          break;
        }
        if (stopped || (!again && !s.rearm)) break;
      }
      s.running = undefined;
      settle(c);
    })();
  }

  return {
    wake(c, opts) {
      if (stopped) return;
      const s = slot(c);
      if (opts?.now) {
        if (s.timer) clearT(s.timer);
        s.timer = undefined;
        void fire(c);
        return;
      }
      // A running tick already covers this wake (it re-runs after).
      if (s.running) {
        s.rearm = true;
        return;
      }
      armDebounced(c);
    },
    idle(c) {
      const s = slots.get(c);
      if (!s || (!s.timer && !s.running)) return Promise.resolve();
      return new Promise((r) => s.waiters.push(r));
    },
    stop() {
      stopped = true;
      for (const s of slots.values()) if (s.timer) clearT(s.timer);
    },
  };
}

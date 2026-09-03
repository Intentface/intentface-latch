/**
 * Per-channel debounce around "run one tick". Events wake a channel; the tick
 * runs once the channel has been quiet for `quietMs` (a mention runs it now).
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
  /** Run one tick. Return true when more is already waiting (run again). */
  run: (channel: string) => Promise<boolean>;
  /** Retry delay when the channel's chat is busy or the tick failed. */
  retryMs?: number;
  onError?: (channel: string, e: unknown) => void;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}): Ticker {
  const setT = deps.setTimeout ?? globalThis.setTimeout;
  const clearT = deps.clearTimeout ?? globalThis.clearTimeout;
  const retryMs = deps.retryMs ?? 30_000;
  type Slot = { timer?: ReturnType<typeof globalThis.setTimeout>; running?: Promise<void>; rearm: boolean; waiters: (() => void)[] };
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

  async function fire(c: string) {
    const s = slot(c);
    if (s.running) {
      s.rearm = true;
      return;
    }
    s.running = (async () => {
      // Run until the tick reports nothing more waiting and no wake arrived meanwhile.
      for (;;) {
        s.rearm = false;
        let again = false;
        try {
          again = await deps.run(c);
        } catch (e) {
          deps.onError?.(c, e);
          if (!stopped) arm(c, retryMs);
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
      // A pending immediate fire or a running tick already covers this wake.
      if (s.running) {
        s.rearm = true;
        return;
      }
      arm(c, deps.quietMs);
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

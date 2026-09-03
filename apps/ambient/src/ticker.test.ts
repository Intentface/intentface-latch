import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTicker } from "./ticker.js";

describe("ticker", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces a burst of wakes into one tick after the quiet period", async () => {
    const run = vi.fn(async () => false);
    const t = createTicker({ quietMs: 1000, run });
    t.wake("C1");
    await vi.advanceTimersByTimeAsync(600);
    t.wake("C1"); // resets the quiet timer
    await vi.advanceTimersByTimeAsync(600);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(400);
    expect(run).toHaveBeenCalledTimes(1);
    await t.idle("C1");
  });

  it("a channel that never goes quiet still ticks by maxWait", async () => {
    const run = vi.fn(async () => false);
    const t = createTicker({ quietMs: 1000, maxWaitMs: 3000, run });
    for (let i = 0; i < 10; i++) {
      t.wake("C1");
      await vi.advanceTimersByTimeAsync(500); // never 1000 ms of quiet
      if (i === 5) expect(run).toHaveBeenCalledTimes(1); // fired at ~3000 ms
    }
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000); // now quiet → the second batch
    expect(run).toHaveBeenCalledTimes(2);
    await t.idle("C1");
  });

  it("a mention runs at once, and a wake during a run re-arms one more tick after it", async () => {
    let release!: () => void;
    const run = vi.fn(() => new Promise<boolean>((r) => (release = () => r(false))));
    const t = createTicker({ quietMs: 1000, run });
    t.wake("C1", { now: true });
    expect(run).toHaveBeenCalledTimes(1);
    t.wake("C1");
    t.wake("C1", { now: true });
    expect(run).toHaveBeenCalledTimes(1); // still the first run
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2); // the wakes during the run → exactly one more
    release();
    await vi.advanceTimersByTimeAsync(0);
    await t.idle("C1");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("runs again when the tick reports more waiting, and retries after a failure", async () => {
    const outcomes = [true, false];
    const run = vi.fn(async () => outcomes.shift() ?? false);
    const t = createTicker({ quietMs: 100, run });
    t.wake("C1");
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(2);

    const onError = vi.fn();
    const failing = vi.fn().mockRejectedValueOnce(new Error("busy")).mockResolvedValue(false);
    const t2 = createTicker({ quietMs: 100, run: failing, retryMs: 5000, onError });
    t2.wake("C2", { now: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5000);
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it("channels are independent and stop() cancels pending timers", async () => {
    const run = vi.fn(async () => false);
    const t = createTicker({ quietMs: 100, run });
    t.wake("C1");
    t.wake("C2", { now: true });
    expect(run).toHaveBeenCalledWith("C2");
    t.stop();
    await vi.advanceTimersByTimeAsync(200);
    expect(run).not.toHaveBeenCalledWith("C1");
  });
});

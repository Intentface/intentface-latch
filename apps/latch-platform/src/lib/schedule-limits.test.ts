import { describe, expect, it } from "vitest";
import { intervalAtLeast } from "./schedule-limits";

/**
 * The frequency floor on agent-created schedules. A model asked for "keep me
 * posted" will happily write `* * * * *`, and on a channel that reads as the
 * bot spamming you — so the tool refuses anything that could fire twice inside
 * the window.
 */
const FIFTEEN_MIN = 15 * 60 * 1000;
const ok = (expr: string, tz?: string) => intervalAtLeast(expr, tz, FIFTEEN_MIN);

describe("intervalAtLeast", () => {
  it("accepts sane cadences", () => {
    expect(ok("0 8 * * 1-5")).toBe(true); // weekday mornings
    expect(ok("0 * * * *")).toBe(true); // hourly
    expect(ok("*/15 * * * *")).toBe(true); // exactly at the floor
    expect(ok("30 6 * * 1")).toBe(true); // Monday brief
  });

  it("rejects anything that fires faster than the floor", () => {
    expect(ok("* * * * *")).toBe(false); // every minute
    expect(ok("*/5 * * * *")).toBe(false);
    expect(ok("*/14 * * * *")).toBe(false); // just under
  });

  it("catches bursts that a naive step check would miss", () => {
    // Two fires a minute apart, once a day: the gap that matters isn't the
    // period, it's the shortest interval between consecutive occurrences.
    expect(ok("0,1 8 * * *")).toBe(false);
    expect(ok("0,30 8 * * *")).toBe(true);
  });

  it("rejects garbage rather than letting it through", () => {
    expect(ok("not a cron")).toBe(false);
    expect(ok("")).toBe(false);
    expect(ok("0 8 * * 1-5", "Not/AZone")).toBe(false);
  });

  it("is evaluated in the given timezone", () => {
    expect(ok("0 8 * * *", "Europe/Helsinki")).toBe(true);
  });
});

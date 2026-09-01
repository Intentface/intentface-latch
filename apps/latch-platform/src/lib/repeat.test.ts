import { describe, expect, it } from "vitest";
import { describeCron, fromCron, type Repeat, toCron } from "./repeat";

/**
 * The picker's promise: what someone chooses is what the cron says. These pin
 * the mapping, since a wrong field order here fires someone's digest at minute
 * nine of every hour instead of 9am.
 */

describe("toCron", () => {
  it("maps once to null — the API's own one-shot form", () => {
    expect(toCron({ kind: "once" })).toBeNull();
  });

  it("maps hourly to a minute mark", () => {
    expect(toCron({ kind: "hourly", minute: 15 })).toBe("15 * * * *");
    // Out-of-range input clamps rather than producing an invalid expression.
    expect(toCron({ kind: "hourly", minute: 99 })).toBe("59 * * * *");
  });

  it("maps daily to minute-then-hour", () => {
    expect(toCron({ kind: "daily", time: "09:30" })).toBe("30 9 * * *");
    expect(toCron({ kind: "daily", time: "00:00" })).toBe("0 0 * * *");
  });

  it("falls back to 9am when a time can't be read", () => {
    expect(toCron({ kind: "daily", time: "" })).toBe("0 9 * * *");
    expect(toCron({ kind: "daily", time: "25:99" })).toBe("0 9 * * *");
  });

  it("maps weekly to sorted, deduplicated cron weekdays", () => {
    expect(toCron({ kind: "weekly", days: [5, 1, 1], time: "08:00" })).toBe("0 8 * * 1,5");
  });

  it("refuses a weekly repeat with no day picked", () => {
    expect(() => toCron({ kind: "weekly", days: [], time: "08:00" })).toThrow(/weekday/);
  });

  it("maps monthly to a clamped day of month", () => {
    expect(toCron({ kind: "monthly", day: 1, time: "07:00" })).toBe("0 7 1 * *");
    expect(toCron({ kind: "monthly", day: 40, time: "07:00" })).toBe("0 7 31 * *");
  });

  it("passes a custom expression through trimmed, and refuses an empty one", () => {
    expect(toCron({ kind: "custom", expression: " */5 * * * * " })).toBe("*/5 * * * *");
    expect(() => toCron({ kind: "custom", expression: "  " })).toThrow(/cron/);
  });
});

describe("fromCron", () => {
  it("round-trips every shape the picker writes", () => {
    const shapes: Repeat[] = [
      { kind: "once" },
      { kind: "hourly", minute: 15 },
      { kind: "daily", time: "09:30" },
      { kind: "weekly", days: [1, 5], time: "08:00" },
      { kind: "monthly", day: 3, time: "07:45" },
    ];
    for (const shape of shapes) {
      expect(fromCron(toCron(shape))).toEqual(shape);
    }
  });

  it("opens anything it didn't write as Custom, verbatim", () => {
    expect(fromCron("*/5 * * * *")).toEqual({ kind: "custom", expression: "*/5 * * * *" });
    expect(fromCron("0 9 * 6 *")).toEqual({ kind: "custom", expression: "0 9 * 6 *" });
    expect(fromCron("0 9 1-5 * *")).toEqual({ kind: "custom", expression: "0 9 1-5 * *" });
    // Six fields (leading seconds) is croner-legal but not a picker shape.
    expect(fromCron("0 0 9 * * 1")).toEqual({ kind: "custom", expression: "0 0 9 * * 1" });
  });
});

describe("describeCron", () => {
  it("phrases an expression in words", () => {
    expect(describeCron("0 9 * * 1")).toMatch(/09:00/);
    expect(describeCron("0 9 * * 1")).toMatch(/Monday/);
  });

  it("falls back to the raw expression rather than throwing", () => {
    expect(describeCron("not a cron")).toBe("not a cron");
  });
});

import { describe, expect, it } from "vitest";
import {
  buildDefaultTools,
  hasDefaultTool,
  KNOWN_DEFAULT_TOOLS,
  SCHEDULE_TOOLS,
} from "./default-tools";

/** The editor's toggle init, mirrored here so the round-trips test the real flow. */
function togglesFor(prev: boolean | string[] | undefined) {
  return {
    webTools: hasDefaultTool(prev, "web_fetch"),
    askUser: hasDefaultTool(prev, "askUser"),
    schedules: SCHEDULE_TOOLS.some((n) => hasDefaultTool(prev, n)),
  };
}

describe("buildDefaultTools", () => {
  it("returns undefined when nothing is granted", () => {
    expect(
      buildDefaultTools({
        webTools: false,
        askUser: false,
        schedules: false,
        schedulesTouched: false,
        prev: undefined,
      }),
    ).toBeUndefined();
  });

  it("grants the full schedule capability when the user turns Schedules on", () => {
    const saved = buildDefaultTools({
      webTools: false,
      askUser: false,
      schedules: true,
      schedulesTouched: true,
      prev: undefined,
    });
    expect(saved).toEqual(SCHEDULE_TOOLS);
  });

  // The CodeRabbit regression: an agent whose defaultTools holds only a subset
  // of the schedule tools (possible via the API or agent-builder) must NOT be
  // silently expanded to all four by a save that never touched the toggle.
  it("preserves a partial schedule subset on an untouched save", () => {
    const prev = ["list_schedules"];
    const saved = buildDefaultTools({
      ...togglesFor(prev),
      schedulesTouched: false,
      prev,
    });
    expect(saved).toEqual(["list_schedules"]);
  });

  it("expands a partial subset to the full capability only on an explicit toggle", () => {
    const prev = ["list_schedules"];
    const saved = buildDefaultTools({
      ...togglesFor(prev),
      schedulesTouched: true,
      prev,
    });
    expect(saved).toEqual(SCHEDULE_TOOLS);
  });

  it("drops all schedule tools when the toggle is turned off", () => {
    const prev = [...SCHEDULE_TOOLS, "web_fetch"];
    const saved = buildDefaultTools({
      ...togglesFor(prev),
      schedules: false,
      schedulesTouched: true,
      prev,
    });
    expect(saved).toEqual(["web_fetch"]);
  });

  it("round-trips defaultTools: true as the explicit full known set", () => {
    const saved = buildDefaultTools({
      ...togglesFor(true),
      schedulesTouched: false,
      prev: true,
    });
    expect(saved).toEqual(KNOWN_DEFAULT_TOOLS);
  });

  it("round-trips an unchanged full grant byte-for-byte", () => {
    const prev = ["web_fetch", "askUser", ...SCHEDULE_TOOLS];
    const saved = buildDefaultTools({
      ...togglesFor(prev),
      schedulesTouched: false,
      prev,
    });
    expect(saved).toEqual(prev);
  });

  it("preserves unknown default-tool names but never render_fetch", () => {
    const prev = ["web_fetch", "future_tool", "render_fetch"];
    const saved = buildDefaultTools({
      ...togglesFor(prev),
      schedulesTouched: false,
      prev,
    });
    expect(saved).toEqual(["web_fetch", "future_tool"]);
  });
});

import { describe, expect, it } from "vitest";
import { eventsOf, sliceTrace } from "./slice";

const msg = (role: string, parts: unknown[]) => ({ role, parts });
const user = (text: string) => msg("user", [{ type: "text", text }]);
const read = (path: string, text: string) => ({
  type: "tool-read_file",
  toolCallId: `t_${path}`,
  input: { path },
  output: { text },
});

const SHORT = [
  user("What's our VPC peering limit?"),
  msg("assistant", [
    read("docs/vpc.md", "Peering connections: 125 per VPC."),
    { type: "text", text: "125 per VPC." },
  ]),
];

describe("eventsOf", () => {
  it("flattens past the message boundary, so one huge message can still be windowed", () => {
    // A real agent run puts forty tool calls in ONE assistant message.
    // Windowing by message would yield a single enormous window.
    const many = [
      user("audit everything"),
      msg("assistant", [
        ...Array.from({ length: 40 }, (_, i) => read(`docs/${i}.md`, `doc ${i}`)),
        { type: "text", text: "Done." },
      ]),
    ];
    const events = eventsOf(many);
    expect(events).toHaveLength(42); // 1 user + 40 tools + 1 said
    expect(events.map((e) => e.kind).slice(0, 3)).toEqual(["user", "tool", "tool"]);
  });

  it("orders tool calls before the words about them", () => {
    // A judge shown the narration first grades the narration.
    expect(eventsOf(SHORT).map((e) => e.kind)).toEqual(["user", "tool", "said"]);
  });

  it("numbers events so a verdict can point at one", () => {
    expect(eventsOf(SHORT).map((e) => e.at)).toEqual([0, 1, 2]);
  });

  it("marks a blocked call, so 'it tried' differs from 'it did'", () => {
    const blocked = eventsOf([
      msg("assistant", [
        { type: "tool-delete_stack", toolCallId: "t1", input: {}, output: { __blocked: true } },
      ]),
    ]);
    expect(blocked[0]!.value).toMatchObject({ tool: "delete_stack", blocked: true });
  });

  it("marks truncation rather than silently cutting the evidence", () => {
    const huge = eventsOf([
      msg("assistant", [
        { type: "tool-search", toolCallId: "t1", input: {}, output: "x".repeat(50_000) },
      ]),
    ]);
    expect(JSON.stringify(huge[0]!.value)).toContain("…[truncated]");
  });
});

describe("sliceTrace", () => {
  it("does not slice what fits — a window is strictly less informative", () => {
    const slices = sliceTrace(SHORT);
    expect(slices).toHaveLength(1);
    expect(slices[0]!.scope).toBe("whole");
    expect(slices[0]!.state).not.toHaveProperty("goal"); // no header needed
  });

  it("returns nothing for an empty conversation", () => {
    expect(sliceTrace([])).toEqual([]);
  });

  const LONG = [
    user("audit every networking doc and summarise the limits"),
    msg("assistant", [
      ...Array.from({ length: 30 }, (_, i) => read(`docs/net/${i}.md`, "y".repeat(800))),
      { type: "text", text: "Summary of all limits." },
    ]),
  ];

  it("windows a run that overflows the judge", () => {
    const slices = sliceTrace(LONG, { budgetChars: 4_000, windowEvents: 8, strideEvents: 4 });
    expect(slices.length).toBeGreaterThan(1);
    expect(slices.every((s) => s.scope === "window")).toBe(true);
  });

  it("repeats the goal on every window — a middle window is otherwise unanswerable", () => {
    // "Did it open the right document" cannot be judged without knowing what
    // was asked, and the request is only in the first window.
    const slices = sliceTrace(LONG, { budgetChars: 4_000, windowEvents: 8, strideEvents: 4 });
    for (const s of slices) {
      expect(s.state.goal).toBe("audit every networking doc and summarise the limits");
      expect(String(s.state.position)).toMatch(/events \d+-\d+ of \d+/);
    }
  });

  it("overlaps windows, so a failure spanning a boundary is seen whole by one of them", () => {
    const slices = sliceTrace(LONG, { budgetChars: 4_000, windowEvents: 8, strideEvents: 4 });
    expect(slices[1]!.from).toBeLessThan(slices[0]!.to);
  });

  it("covers every event", () => {
    const slices = sliceTrace(LONG, { budgetChars: 4_000, windowEvents: 8, strideEvents: 4 });
    const seen = new Set<number>();
    for (const s of slices) for (let i = s.from; i < s.to; i++) seen.add(i);
    expect(seen.size).toBe(eventsOf(LONG).length);
  });

  it("stops at the end instead of emitting windows that re-show the tail", () => {
    // Every extra slice is another judge call; a window that adds no new
    // events adds only cost.
    const slices = sliceTrace(LONG, { budgetChars: 4_000, windowEvents: 8, strideEvents: 4 });
    const last = slices[slices.length - 1]!;
    expect(last.to).toBe(eventsOf(LONG).length);
    expect(slices.filter((s) => s.to === last.to)).toHaveLength(1);
  });

  it("never lets stride exceed the window, which would skip events entirely", () => {
    const slices = sliceTrace(LONG, { budgetChars: 4_000, windowEvents: 4, strideEvents: 99 });
    const seen = new Set<number>();
    for (const s of slices) for (let i = s.from; i < s.to; i++) seen.add(i);
    expect(seen.size).toBe(eventsOf(LONG).length);
  });
});

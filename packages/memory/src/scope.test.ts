import { describe, expect, it } from "vitest";
import { scopeRefOf, scopeLabelOf } from "./scope.js";

describe("scopeRefOf", () => {
  it("derives agent-user scope", () => {
    const s = scopeRefOf({
      agent: "running-coach",
      memory: { scope: "agent-user", connection: "loredex" },
      userId: "usr_123",
    });
    expect(s).toEqual({
      key: "loredex:_memory/running-coach/u-usr_123",
      connection: "loredex",
      root: "_memory/running-coach/u-usr_123",
    });
  });

  it("derives agent-org scope without a user", () => {
    const s = scopeRefOf({
      agent: "weekly",
      memory: { scope: "agent-org", connection: "loredex" },
    });
    expect(s?.root).toBe("_memory/weekly/org");
  });

  it("derives user-wide scope with the literal _user agent segment", () => {
    const s = scopeRefOf({
      agent: "assistant",
      memory: { scope: "user", connection: "loredex" },
      userId: "usr_9",
    });
    expect(s?.root).toBe("_memory/_user/u-usr_9");
  });

  it("returns undefined when a per-user scope has no user", () => {
    expect(
      scopeRefOf({ agent: "a", memory: { scope: "agent-user", connection: "c" } }),
    ).toBeUndefined();
    expect(
      scopeRefOf({ agent: "a", memory: { scope: "user", connection: "c" } }),
    ).toBeUndefined();
  });

  it("sanitizes path-hostile segments (no traversal, no separators)", () => {
    const s = scopeRefOf({
      agent: "my agent/../etc",
      memory: { scope: "agent-user", connection: "loredex" },
      userId: "u/1..2",
    });
    expect(s?.root).not.toContain("..");
    expect(s?.root.split("/").length).toBe(3);
    // Lossy cleaning appends a stable hash of the raw id — see the collision test.
    expect(s?.root).toMatch(/^_memory\/my-agent-etc-[0-9a-f]{8}\/u-u-1-2-[0-9a-f]{8}$/);
  });

  it("distinct hostile ids never collapse to one scope (hash-pinned)", () => {
    const memory = { scope: "agent-user" as const, connection: "loredex" };
    const hostile = scopeRefOf({ agent: "my agent/../etc", memory, userId: "u1" });
    const clean = scopeRefOf({ agent: "my-agent-etc", memory, userId: "u1" });
    expect(hostile?.key).not.toBe(clean?.key);
    // Clean ids stay byte-identical to their raw form (existing roots stable).
    expect(clean?.root).toBe("_memory/my-agent-etc/u-u1");

    const userA = scopeRefOf({ agent: "a", memory, userId: "alice/../bob" });
    const userB = scopeRefOf({ agent: "a", memory, userId: "alice-bob" });
    expect(userA?.key).not.toBe(userB?.key);

    // Same raw id always derives the same root (deterministic).
    expect(scopeRefOf({ agent: "my agent/../etc", memory, userId: "u1" })?.key).toBe(
      hostile?.key,
    );

    // Even ids that clean to nothing stay distinct.
    const dotA = scopeRefOf({ agent: "..", memory, userId: "u1" });
    const dotB = scopeRefOf({ agent: "...", memory, userId: "u1" });
    expect(dotA?.key).not.toBe(dotB?.key);
    expect(dotA?.root).not.toContain("..");
  });

  it("labels every scope", () => {
    expect(scopeLabelOf({ scope: "agent-user", connection: "c" })).toMatch(/this user/);
    expect(scopeLabelOf({ scope: "agent-org", connection: "c" })).toMatch(/organization/);
    expect(scopeLabelOf({ scope: "user", connection: "c" })).toMatch(/across their agents/);
  });
});

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
    expect(s?.root).toBe("_memory/my-agent-etc/u-u-1-2");
  });

  it("labels every scope", () => {
    expect(scopeLabelOf({ scope: "agent-user", connection: "c" })).toMatch(/this user/);
    expect(scopeLabelOf({ scope: "agent-org", connection: "c" })).toMatch(/organization/);
    expect(scopeLabelOf({ scope: "user", connection: "c" })).toMatch(/across their agents/);
  });
});

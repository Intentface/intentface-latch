import { describe, expect, it } from "vitest";
import { extractionLevelsOf, levelConfigOf, scopeRefOf, scopeLabelOf } from "./scope.js";

describe("extractionLevelsOf", () => {
  it("defaults to just the primary scope", () => {
    expect(extractionLevelsOf({ scope: "agent-user", connection: "loredex" })).toEqual([
      "agent-user",
    ]);
  });

  it("keeps the primary first, dedups, and always includes the primary", () => {
    expect(
      extractionLevelsOf({
        scope: "agent-user",
        connection: "loredex",
        extractTo: ["agent-org", "agent-user", "user", "agent-org"],
      }),
    ).toEqual(["agent-user", "agent-org", "user"]);
    // A denormalized config that omits the primary still gets it.
    expect(
      extractionLevelsOf({ scope: "agent-user", connection: "loredex", extractTo: ["user"] }),
    ).toEqual(["agent-user", "user"]);
  });
});

describe("levelConfigOf", () => {
  it("swaps only the scope, preserving connection and tuning", () => {
    const memory = {
      scope: "agent-user" as const,
      connection: "loredex",
      extractTo: ["user" as const],
      extraction: { idleMinutes: 5 },
    };
    const view = levelConfigOf(memory, "user");
    expect(view.scope).toBe("user");
    expect(view.connection).toBe("loredex");
    expect(view.extraction).toEqual({ idleMinutes: 5 });
    // Identity for the primary level (no needless copy).
    expect(levelConfigOf(memory, "agent-user")).toBe(memory);
  });

  it("composes with scopeRefOf/scopeLabelOf per level", () => {
    const memory = { scope: "agent-user" as const, connection: "loredex" };
    const org = scopeRefOf({ agent: "coach", memory: levelConfigOf(memory, "agent-org") });
    expect(org?.root).toBe("_memory/coach/org");
    expect(scopeLabelOf(levelConfigOf(memory, "user"))).toContain("shared across their agents");
  });
});

describe("scopeRefOf", () => {
  it("derives agent-user scope under the Loredex private root", () => {
    const s = scopeRefOf({
      agent: "running-coach",
      memory: { scope: "agent-user", connection: "loredex" },
      userId: "usr_123",
    });
    expect(s).toEqual({
      key: "loredex:__private_root/_memory/running-coach/u-usr_123",
      connection: "loredex",
      root: "__private_root/_memory/running-coach/u-usr_123",
    });
  });

  it("derives agent-org scope without a user", () => {
    const s = scopeRefOf({
      agent: "weekly",
      memory: { scope: "agent-org", connection: "loredex" },
    });
    expect(s?.root).toBe("_memory/weekly/org");
  });

  it("derives user-wide scope under the Loredex private root", () => {
    const s = scopeRefOf({
      agent: "assistant",
      memory: { scope: "user", connection: "loredex" },
      userId: "usr_9",
    });
    expect(s).toEqual({
      key: "loredex:__private_root/_memory/_user/u-usr_9",
      connection: "loredex",
      root: "__private_root/_memory/_user/u-usr_9",
    });
  });

  it("keeps per-user roots distinct even on one shared connection identity", () => {
    // On a workspace-shared connection every caller resolves the SAME
    // physical private root — the u-<id> leaf is what keeps two users'
    // stores from merging into one MEMORY.md.
    const memory = { scope: "user" as const, connection: "loredex" };
    const a = scopeRefOf({ agent: "x", memory, userId: "alice" });
    const b = scopeRefOf({ agent: "y", memory, userId: "bob" });
    expect(a?.root).not.toBe(b?.root);
    expect(a?.key).not.toBe(b?.key);
    // Same user, different agent → same scope (shared across their agents).
    const a2 = scopeRefOf({ agent: "z", memory, userId: "alice" });
    expect(a2?.key).toBe(a?.key);

    const au = { scope: "agent-user" as const, connection: "loredex" };
    const ca = scopeRefOf({ agent: "coach", memory: au, userId: "alice" });
    const cb = scopeRefOf({ agent: "coach", memory: au, userId: "bob" });
    expect(ca?.root).not.toBe(cb?.root);
    expect(ca?.key).not.toBe(cb?.key);
  });

  it("keeps agent-user and user subtrees disjoint under the private root", () => {
    // Scope isolation relies on path containment (`isUnderScopeRoot`), so no
    // scope root may be an ancestor of another scope's root.
    const user = scopeRefOf({
      agent: "coach",
      memory: { scope: "user", connection: "loredex" },
      userId: "u1",
    });
    const agentUser = scopeRefOf({
      agent: "coach",
      memory: { scope: "agent-user", connection: "loredex" },
      userId: "u1",
    });
    expect(agentUser?.root.startsWith(`${user?.root}/`)).toBe(false);
    expect(user?.root.startsWith(`${agentUser?.root}/`)).toBe(false);
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
    expect(s?.root.split("/").length).toBe(4);
    // Lossy cleaning appends a stable hash of the raw id — see the collision test.
    expect(s?.root).toMatch(
      /^__private_root\/_memory\/my-agent-etc-[0-9a-f]{8}\/u-u-1-2-[0-9a-f]{8}$/,
    );
  });

  it("distinct hostile ids never collapse to one scope (hash-pinned)", () => {
    const memory = { scope: "agent-user" as const, connection: "loredex" };
    const hostile = scopeRefOf({ agent: "my agent/../etc", memory, userId: "u1" });
    const clean = scopeRefOf({ agent: "my-agent-etc", memory, userId: "u1" });
    expect(hostile?.key).not.toBe(clean?.key);
    // Clean ids stay byte-identical to their raw form (existing roots stable).
    expect(clean?.root).toBe("__private_root/_memory/my-agent-etc/u-u1");

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

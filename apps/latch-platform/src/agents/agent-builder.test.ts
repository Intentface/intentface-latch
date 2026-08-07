import { describe, expect, it } from "vitest";
import { SAVE_INPUT, saveAgentPreflight } from "./agent-builder";

const BASE = {
  name: "helper",
  modelId: "anthropic/claude-haiku-4.5",
  instructions: "help",
  scope: "user" as const,
};

describe("save_agent input schema (schema-only coverage)", () => {
  it("rejects an empty memory connection name", () => {
    const res = SAVE_INPUT.safeParse({
      ...BASE,
      capabilities: { memory: { scope: "agent-user", connection: "" } },
    });
    expect(res.success).toBe(false);
  });

  it("accepts a configured memory connection", () => {
    const res = SAVE_INPUT.safeParse({
      ...BASE,
      connections: ["loredex"],
      capabilities: { memory: { scope: "agent-user", connection: "loredex" } },
    });
    expect(res.success).toBe(true);
  });
});

describe("saveAgentPreflight (the save_agent runtime guards)", () => {
  it("reserves built-in names and the whole memory-* prefix", () => {
    expect(saveAgentPreflight({ ...BASE, name: "assistant" })).toMatch(/built-in/);
    expect(saveAgentPreflight({ ...BASE, name: "memory-notes" })).toMatch(/reserved/);
    expect(saveAgentPreflight({ ...BASE, name: "" })).toBe("invalid name");
    expect(saveAgentPreflight(BASE)).toBeUndefined();
  });

  it("requires the memory connection to be one of the agent's own", () => {
    const memory = { scope: "agent-user", connection: "loredex" };
    expect(
      saveAgentPreflight({ ...BASE, connections: [], capabilities: { memory } }),
    ).toMatch(/must also be listed/);
    // An empty connection name must FAIL the membership check, never skip it.
    expect(
      saveAgentPreflight({
        ...BASE,
        connections: ["loredex"],
        capabilities: { memory: { scope: "agent-user", connection: "" } },
      }),
    ).toMatch(/must also be listed/);
    expect(
      saveAgentPreflight({ ...BASE, connections: ["loredex"], capabilities: { memory } }),
    ).toBeUndefined();
  });

  it("gates agent-org memory to org-visible agents", () => {
    const memory = { scope: "agent-org", connection: "loredex" };
    expect(
      saveAgentPreflight({
        ...BASE,
        scope: "user",
        connections: ["loredex"],
        capabilities: { memory },
      }),
    ).toMatch(/requires scope: "org"/);
    expect(
      saveAgentPreflight({
        ...BASE,
        scope: "org",
        connections: ["loredex"],
        capabilities: { memory },
      }),
    ).toBeUndefined();
  });

  it("gates agent-org as an EXTRACTION level too, not just the primary scope", () => {
    const memory = {
      scope: "agent-user",
      connection: "loredex",
      extractTo: ["agent-org"],
    };
    expect(
      saveAgentPreflight({
        ...BASE,
        scope: "user",
        connections: ["loredex"],
        capabilities: { memory },
      }),
    ).toMatch(/requires scope: "org"/);
    expect(
      saveAgentPreflight({
        ...BASE,
        scope: "org",
        connections: ["loredex"],
        capabilities: { memory },
      }),
    ).toBeUndefined();
  });

  it("validates memory schemas: agent-held levels only, outline required, size-capped", () => {
    const base = {
      ...BASE,
      scope: "org" as const,
      connections: ["loredex"],
    };
    const mem = (schemas: Record<string, string>) => ({
      capabilities: {
        memory: { scope: "agent-user", connection: "loredex", extractTo: ["agent-org"], schemas },
      },
    });
    expect(
      saveAgentPreflight({ ...base, ...mem({ user: "## Profile" }) }),
    ).toMatch(/save_user_memory_schema/);
    expect(
      saveAgentPreflight({ ...base, ...mem({ "agent-user": "no headings here" }) }),
    ).toMatch(/## Section/);
    expect(
      saveAgentPreflight({ ...base, ...mem({ "agent-user": `## A\n${"x".repeat(4001)}` }) }),
    ).toMatch(/too long/);
    expect(
      saveAgentPreflight({
        ...base,
        ...mem({ "agent-user": "## What was gone through\n- topics", "agent-org": "## Org knowledge" }),
      }),
    ).toBeUndefined();
    // Blank schema entries are tolerated (treated as unset).
    expect(saveAgentPreflight({ ...base, ...mem({ "agent-user": "  " }) })).toBeUndefined();
  });
});

describe("save_agent input schema (memory levels)", () => {
  it("accepts extractTo + schemas and rejects unknown levels", () => {
    expect(
      SAVE_INPUT.safeParse({
        ...BASE,
        connections: ["loredex"],
        capabilities: {
          memory: {
            scope: "agent-user",
            connection: "loredex",
            extractTo: ["agent-org", "user"],
            schemas: { "agent-user": "## A", "agent-org": "## B" },
          },
        },
      }).success,
    ).toBe(true);
    expect(
      SAVE_INPUT.safeParse({
        ...BASE,
        capabilities: {
          memory: { scope: "agent-user", connection: "loredex", extractTo: ["everything"] },
        },
      }).success,
    ).toBe(false);
  });
});

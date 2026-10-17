import { describe, expect, it } from "vitest";
import {
  AgentRecordSchema,
  normalizeAgentName,
  normalizeAgentRecord,
  parseAgentRecord,
  parseAgentRef,
} from "./record.js";

const BASE = {
  name: "helper",
  modelId: "anthropic/claude-haiku-4.5",
  instructions: "help",
  scope: "user" as const,
};

const issues = (input: unknown): string[] => {
  const res = AgentRecordSchema.safeParse(input);
  return res.success ? [] : res.error.issues.map((i) => i.message);
};

describe("AgentRecordSchema — shape", () => {
  it("applies defaults and accepts the minimal record", () => {
    const rec = AgentRecordSchema.parse(BASE);
    expect(rec.connections).toEqual([]);
    expect(rec.exec).toBeUndefined();
  });

  it("rejects empty instructions, empty model, bad maxSteps, unknown scope", () => {
    expect(issues({ ...BASE, instructions: "" })).not.toEqual([]);
    expect(issues({ ...BASE, modelId: "" })).not.toEqual([]);
    expect(issues({ ...BASE, maxSteps: 0 })).not.toEqual([]);
    expect(issues({ ...BASE, maxSteps: 2.5 })).not.toEqual([]);
    expect(issues({ ...BASE, scope: "team" })).not.toEqual([]);
    expect(issues({ ...BASE, maxSteps: "unlimited" })).toEqual([]);
  });

  it("rejects a name that normalizes to nothing", () => {
    expect(issues({ ...BASE, name: "!!!" })).toContain("invalid name");
  });

  it("rejects the retired top-level effort/authoredTools instead of silently dropping them", () => {
    expect(issues({ ...BASE, effort: "high" })).not.toEqual([]);
    expect(issues({ ...BASE, authoredTools: ["t1"] })).not.toEqual([]);
    expect(issues({ ...BASE, capabilities: { sandbox: true } })).not.toEqual([]);
    // The nested forms are the supported ones.
    const rec = AgentRecordSchema.parse({ ...BASE, exec: { effort: "high", authoredTools: ["t1"] } });
    expect(rec.exec).toEqual({ effort: "high", authoredTools: ["t1"] });
  });

  it("a retired exec flag (codeMode) on a stored row is stripped, not rejected", () => {
    // Contract: unknown `exec` keys parse fine and are dropped — nothing reads
    // `codeMode` anymore, so a re-save writes the row back without it.
    const rec = AgentRecordSchema.parse({ ...BASE, exec: { sandbox: true, codeMode: {} } });
    expect(rec.exec).toEqual({ sandbox: true });
    expect(rec.exec).not.toHaveProperty("codeMode");
  });

  it("rejects an empty memory connection name", () => {
    expect(issues({ ...BASE, exec: { memory: { scope: "agent-user", connection: "" } } })).not.toEqual([]);
  });

  it("rejects attachedEvals, retired in 0.22 (stores drop it from old versions on read)", () => {
    expect(issues({ ...BASE, attachedEvals: [{ name: "on-topic", prompt: "Stays on topic." }] })).not.toEqual([]);
  });
});

describe("AgentRecordSchema — memory invariants (host-independent)", () => {
  it("requires the memory connection to be one of the agent's own", () => {
    const memory = { scope: "agent-user", connection: "loredex" };
    expect(issues({ ...BASE, connections: [], exec: { memory } }).join()).toMatch(/must also be listed/);
    expect(issues({ ...BASE, connections: ["loredex"], exec: { memory } })).toEqual([]);
  });

  it("gates agent-org memory to org-visible agents — primary scope AND extraction levels", () => {
    const primary = { scope: "agent-org", connection: "loredex" };
    const viaExtract = { scope: "agent-user", connection: "loredex", extractTo: ["agent-org"] };
    for (const memory of [primary, viaExtract]) {
      expect(issues({ ...BASE, scope: "user", connections: ["loredex"], exec: { memory } }).join()).toMatch(
        /requires scope: "org"/,
      );
      expect(issues({ ...BASE, scope: "org", connections: ["loredex"], exec: { memory } })).toEqual([]);
    }
  });

  it("validates memory schemas: agent-held levels only, outline required, size-capped", () => {
    const base = { ...BASE, scope: "org" as const, connections: ["loredex"] };
    const mem = (schemas: Record<string, string>) => ({
      exec: { memory: { scope: "agent-user", connection: "loredex", extractTo: ["agent-org"], schemas } },
    });
    expect(issues({ ...base, ...mem({ user: "## Facts" }) })).not.toEqual([]);
    expect(issues({ ...base, ...mem({ "agent-user": "no heading here" }) }).join()).toMatch(/## Section/);
    // `##Facts` / `##\nFacts` are not level-2 headings (CommonMark needs the space).
    expect(issues({ ...base, ...mem({ "agent-user": "##Facts" }) }).join()).toMatch(/## Section/);
    expect(issues({ ...base, ...mem({ "agent-user": "##\nFacts" }) }).join()).toMatch(/## Section/);
    expect(issues({ ...base, ...mem({ "agent-user": "  ## Facts\n- x" }) })).toEqual([]);
    expect(issues({ ...base, ...mem({ "agent-user": `## A\n${"x".repeat(4000)}` }) }).join()).toMatch(
      /too long/,
    );
    expect(issues({ ...base, ...mem({ "agent-user": "## Preferences\n- tone", "agent-org": "  " }) })).toEqual(
      [],
    );
  });
});

describe("normalizeAgentRecord", () => {
  it("normalizes the name and trims labels", () => {
    const rec = parseAgentRecord({ ...BASE, name: " My Agent! ", title: "  ", description: " x " });
    expect(rec.name).toBe("my-agent");
    expect(rec.title).toBeUndefined();
    expect(rec.description).toBe("x");
  });

  it("canonicalizes extractTo (unique, primary first) and drops blank schemas", () => {
    const rec = parseAgentRecord({
      ...BASE,
      scope: "org",
      connections: ["loredex"],
      exec: {
        memory: {
          scope: "agent-user",
          connection: "loredex",
          extractTo: ["agent-org", "agent-user", "agent-org"],
          schemas: { "agent-user": "## A", "agent-org": "   " },
        },
      },
    });
    expect(rec.exec?.memory?.extractTo).toEqual(["agent-user", "agent-org"]);
    expect(rec.exec?.memory?.schemas).toEqual({ "agent-user": "## A" });
  });

  it("extractTo that only repeats the primary becomes absent; empty containers vanish", () => {
    const rec = parseAgentRecord({
      ...BASE,
      connections: ["loredex"],
      exec: {
        authoredTools: [],
        memory: { scope: "agent-user", connection: "loredex", extractTo: ["agent-user"], schemas: {} },
      },
      subagents: [],
    });
    expect(rec.exec?.memory).toEqual({ scope: "agent-user", connection: "loredex" });
    expect(rec.exec?.authoredTools).toBeUndefined();
    expect(rec.subagents).toBeUndefined();
  });

  it("an exec with nothing set becomes absent, and normalization is idempotent", () => {
    const once = parseAgentRecord({ ...BASE, exec: { sandbox: undefined } });
    expect(once.exec).toBeUndefined();
    const full = parseAgentRecord({
      ...BASE,
      connections: ["loredex"],
      exec: { sandbox: true, memory: { scope: "agent-user", connection: "loredex", extractTo: ["user"] } },
    });
    expect(normalizeAgentRecord(full)).toEqual(full);
  });
});

describe("names and refs", () => {
  it("normalizeAgentName kebab-cases and strips edges", () => {
    expect(normalizeAgentName(" My Agent! ")).toBe("my-agent");
    expect(normalizeAgentName("--x_y--")).toBe("x_y");
  });

  it("parseAgentRef splits an org:/user: pin and passes bare names through", () => {
    expect(parseAgentRef("org:shared")).toEqual({ name: "shared", scope: "org" });
    expect(parseAgentRef("user:mine")).toEqual({ name: "mine", scope: "user" });
    expect(parseAgentRef("plain")).toEqual({ name: "plain" });
    expect(parseAgentRef("team:x")).toEqual({ name: "team:x" });
  });
});

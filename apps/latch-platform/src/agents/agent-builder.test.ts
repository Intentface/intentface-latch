import { describe, expect, it } from "vitest";
import { SAVE_INPUT } from "./agent-builder";

const BASE = {
  name: "helper",
  modelId: "anthropic/claude-haiku-4.5",
  instructions: "help",
  scope: "user" as const,
};

describe("save_agent input schema", () => {
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

import { describe, expect, it } from "vitest";
import { scopeRefOf } from "@intentface/latch-memory";
import { memoryAgentOf } from "./agent-identity";

const MEM = { scope: "agent-user" as const, connection: "loredex" };
const scopeOf = (ref: string) =>
  scopeRefOf({ agent: memoryAgentOf(ref), memory: MEM, userId: "u1" })!;

describe("memoryAgentOf", () => {
  it("strips a channel binding's scope pin", () => {
    expect(memoryAgentOf("org:running-coach")).toBe("running-coach");
    expect(memoryAgentOf("user:running-coach")).toBe("running-coach");
    expect(memoryAgentOf("running-coach")).toBe("running-coach");
  });

  it("gives a channel turn and a web turn the SAME memory scope", () => {
    // The bug this exists for: `seg()` sanitizes the `:` and appends a hash of
    // the raw name, so `org:running-coach` used to mint a second scope root
    // (`_memory/org-running-coach-67e61a5b/u-u1`) beside the web one — the agent
    // could not recall on Telegram what it learned on the web.
    const web = scopeOf("running-coach");
    const telegram = scopeOf("org:running-coach");
    expect(telegram.root).toBe(web.root);
    expect(telegram.key).toBe(web.key);
    expect(web.root).toContain("/running-coach/");
    expect(web.root).not.toContain("org-running-coach");
  });

  it("leaves a name that merely contains a pin-like word alone", () => {
    // Only a leading `org:`/`user:` is a pin. A colon cannot otherwise appear
    // (normalizeAgentName strips it), but the guard must not eat real names.
    expect(memoryAgentOf("org-wide-coach")).toBe("org-wide-coach");
    expect(memoryAgentOf("user-research-bot")).toBe("user-research-bot");
  });

  it("keeps distinct agents in distinct scopes", () => {
    expect(scopeOf("org:coach").root).not.toBe(scopeOf("org:other-coach").root);
  });
});

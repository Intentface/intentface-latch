import { describe, expect, it } from "vitest";
import { builtInToolsOf } from "./agent-tools";

describe("an agent's built-in tools", () => {
  it("lists what its settings switch on — search_agent's sandbox and default tools", () => {
    const names = builtInToolsOf({ exec: { sandbox: true, provider: "daytona", defaultTools: true } }).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["bash", "read_file", "write_file", "grep", "glob", "web_fetch", "create_schedule"]));
  });

  it("keeps to a named list of default tools, and leaves out disabled ones", () => {
    const names = builtInToolsOf({ exec: { defaultTools: ["web_fetch", "create_schedule"], disableTools: ["create_schedule"] } }).map((t) => t.name);
    expect(names).toEqual(["web_fetch"]);
  });

  it("names memory, authored tools and subagents", () => {
    const names = builtInToolsOf({ exec: { memory: { scope: "agent-user", connection: "edge-client" }, authoredTools: ["kite_list_spots"] }, subagents: ["helper"] }).map((t) => t.name);
    expect(names).toEqual(["memory_search", "memory_save", "kite_list_spots", "spawn_agent"]);
  });

  it("is empty for an agent with only connections", () => {
    expect(builtInToolsOf({})).toEqual([]);
  });
});

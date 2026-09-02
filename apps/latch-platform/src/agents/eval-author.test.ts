import { describe, expect, it } from "vitest";
import { evalAuthor, transcriptOf } from "./eval-author";

describe("evalAuthor config", () => {
  it("stays read-only: no capability flag that could reach a write path", async () => {
    // Subagent runs are auto-approved (core runtime), so any capability beyond
    // this allowlist (sandbox, defaultTools, renderTools, connections,
    // subagents, static tools, codeMode, providerWebTools, …) would ship
    // side effects with no human in the loop. Extend deliberately or not at all.
    const config = await evalAuthor({ context: { orgId: "test" }, principal: {} as never });
    const allowed = new Set(["model", "instructions", "toolSources", "smoothStream"]);
    expect(Object.keys(config).filter((k) => !allowed.has(k))).toEqual([]);
    expect(config.toolSources).toHaveLength(1);
  });
});

describe("transcriptOf", () => {
  it("maps text + tool calls (typed and dynamic) with blocked markers and output previews", () => {
    const messages = [
      { role: "user", parts: [{ type: "text", text: "run it" }] },
      {
        role: "assistant",
        parts: [
          { type: "text", text: "on it" },
          {
            type: "tool-search_docs",
            toolCallId: "c1",
            input: { query: "refunds" },
            output: { hits: 3 },
          },
          {
            type: "dynamic-tool",
            toolName: "send_email",
            toolCallId: "c2",
            input: { to: "a@b.c" },
            output: { __blocked: true },
          },
          { type: "text", text: "done" },
        ],
      },
    ];
    const t = transcriptOf(messages);
    expect(t).toHaveLength(2);
    expect(t[0]).toEqual({ role: "user", text: "run it", toolCalls: [] });
    expect(t[1].text).toBe("on it\ndone");
    expect(t[1].toolCalls).toEqual([
      { tool: "search_docs", args: { query: "refunds" }, blocked: undefined, output: '{"hits":3}' },
      { tool: "send_email", args: { to: "a@b.c" }, blocked: true, output: '{"__blocked":true}' },
    ]);
  });

  it("tolerates messages without parts and tool parts without output", () => {
    const t = transcriptOf([
      { role: "assistant" },
      { role: "assistant", parts: [{ type: "tool-x", toolCallId: "c" }] },
    ]);
    expect(t[0]).toEqual({ role: "assistant", text: "", toolCalls: [] });
    expect(t[1].toolCalls).toEqual([{ tool: "x", args: undefined, blocked: undefined, output: undefined }]);
  });
});

import { describe, expect, it } from "vitest";
import {
  allAssistantText,
  extractRunView,
  renderChatContext,
  summarizeToolCalls,
  summarizeToolLoop,
} from "./extract";

const textMsg = (role: string, text: string) => ({
  role,
  parts: [{ type: "text", text }],
});

describe("renderChatContext (the 'chat' scope)", () => {
  it("renders user/assistant text oldest-first and skips tool noise", () => {
    const out = renderChatContext([
      textMsg("user", "hi"),
      {
        role: "assistant",
        parts: [
          { type: "tool-web_fetch", toolName: "web_fetch", input: { url: "x" } },
          { type: "text", text: "hello!" },
        ],
      },
      textMsg("user", "thanks"),
    ]);
    expect(out).toBe("USER: hi\n\nASSISTANT: hello!\n\nUSER: thanks");
  });

  it("drops whole oldest turns behind an omission marker when over the cap", () => {
    const messages = [
      textMsg("user", "a".repeat(60)),
      textMsg("assistant", "b".repeat(60)),
      textMsg("user", "c".repeat(60)),
    ];
    const out = renderChatContext(messages, 150);
    expect(out).toContain("[earlier turns omitted]");
    expect(out).not.toContain("a".repeat(60));
    expect(out).toContain("c".repeat(60));
  });

  it("keeps the newest entry but hard-truncates it to the cap", () => {
    const out = renderChatContext([textMsg("assistant", "z".repeat(500))], 100);
    expect(out).toContain("z".repeat(80));
    expect(out).not.toContain("z".repeat(200)); // one oversized message can't escape the budget
    expect(out).not.toContain("[earlier turns omitted]");
    expect(out.length).toBeLessThanOrEqual(101);
  });
});

describe("summarizeToolLoop (the 'loop' scope)", () => {
  it("renders each call with its truncated output", () => {
    const out = summarizeToolLoop([
      { name: "web_fetch", args: { url: "https://x.test" }, output: { status: 200, body: "ok" } },
      { name: "noop" },
    ]);
    expect(out).toContain("web_fetch(url=https://x.test)");
    expect(out).toContain('→ {"status":200,"body":"ok"}');
    expect(out).toContain("noop");
  });

  it("summarizes spawn_agent as a one-line subagent answer, never a transcript", () => {
    const out = summarizeToolLoop([
      {
        name: "spawn_agent",
        args: { agent: "helper" },
        output: { threadId: "sub_1", answer: "the helper's final answer ".repeat(40) },
      },
    ]);
    expect(out).toContain("spawn_agent(agent=helper) → subagent answered:");
    expect(out).not.toContain("sub_1");
    // One line, capped.
    expect(out.split("\n")).toHaveLength(1);
    expect(out.length).toBeLessThan(500);
  });

  it("truncates long outputs per call and drops trailing calls over the total budget", () => {
    const big = { name: "web_fetch", args: { url: "u" }, output: "x".repeat(5000) };
    const perCall = summarizeToolLoop([big]);
    expect(perCall.length).toBeLessThan(2_300);
    expect(perCall).toContain("…");

    const many = Array.from({ length: 20 }, (_, i) => ({
      name: `tool_${i}`,
      args: {},
      output: "y".repeat(5000),
    }));
    const out = summarizeToolLoop(many, 5_000);
    expect(out).toMatch(/\[… \d+ more tool call\(s\) omitted\]/);
    expect(out).toContain("tool_0");
  });

  it("returns 'none' without calls", () => {
    expect(summarizeToolLoop([])).toBe("none");
  });
});

describe("summarizeToolCalls (the 'turn'/'chat' scopes)", () => {
  it("never emits tool outputs — that's summarizeToolLoop's contract alone", () => {
    const out = summarizeToolCalls([
      { name: "web_fetch", args: { url: "u" }, output: "SECRET-OUTPUT" },
    ]);
    expect(out).toBe("web_fetch(url=u)");
    expect(out).not.toContain("SECRET-OUTPUT");
  });
});

describe("allAssistantText", () => {
  it("joins every assistant text part, not just the last", () => {
    const messages = [
      textMsg("user", "go"),
      {
        role: "assistant",
        parts: [
          { type: "text", text: "Looking that up." },
          { type: "tool-web_fetch", toolName: "web_fetch", input: {} },
          { type: "text", text: "Here's the answer." },
        ],
      },
    ];
    expect(allAssistantText(messages)).toBe("Looking that up.\n\nHere's the answer.");
    // extractRunView's outputText keeps its existing last-wins behavior.
    expect(extractRunView(messages).outputText).toContain("Here's the answer.");
  });
});

describe("extractRunView", () => {
  it("captures tool outputs on the call view", () => {
    const { toolCalls } = extractRunView([
      {
        role: "assistant",
        parts: [
          { type: "tool-web_fetch", toolName: "web_fetch", input: { url: "u" }, output: { ok: 1 } },
          { type: "text", text: "done" },
        ],
      },
    ]);
    expect(toolCalls).toEqual([{ name: "web_fetch", args: { url: "u" }, output: { ok: 1 } }]);
  });
});

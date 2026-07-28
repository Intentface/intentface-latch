import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import type { AttachedEval } from "../agent-store";
import { judgeScopeGroups } from "./judge-run";
import type { RubricVerdictResult, TurnEvidence } from "./judge-run";

/** Mock judge that always passes, capturing every prompt it was shown. */
function mockJudge() {
  const prompts: string[] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return {
        content: [{ type: "text" as const, text: '{"pass": true, "reason": "ok"}' }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
  return { model, prompts };
}

const rubric = (name: string, context?: AttachedEval["context"]): AttachedEval => ({
  name,
  prompt: `criterion for ${name}`,
  scale: "binary",
  enabled: true,
  ...(context ? { context } : {}),
});

const evidence: TurnEvidence = {
  input: "what's the plan?",
  view: {
    outputText: "Final answer.",
    toolCalls: [{ name: "web_fetch", args: { url: "u" }, output: "TOOL-OUTPUT-BODY" }],
  },
  turnMessages: [
    {
      role: "assistant",
      parts: [
        { type: "text", text: "Intermediate narration." },
        { type: "tool-web_fetch", toolName: "web_fetch", input: { url: "u" }, output: "TOOL-OUTPUT-BODY" },
        { type: "text", text: "Final answer." },
      ],
    },
  ],
  historyForChat: [
    { role: "user", parts: [{ type: "text", text: "earlier question" }] },
    { role: "assistant", parts: [{ type: "text", text: "earlier reply" }] },
  ],
};

async function run(rubrics: AttachedEval[]) {
  const { model, prompts } = mockJudge();
  const verdicts: RubricVerdictResult[] = [];
  await judgeScopeGroups({
    runId: "r1",
    modelFor: () => model,
    rubrics,
    evidence,
    sink: async (v) => {
      verdicts.push(v);
    },
  });
  return { prompts, verdicts };
}

describe("judgeScopeGroups", () => {
  it("renders each scope its own evidence: turn stays compact, chat adds history, loop adds outputs", async () => {
    const { prompts, verdicts } = await run([
      rubric("turn-r"),
      rubric("chat-r", "chat"),
      rubric("loop-r", "loop"),
    ]);
    expect(verdicts.map((v) => v.rubric.name).sort()).toEqual(["chat-r", "loop-r", "turn-r"]);
    expect(verdicts.every((v) => v.value === 1)).toBe(true);

    const turn = prompts.find((p) => p.includes("criterion for turn-r"))!;
    const chat = prompts.find((p) => p.includes("criterion for chat-r"))!;
    const loop = prompts.find((p) => p.includes("criterion for loop-r"))!;

    // turn: final answer + name(args) summary, no outputs, no history.
    expect(turn).toContain("Final answer.");
    expect(turn).toContain("web_fetch(url=u)");
    expect(turn).not.toContain("TOOL-OUTPUT-BODY");
    expect(turn).not.toContain("CONVERSATION SO FAR");

    // chat: same view plus the conversation so far.
    expect(chat).toContain("CONVERSATION SO FAR");
    expect(chat).toContain("earlier reply");
    expect(chat).not.toContain("TOOL-OUTPUT-BODY");

    // loop: every assistant text part + the tool trace WITH outputs.
    expect(loop).toContain("Intermediate narration.");
    expect(loop).toContain("TOOL-OUTPUT-BODY");
    expect(loop).not.toContain("CONVERSATION SO FAR");
  });

  it("a loop rubric still judges a turn with tool calls but no final text", async () => {
    const { model, prompts } = mockJudge();
    const verdicts: RubricVerdictResult[] = [];
    await judgeScopeGroups({
      runId: "r2",
      modelFor: () => model,
      rubrics: [rubric("loop-r", "loop")],
      evidence: {
        ...evidence,
        view: { outputText: undefined, toolCalls: evidence.view.toolCalls },
        turnMessages: [
          {
            role: "assistant",
            parts: [
              { type: "tool-web_fetch", toolName: "web_fetch", input: { url: "u" }, output: "TOOL-OUTPUT-BODY" },
            ],
          },
        ],
      },
      sink: async (v) => {
        verdicts.push(v);
      },
    });
    expect(verdicts).toHaveLength(1);
    expect(prompts[0]).toContain("TOOL-OUTPUT-BODY");
  });
});

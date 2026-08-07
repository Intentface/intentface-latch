import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import type { AttachedEval } from "../agent-store";
import { postScore } from "@intentface/latch-langfuse";
import { judgeLiveRun, judgeScopeGroups, rejudgeRun } from "./judge-run";
import type { RubricVerdictResult, TurnEvidence } from "./judge-run";

// Entry-point tests stub the composition root (getLatch) and the Langfuse
// writer so judgeLiveRun / rejudgeRun run against in-memory fakes.
const harness = vi.hoisted((): { latch: unknown } => ({ latch: undefined }));
vi.mock("../latch", () => ({
  ownerTagOf: () => "org/user",
  getLatch: async () => harness.latch,
}));
vi.mock("@intentface/latch-langfuse", () => ({
  postScore: vi.fn(async () => {}),
}));

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

// ── Entry-point wiring: judgeLiveRun / rejudgeRun ────────────────────────────

const turnMsg = (runId: string, text: string) => ({
  role: "assistant",
  metadata: { runId },
  parts: [{ type: "text", text }],
});
const userMsg = (text: string) => ({ role: "user", parts: [{ type: "text", text }] });

// Must agree with the mocked ownerTagOf ("org/user") — the eval owner is derived
// from this principal plus the record's scope.
const PRINCIPAL = { orgId: "org", userId: "user" } as never;

/**
 * In-memory latch fake: records every local score write (with the owner key it
 * was filed under), counts judge calls.
 */
function fakeLatch(
  evals: AttachedEval[],
  history: unknown[],
  /**
   * The record's scope — the judge derives the eval owner from it + the principal.
   * `null` stands in for "no record at all" (a code-registry agent).
   */
  scope: "org" | "user" | null = "user",
) {
  const { model, prompts } = mockJudge();
  const puts: {
    owner: string;
    rubricName: string;
    source: string;
    value: number;
    runOwner?: string;
  }[] = [];
  harness.latch = {
    agentStore: {
      getRecord: async () => (scope ? { attachedEvals: evals, scope } : undefined),
    },
    runtime: {
      loadHistory: async () => history,
      // rejudgeRun derives the agent (and so the eval owner) from the run itself.
      getRun: async ({ runId }: { runId: string }) => ({ id: runId, agent: "my-agent" }),
    },
    modelFor: () => model,
    runScores: {
      put: async (
        owner: string,
        s: { rubricName: string; source: string; value: number; runOwner?: string },
      ) => {
        puts.push({ owner, ...s });
      },
      getOne: async () => undefined,
    },
  };
  return { puts, prompts };
}

const liveArgs = (runId: string, depth: number, messages: unknown[]) => ({
  meta: {
    runId,
    chatId: "chat1",
    agent: "my-agent",
    modelId: "m",
    principal: PRINCIPAL,
    startedAt: 1_000,
    depth,
  },
  outcome: {
    status: "completed" as const,
    inputText: "hi",
    messages,
    usage: { inputTokens: 0, outputTokens: 0 },
    cost: 0,
  },
});

describe("judgeLiveRun — trigger gating at the entry point", () => {
  beforeEach(() => vi.mocked(postScore).mockClear());

  it("a non-matching trigger judges nothing and writes nowhere", async () => {
    // This run is the chat's SECOND assistant turn; the rubric wants turn 1.
    const history = [userMsg("a"), turnMsg("r1", "one"), userMsg("b"), turnMsg("r2", "two")];
    const { puts, prompts } = fakeLatch(
      [{ ...rubric("greets"), trigger: { kind: "turn", eq: 1 } }],
      history,
    );
    await judgeLiveRun(liveArgs("r2", 0, [turnMsg("r2", "two")]));
    expect(prompts).toHaveLength(0); // no judge call
    expect(puts).toHaveLength(0); // no local score
    expect(postScore).not.toHaveBeenCalled(); // no Langfuse score
  });

  it("a depth-less rubric skips subagent turns entirely", async () => {
    const { puts, prompts } = fakeLatch([rubric("greets")], []);
    await judgeLiveRun(liveArgs("r1", 1, [turnMsg("r1", "sub answer")]));
    expect(prompts).toHaveLength(0);
    expect(puts).toHaveLength(0);
    expect(postScore).not.toHaveBeenCalled();
  });

  it("a matching trigger judges and dual-writes (local source 'live' + Langfuse)", async () => {
    const history = [userMsg("a"), turnMsg("r1", "one")];
    const { puts, prompts } = fakeLatch(
      [{ ...rubric("greets"), trigger: { kind: "turn", eq: 1 } }],
      history,
    );
    await judgeLiveRun(liveArgs("r1", 0, [turnMsg("r1", "one")]));
    expect(prompts).toHaveLength(1);
    expect(puts).toEqual([expect.objectContaining({ rubricName: "greets", source: "live", value: 1 })]);
    expect(postScore).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "r1", name: "greets", value: 1, timestamp: 1_000 }),
    );
  });
});

describe("eval ownership — whose observations a verdict lands in", () => {
  beforeEach(() => vi.mocked(postScore).mockClear());

  it("files the verdict under the AGENT's owner, not the runner's tag", async () => {
    // The mocked ownerTagOf is "org/user" — a colleague running an org agent.
    // The verdict must be keyed to the agent's owner ("org") so the agent's
    // administrators see it, with the runner recorded for attribution.
    const history = [userMsg("a"), turnMsg("r1", "one")];
    const { puts } = fakeLatch([rubric("greets")], history, "org");
    await judgeLiveRun(liveArgs("r1", 0, [turnMsg("r1", "one")]));
    expect(puts).toEqual([
      expect.objectContaining({
        owner: "org",
        runOwner: "org/user",
        rubricName: "greets",
        source: "live",
      }),
    ]);
  });

  it("the live judge writes nothing for an agent with no record", async () => {
    // A code-registry agent has no latch_agents row, so it has no attached
    // rubrics either — the live path returns before it ever needs an eval owner.
    const history = [userMsg("a"), turnMsg("r1", "one")];
    const { puts, prompts } = fakeLatch([rubric("greets")], history, null);
    await judgeLiveRun(liveArgs("r1", 0, [turnMsg("r1", "one")]));
    expect(prompts).toHaveLength(0);
    expect(puts).toHaveLength(0);
  });

  it("a re-judge of a record-less agent falls back to the runner's tag", async () => {
    // Here the rubrics come from the caller (draft tuning), so the judge runs
    // even with no record — and the verdict has to belong to someone.
    const history = [userMsg("a"), turnMsg("r1", "one")];
    const { puts } = fakeLatch([], history, null);
    await rejudgeRun({
      principal: PRINCIPAL,
      chatId: "chat1",
      runId: "r1",
      rubrics: [rubric("greets")],
    });
    expect(puts).toEqual([
      expect.objectContaining({ owner: "org/user", runOwner: "org/user" }),
    ]);
  });

  it("a re-judge lands on the same owner key as the live verdict", async () => {
    const history = [userMsg("a"), turnMsg("r1", "one")];
    const { puts } = fakeLatch([], history, "org");
    await rejudgeRun({
      principal: PRINCIPAL,
      chatId: "chat1",
      runId: "r1",
      rubrics: [rubric("greets")],
    });
    expect(puts).toEqual([
      expect.objectContaining({ owner: "org", runOwner: "org/user", source: "rejudge" }),
    ]);
  });
});

describe("rejudgeRun — same gate, local-only sink", () => {
  beforeEach(() => vi.mocked(postScore).mockClear());

  const history = [userMsg("a"), turnMsg("r1", "one"), userMsg("b"), turnMsg("r2", "two")];

  it("a non-matching trigger is silently absent — no judge call, no write", async () => {
    const { puts, prompts } = fakeLatch([], history);
    const results = await rejudgeRun({
      principal: PRINCIPAL,
      chatId: "chat1",
      runId: "r2", // turn 2; the rubric wants turn 1
      rubrics: [{ ...rubric("greets"), trigger: { kind: "turn", eq: 1 } }],
    });
    expect(results).toEqual([]);
    expect(prompts).toHaveLength(0);
    expect(puts).toHaveLength(0);
  });

  it("a matching trigger returns the verdict and writes source 'rejudge', never Langfuse", async () => {
    const { puts, prompts } = fakeLatch([], history);
    const results = await rejudgeRun({
      principal: PRINCIPAL,
      chatId: "chat1",
      runId: "r1",
      rubrics: [{ ...rubric("greets"), trigger: { kind: "turn", eq: 1 } }],
    });
    expect(prompts).toHaveLength(1);
    expect(results.map((r) => r.rubric.name)).toEqual(["greets"]);
    expect(puts).toEqual([
      expect.objectContaining({ rubricName: "greets", source: "rejudge", value: 1 }),
    ]);
    expect(postScore).not.toHaveBeenCalled(); // tuning never pollutes production scores
  });
});

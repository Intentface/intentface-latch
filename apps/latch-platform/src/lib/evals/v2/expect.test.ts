import { describe, expect, it } from "vitest";
import type { Experimental_EvaluationModelV4 as EvaluationModel } from "@ai-sdk/provider";
import type { Input, Rubric, ThreadRef } from "./model";
import { judgeThreads } from "./runner";
import { eachOf, saysItems } from "./expect";

const owner = "org/user";
const history = [
  { role: "user", parts: [{ type: "text", text: "What's the weather in Turku?" }] },
  {
    role: "assistant",
    parts: [
      { type: "dynamic-tool", toolName: "weather_get", input: { city: "Turku, Finland" }, output: { temp: 4 } },
      { type: "text", text: "It is 4 °C in Turku." },
    ],
  },
];
const thread: ThreadRef = { owner, threadId: "t1", agentName: "bot", inputId: "1", version: "live", configFingerprint: "A", origin: "run", answer: "", createdAt: 0 };
const rubric: Rubric = {
  owner,
  id: "r",
  agentName: "bot",
  version: 1,
  defaultJudge: "test",
  createdAt: 0,
  checks: [
    { kind: "counted", id: "expected-calls", label: "Called the expected tools", spec: { op: "expected_calls" } },
    { kind: "asked", id: "said", label: "Said what it should", ask: "From the input", shape: { type: "boolean" }, fromInput: "says" },
  ],
};

/** Says yes to anything mentioning the temperature, no to the rest. */
const judge: EvaluationModel = {
  specificationVersion: "v4",
  provider: "test",
  modelId: "test",
  supportedQuestionTypes: ["boolean", "choice", "score"],
  async doEvaluate(o) {
    return {
      answers: Object.fromEntries(
        Object.entries(o.questions).map(([k, q]) => [k, { type: "boolean", probability: /temperature/.test(JSON.stringify(q)) ? 0.95 : 0.05 }]),
      ),
      usage: { inputTokens: 1, outputTokens: 1 },
      warnings: [],
    };
  },
};

const run = (facts: Input["facts"]) =>
  judgeThreads({
    rubric,
    threads: [thread],
    inputsById: new Map([["1", { id: "1", prompt: "What's the weather in Turku?", facts }]]),
    deps: { loadHistory: () => Promise.resolve(history), judgeFor: () => judge },
  });

describe("an input's own expectations", () => {
  it("checks each expected call on its own, matching an argument or the result", async () => {
    const vs = await run({
      calls: [
        { tool: "weather_get", match: [{ path: "city", op: "contains", value: "Turku" }] },
        { tool: "weather_get", match: [{ path: "city", op: "equals", value: "Helsinki" }] },
        { tool: "*_send_email", never: true },
        { tool: "weather_get", match: [{ path: "result", op: "contains", value: "temp" }] },
      ],
    });
    const v = vs.find((x) => x.checkId === "expected-calls")!;
    expect(eachOf(v.answer)).toEqual([true, false, true, true]);
    expect(v.failed).toBe(true);
  });

  it("asks each must-say, must-not and question as its own yes/no, folded into one verdict", async () => {
    const facts = { mustSay: ["the temperature"], asks: ["Is it friendly?"] };
    const vs = await run(facts);
    const v = vs.find((x) => x.checkId === "said")!;
    expect(saysItems(facts).map((i) => i.kind)).toEqual(["mustSay", "asks"]);
    expect(eachOf(v.answer)).toEqual([true, false]);
    expect(v.failed).toBe(true);
    expect(vs.some((x) => x.checkId.includes("#"))).toBe(false);
  });

  it("skips both for an input that lists nothing", async () => {
    const vs = await run({ answer: "It's cold." });
    expect(vs.map((x) => x.checkId)).toEqual([]);
  });
});

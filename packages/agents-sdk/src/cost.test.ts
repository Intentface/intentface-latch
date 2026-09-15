/**
 * Cost tracking and limiting.
 *
 * Note the usage fixture shape. The PROVIDER emits nested counts
 * (`inputTokens: { total, cacheRead, … }`) which the SDK flattens into
 * `inputTokens` plus `inputTokenDetails`. Sending the flat shape from a mock
 * silently yields zero tokens everywhere, which is a very quiet way for a cost
 * test to pass while measuring nothing.
 */
import { describe, it, expect } from "vitest";
import {
  MockLanguageModelV4,
  convertArrayToReadableStream,
  convertReadableStreamToArray,
} from "ai/test";
import { tool, type UIMessage } from "ai";
import { z } from "zod";
import { runAgentLoop } from "./loop.js";
import { costOfStep, costTracking, priceFor, type ModelPrice, type SpendReport } from "./cost.js";

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
  inputTokens: { total: input, noCache: input - cacheRead - cacheWrite, cacheRead, cacheWrite },
  outputTokens: { total: output, text: output, reasoning: 0 },
});

const pricing: Record<string, ModelPrice> = {
  // Per million tokens.
  "test-model": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};

const text = (id: string, delta: string, u: unknown) => [
  { type: "stream-start", warnings: [] },
  { type: "response-metadata", id, modelId: "test-model", timestamp: new Date(0) },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta },
  { type: "text-end", id: "t" },
  { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: u },
];

const oneStep = (u = usage(1000, 500)) =>
  new MockLanguageModelV4({
    doStream: async () => ({ stream: convertArrayToReadableStream(text("1", "hi", u) as never) }),
  });

/** Calls a tool on every step, so the loop keeps going until something stops it. */
const loops = () =>
  new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: "stream-start", warnings: [] },
        { type: "response-metadata", id: "n", modelId: "test-model", timestamp: new Date(0) },
        { type: "tool-call", toolCallId: `c${Math.random()}`, toolName: "ping", input: "{}" },
        { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: usage(1000, 500) },
      ] as never),
    }),
  });

const tools = { ping: tool({ inputSchema: z.object({}), execute: async () => ({ ok: true }) }) };
const messages: UIMessage[] = [{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }];

describe("pricing arithmetic", () => {
  it("prices plain input and output per million", () => {
    // 1000 in at 3/M = 0.003, 500 out at 15/M = 0.0075
    expect(costOfStep({ inputTokens: 1000, outputTokens: 500 }, pricing["test-model"]!)).toBeCloseTo(0.0105, 6);
  });

  it("bills cached input at the cache rate, not the input rate", () => {
    // 1000 input of which 800 was a cache read: 200 at 3/M + 800 at 0.3/M.
    const cached = costOfStep(
      { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 800 },
      pricing["test-model"]!,
    );
    expect(cached).toBeCloseTo((200 * 3 + 800 * 0.3) / 1e6, 9);
    // Which is markedly cheaper than pricing it all as fresh input.
    expect(cached).toBeLessThan(costOfStep({ inputTokens: 1000, outputTokens: 0 }, pricing["test-model"]!));
  });

  it("never bills a cached token twice", () => {
    const both = costOfStep(
      { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 600, cacheWriteTokens: 400 },
      pricing["test-model"]!,
    );
    expect(both).toBeCloseTo((600 * 0.3 + 400 * 3.75) / 1e6, 9);
  });

  it("falls back to the longest matching prefix", () => {
    expect(priceFor(pricing, "test-model-20260101")).toBe(pricing["test-model"]);
    expect(priceFor(pricing, "some-other-model")).toBeUndefined();
  });
});

describe("tracking a run", () => {
  it("reports tokens and cost for each step and at the end", async () => {
    const reports: SpendReport[] = [];
    await convertReadableStreamToArray(
      await runAgentLoop({
        model: oneStep(),
        tools: {},
        messages,
        extensions: [costTracking({ pricing, onSpend: (r) => void reports.push(r) })],
      }),
    );

    // One after the step, one at agent_end.
    expect(reports).toHaveLength(2);
    const last = reports.at(-1)!;
    expect(last.inputTokens).toBe(1000);
    expect(last.outputTokens).toBe(500);
    expect(last.cost).toBeCloseTo(0.0105, 6);
    expect(last.steps).toBe(1);
    expect(last.unpriced).toEqual([]);
  });

  it("carries the cache split through from the provider", async () => {
    let report: SpendReport | undefined;
    await convertReadableStreamToArray(
      await runAgentLoop({
        model: oneStep(usage(1000, 100, 800, 50)),
        tools: {},
        messages,
        extensions: [costTracking({ pricing, onSpend: (r) => void (report = r) })],
      }),
    );
    expect(report!.cacheReadTokens).toBe(800);
    expect(report!.cacheWriteTokens).toBe(50);
  });

  it("shows a running total to the reader without telling the model", async () => {
    let prompt: unknown;
    const model = new MockLanguageModelV4({
      doStream: async (o) => {
        prompt = o.prompt;
        return { stream: convertArrayToReadableStream(text("1", "hi", usage(1000, 500)) as never) };
      },
    });
    let stored: UIMessage[] = [];
    await convertReadableStreamToArray(
      await runAgentLoop({
        model,
        tools: {},
        messages,
        extensions: [
          costTracking({ pricing, notify: true }),
          {
            name: "cap",
            commands: [],
            hooks: { agent_end: [({ messages: m }) => void (stored = m)] },
          },
        ],
      }),
    );
    expect(JSON.stringify(stored)).toContain("data-cost");
    expect(JSON.stringify(stored)).toContain("1500 tokens");
    expect(JSON.stringify(prompt)).not.toContain("1500 tokens");
  });
});

describe("the limit", () => {
  it("stops the run before the step that would overrun it", async () => {
    const reports: SpendReport[] = [];
    await convertReadableStreamToArray(
      await runAgentLoop({
        model: loops(),
        tools,
        messages,
        maxSteps: 50,
        // Each step costs 0.0105, so this allows three and refuses the fourth.
        extensions: [costTracking({ pricing, limit: 0.03, onSpend: (r) => void reports.push(r) })],
      }),
    );
    const last = reports.at(-1)!;
    expect(last.steps).toBe(3);
    expect(last.cost).toBeCloseTo(0.0315, 6);
    expect(last.stoppedByLimit).toBe(true);
  });

  it("counts spend that happened before this run", async () => {
    const reports: SpendReport[] = [];
    await convertReadableStreamToArray(
      await runAgentLoop({
        model: loops(),
        tools,
        messages,
        maxSteps: 50,
        extensions: [
          // Already 0.02 spent this month against a 0.03 ceiling: one step fits.
          costTracking({ pricing, limit: 0.03, startingSpend: 0.02, onSpend: (r) => void reports.push(r) }),
        ],
      }),
    );
    const last = reports.at(-1)!;
    expect(last.steps).toBe(1);
    expect(last.cumulative).toBeCloseTo(0.0305, 6);
  });

  it("reads an async starting balance once per run", async () => {
    let reads = 0;
    await convertReadableStreamToArray(
      await runAgentLoop({
        model: loops(),
        tools,
        messages,
        maxSteps: 6,
        extensions: [
          costTracking({
            pricing,
            limit: 1,
            startingSpend: async () => {
              reads += 1;
              return 0;
            },
          }),
        ],
      }),
    );
    expect(reads).toBe(1);
  });

  it("an exhausted budget stops before the model is called at all", async () => {
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls += 1;
        return { stream: convertArrayToReadableStream(text("1", "hi", usage(10, 10)) as never) };
      },
    });
    await convertReadableStreamToArray(
      await runAgentLoop({
        model,
        tools: {},
        messages,
        extensions: [costTracking({ pricing, limit: 0.01, startingSpend: 0.5 })],
      }),
    );
    expect(calls).toBe(0);
  });
});

describe("unpriced models", () => {
  it("stop the run when a limit is set, because the spend cannot be known", async () => {
    const reports: SpendReport[] = [];
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { type: "response-metadata", id: "1", modelId: "surprise-model", timestamp: new Date(0) },
          { type: "tool-call", toolCallId: "c1", toolName: "ping", input: "{}" },
          { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: usage(10, 10) },
        ] as never),
      }),
    });
    await convertReadableStreamToArray(
      await runAgentLoop({
        model,
        tools,
        messages,
        maxSteps: 10,
        extensions: [costTracking({ pricing, limit: 1, onSpend: (r) => void reports.push(r) })],
      }),
    );
    const last = reports.at(-1)!;
    expect(last.unpriced).toEqual(["surprise-model"]);
    expect(last.steps).toBe(1);
    expect(last.stoppedByLimit).toBe(true);
  });

  it("are simply free when no limit is being enforced", async () => {
    let report: SpendReport | undefined;
    await convertReadableStreamToArray(
      await runAgentLoop({
        model: oneStep(),
        tools: {},
        messages,
        extensions: [costTracking({ pricing: {}, onSpend: (r) => void (report = r) })],
      }),
    );
    expect(report!.cost).toBe(0);
    expect(report!.unpriced).toEqual(["test-model"]);
    expect(report!.inputTokens).toBe(1000);
  });
});

describe("remaining", () => {
  it("is what is left of the ceiling, counting earlier spend", async () => {
    const reports: SpendReport[] = [];
    await convertReadableStreamToArray(
      await runAgentLoop({
        model: oneStep(),
        tools: {},
        messages,
        extensions: [
          costTracking({ pricing, limit: 0.05, startingSpend: 0.01, onSpend: (r) => void reports.push(r) }),
        ],
      }),
    );
    // 0.05 ceiling, 0.01 already spent, one step at 0.0105.
    expect(reports.at(-1)!.remaining).toBeCloseTo(0.05 - 0.01 - 0.0105, 9);
  });

  it("never goes below zero once the ceiling is passed", async () => {
    const reports: SpendReport[] = [];
    await convertReadableStreamToArray(
      await runAgentLoop({
        model: loops(),
        tools,
        messages,
        maxSteps: 20,
        extensions: [costTracking({ pricing, limit: 0.025, onSpend: (r) => void reports.push(r) })],
      }),
    );
    const last = reports.at(-1)!;
    expect(last.cost).toBeGreaterThan(0.025);
    expect(last.remaining).toBe(0);
  });

  it("is absent when nothing is being enforced", async () => {
    let report: SpendReport | undefined;
    await convertReadableStreamToArray(
      await runAgentLoop({
        model: oneStep(),
        tools: {},
        messages,
        extensions: [costTracking({ pricing, onSpend: (r) => void (report = r) })],
      }),
    );
    expect(report!.remaining).toBeUndefined();
  });
});

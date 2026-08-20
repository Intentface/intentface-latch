import { describe, expect, it } from "vitest";
import { anthropic } from "@ai-sdk/anthropic";
import { jsonSchema, ToolLoopAgent } from "ai";
import {
  currentDateLine,
  markLastFunctionTool,
  promptCachingPlanFor,
} from "@intentface/latch-core";

/**
 * Live proof that the caching plan actually caches on the real Anthropic API:
 * turn 1 must report cache WRITES, turn 2 (same prefix + one appended user
 * message, within the 5m TTL) must report cache READS. Mirrors buildTurn's
 * request shape (marked tool, split system messages, request-level rolling
 * breakpoint). Skipped unless LIVE_CACHE=1 (needs ANTHROPIC_API_KEY):
 *   LIVE_CACHE=1 npx vitest run prompt-caching.live
 */
const live = process.env.LIVE_CACHE === "1";

// Well past every model family's minimum cacheable prefix (512–4096 tokens).
const PADDING = Array.from(
  { length: 400 },
  (_, i) =>
    `Rule ${i}: when handling scenario ${i}, respond precisely, cite the relevant constraint, and prefer the simplest compliant action over cleverness.`,
).join("\n");

const MODEL_ID = "claude-sonnet-4-6";

describe.skipIf(!live)("prompt caching (LIVE Anthropic calls)", () => {
  it("writes cache on turn 1 and reads it on turn 2", async () => {
    const plan = promptCachingPlanFor("anthropic", { agent: "live-cache-test" })!;
    const tools: Record<string, unknown> = {
      echo: {
        description: "Echo the input back.",
        inputSchema: jsonSchema<{ q: string }>({
          type: "object",
          properties: { q: { type: "string" } },
          required: ["q"],
          additionalProperties: false,
        }),
        execute: async ({ q }: { q: string }) => q,
      },
    };
    markLastFunctionTool(tools, plan.toolProviderOptions!);

    // Unique per invocation: a rerun inside the 5m TTL would otherwise find
    // the PREVIOUS run's cache and report a read (not a write) on turn 1.
    const stamp = `Test invocation ${Date.now()}-${Math.random().toString(36).slice(2)}.`;
    const agent = new ToolLoopAgent({
      model: anthropic(MODEL_ID),
      instructions: [
        {
          role: "system",
          content: `You are a terse test agent. Answer in one short sentence.\n${stamp}\n\n${PADDING}`,
          providerOptions: plan.systemProviderOptions,
        },
        { role: "system", content: currentDateLine() },
      ],
      tools,
      providerOptions: plan.requestProviderOptions,
    } as unknown as ConstructorParameters<typeof ToolLoopAgent>[0]);

    const turn1 = await agent.generate({
      prompt: [{ role: "user", content: "Say hello." }],
    } as unknown as Parameters<typeof agent.generate>[0]);
    const w1 = turn1.totalUsage.inputTokenDetails?.cacheWriteTokens ?? 0;
    expect(w1, "turn 1 writes the prefix to cache").toBeGreaterThan(0);

    const turn2 = await agent.generate({
      prompt: [
        { role: "user", content: "Say hello." },
        { role: "assistant", content: turn1.text || "Hello." },
        { role: "user", content: "Now say goodbye." },
      ],
    } as unknown as Parameters<typeof agent.generate>[0]);
    const r2 = turn2.totalUsage.inputTokenDetails?.cacheReadTokens ?? 0;
    expect(r2, "turn 2 reads the cached prefix back").toBeGreaterThan(0);
  }, 120_000);
});

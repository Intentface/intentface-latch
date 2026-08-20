import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { jsonSchema } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import {
  createRuntime,
  currentDateLine,
  defineAgent,
  defineContext,
  promptCachingPlanFor,
} from "@intentface/latch-core";
import { createSqliteAdapter, migrate, schema } from "@intentface/latch-drizzle";

/**
 * End-to-end wiring test for prompt caching (mock model, no network): with a
 * `resolvePromptCaching` hook the turn must (1) split the system prompt into a
 * MARKED instructions message + an unmarked date-line message, (2) put a
 * cache_control marker on the last function tool, (3) send the rolling
 * request-level cacheControl in call providerOptions — and stay byte-identical
 * to the old single-string path when the hook returns nothing or the turn opts
 * out (`promptCaching: false`).
 */

type P = { orgId: string; userId: string };
const principal: P = { orgId: "org", userId: "user" };

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const textStream = (text: string) =>
  new ReadableStream({
    start(c) {
      for (const p of [
        { type: "stream-start", warnings: [] },
        { type: "response-metadata", id: "r", modelId: "mock", timestamp: new Date(0) },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: text },
        { type: "text-end", id: "t1" },
        { type: "finish", finishReason: "stop", usage },
      ])
        c.enqueue(p);
      c.close();
    },
  });

const echoTool = {
  description: "echoes",
  inputSchema: jsonSchema<{ q: string }>({
    type: "object",
    properties: { q: { type: "string" } },
    required: ["q"],
    additionalProperties: false,
  }),
  execute: async ({ q }: { q: string }) => q,
};

async function makeRuntime(model: MockLanguageModelV3, opts?: { caching?: boolean }) {
  const client = createClient({ url: ":memory:" });
  await migrate(client);
  const db = drizzle(client, { schema });
  return createRuntime<P, { orgId: string }>({
    storage: createSqliteAdapter<P>(db, { owner: (p) => [p.orgId, p.userId] }),
    context: defineContext<P, { orgId: string }>({
      build: ({ principal: p }) => ({ orgId: p.orgId }),
    }),
    agents: {
      cached: defineAgent<P>({
        model: model as never,
        instructions: "You are a cached test agent.",
        tools: { echo: echoTool } as never,
      }),
    },
    ...(opts?.caching === false
      ? {}
      : {
          resolvePromptCaching: (_modelId, { agent }) =>
            promptCachingPlanFor("anthropic", { agent }),
        }),
  });
}

interface CapturedCall {
  prompt: Array<{ role: string; content: unknown; providerOptions?: Record<string, unknown> }>;
  tools?: Array<{ name: string; providerOptions?: Record<string, unknown> }>;
  providerOptions?: Record<string, unknown>;
}

function capturingModel(calls: CapturedCall[]) {
  return new MockLanguageModelV3({
    doStream: async (options) => {
      calls.push(options as unknown as CapturedCall);
      return { stream: textStream("ok") };
    },
  });
}

async function runTurn(
  runtime: Awaited<ReturnType<typeof makeRuntime>>,
  input?: { promptCaching?: boolean },
) {
  if (input?.promptCaching === false) {
    await runtime.runAgent({ principal, agent: "cached", prompt: "hi", promptCaching: false });
    return;
  }
  const res = await runtime.handleChat({
    agent: "cached",
    chatId: `chat_${Math.random().toString(36).slice(2)}`,
    principal,
    message: { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] } as never,
  });
  if (res.body) for await (const _ of res.body as unknown as AsyncIterable<unknown>) void _;
}

const CACHE = { anthropic: { cacheControl: { type: "ephemeral" } } };

describe("prompt-caching request wiring", () => {
  it("splits the system prompt: marked instructions, unmarked trailing date line", async () => {
    const calls: CapturedCall[] = [];
    const runtime = await makeRuntime(capturingModel(calls));
    await runTurn(runtime);

    expect(calls).toHaveLength(1);
    const systems = calls[0]!.prompt.filter((m) => m.role === "system");
    expect(systems).toHaveLength(2);
    expect(systems[0]!.content).toBe("You are a cached test agent.");
    expect(systems[0]!.providerOptions).toEqual(CACHE);
    expect(systems[1]!.content).toBe(currentDateLine());
    expect(systems[1]!.providerOptions ?? undefined).toBeUndefined();
  });

  it("marks the last function tool and sends the rolling call-level cacheControl", async () => {
    const calls: CapturedCall[] = [];
    const runtime = await makeRuntime(capturingModel(calls));
    await runTurn(runtime);

    const call = calls[0]!;
    expect(call.providerOptions).toMatchObject(CACHE);
    const echo = call.tools?.find((t) => t.name === "echo");
    expect(echo, "the agent tool reached the model").toBeTruthy();
    expect(echo!.providerOptions).toEqual(CACHE);
  });

  it("keeps the legacy single system string without a caching hook", async () => {
    const calls: CapturedCall[] = [];
    const runtime = await makeRuntime(capturingModel(calls), { caching: false });
    await runTurn(runtime);

    const systems = calls[0]!.prompt.filter((m) => m.role === "system");
    expect(systems).toHaveLength(1);
    expect(systems[0]!.content).toBe(
      `You are a cached test agent.\n\n${currentDateLine()}`,
    );
    expect(calls[0]!.providerOptions ?? undefined).toBeUndefined();
  });

  it("promptCaching:false opts a single turn out even with the hook present", async () => {
    const calls: CapturedCall[] = [];
    const runtime = await makeRuntime(capturingModel(calls));
    await runTurn(runtime, { promptCaching: false });

    const systems = calls[0]!.prompt.filter((m) => m.role === "system");
    expect(systems).toHaveLength(1);
    expect(calls[0]!.providerOptions ?? undefined).toBeUndefined();
    const echo = calls[0]!.tools?.find((t) => t.name === "echo");
    expect(echo?.providerOptions ?? undefined).toBeUndefined();
  });
});

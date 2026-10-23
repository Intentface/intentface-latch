import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { tool } from "ai";
import { z } from "zod";
import { createRuntime } from "./runtime.js";
import { defineContext } from "./context.js";
import { defineAgent } from "./agent.js";
import type { StorageAdapter } from "./storage.js";
import { memoryStorage } from "./__tests__/memory-storage.js";
import { chunksOf, principal, user, type P } from "./__tests__/turn.js";

/**
 * Stopping an answer: `stopRun` (same server, or another one through the run
 * row), `runAgent`'s `abortSignal`, and a stopped parent's subagent. The step
 * being written is dropped (its reasoning and text were cut off); steps that
 * finished are saved, marked `stopped`, and the run completes.
 */

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

/**
 * A model that says "w0 w1 w2 …" one word every `everyMs`, like a provider
 * stream: it ends with the abort reason when the call's signal aborts, unless
 * `ignoreAbort`, when it keeps going and the SDK sees the abort between chunks.
 */
function slowModel(words = 200, everyMs = 10, ignoreAbort = false) {
  return new MockLanguageModelV4({
    modelId: "slow",
    doStream: (async ({ abortSignal }: { abortSignal?: AbortSignal }) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "t" });
          let i = 0;
          const next = () => {
            if (i === words) {
              controller.enqueue({ type: "text-end", id: "t" });
              controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage });
              controller.close();
              return;
            }
            controller.enqueue({ type: "text-delta", id: "t", delta: `w${i++} ` });
            timer = setTimeout(next, everyMs);
          };
          if (!ignoreAbort)
            abortSignal?.addEventListener("abort", () => {
              clearTimeout(timer);
              controller.error(abortSignal.reason);
            });
          next();
        },
      });
      return { stream };
    }) as never,
  });
}

/** Step 1 looks something up (reasoning and a tool call); step 2 reasons and talks slowly. */
function lookupThenSlowModel() {
  const slow = slowModel();
  let n = 0;
  return new MockLanguageModelV4({
    modelId: "lookup-then-slow",
    doStream: (async (options: { abortSignal?: AbortSignal }) => {
      if (n++ > 0) return (slow.doStream as (o: unknown) => Promise<unknown>)(options);
      const chunks = [
        { type: "stream-start", warnings: [] },
        { type: "reasoning-start", id: "r" },
        { type: "reasoning-delta", id: "r", delta: "I should look it up." },
        { type: "reasoning-end", id: "r", providerMetadata: { anthropic: { signature: "sig_1" } } },
        { type: "tool-call", toolCallId: "call_1", toolName: "lookup", input: "{}" },
        { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage },
      ];
      return { stream: new ReadableStream({ start: (c) => (chunks.forEach((x) => c.enqueue(x)), c.close()) }) };
    }) as never,
  });
}

/** A model whose first call delegates to `child`, and whose second answers. */
function delegatingModel() {
  let n = 0;
  return new MockLanguageModelV4({
    modelId: "parent",
    doStream: (async () => {
      const chunks =
        n++ === 0
          ? [
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: "spawn_1", toolName: "spawn_agent", input: JSON.stringify({ agent: "child", prompt: "go" }) },
              { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage },
            ]
          : [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: "done" },
              { type: "text-end", id: "t" },
              { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
            ];
      return { stream: new ReadableStream({ start: (c) => (chunks.forEach((x) => c.enqueue(x)), c.close()) }) };
    }) as never,
  });
}

/** Memory storage with `requestStop`, as an adapter that supports stops across servers has. */
function stoppableStorage() {
  const mem = memoryStorage<P>();
  const storage: StorageAdapter<P> = {
    ...mem.storage,
    async requestStop(_p, chatId) {
      const run = [...mem.runs.values()].find((r) => r.chatId === chatId && r.status === "active");
      if (!run) return null;
      mem.runs.set(run.id, { ...run, stopRequestedAt: Date.now() });
      return run.id;
    },
  };
  return { ...mem, storage };
}

function runtimeOn(storage: StorageAdapter<P>, model: MockLanguageModelV4, stopCheckMs?: number | false) {
  return createRuntime<P>({
    storage,
    context: defineContext<P, unknown>({ build: async () => ({}) }),
    ...(stopCheckMs !== undefined ? { stopCheckMs } : {}),
    agents: { a: defineAgent<P>({ model, instructions: "Talk." }) },
  });
}

const waitFor = async (check: () => boolean, ms = 2000) => {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

const textOf = (m: { parts: unknown[] } | undefined) =>
  (m?.parts ?? []).map((p) => (p as { type: string; text?: string }).text ?? "").join("");

describe("stopRun", () => {
  it("stops an answer on this server: the client sees it end, and the cut-off step isn't saved", async () => {
    const mem = memoryStorage<P>();
    const runtime = runtimeOn(mem.storage, slowModel());
    const res = await runtime.handleChat({ agent: "a", principal, chatId: "c1", message: user("talk") });
    const chunks = chunksOf(res);
    await waitFor(() => textOf(mem.messages.get("c1")?.at(-1)).length > 0 || [...mem.runs.values()].some((r) => r.status === "active"));
    await new Promise((r) => setTimeout(r, 60));

    const stopped = await runtime.stopRun({ principal, chatId: "c1" });
    const run = [...mem.runs.values()].at(-1)!;
    expect(stopped).toEqual({ runId: run.id });

    const received = await chunks;
    expect(received.map((c) => c.type)).toContain("abort");
    expect(received.some((c) => c.type === "text-delta")).toBe(true);
    await waitFor(() => mem.runs.get(run.id)!.status !== "active");
    expect(mem.runs.get(run.id)).toMatchObject({ status: "completed", endedAt: expect.any(Number) });
    // Only the question: the one step was cut off, so there's no answer to keep.
    expect(mem.messages.get("c1")!.map((m) => m.role)).toEqual(["user"]);
  });

  it("keeps the steps that finished, with their tools, and drops the one in progress", async () => {
    const mem = memoryStorage<P>();
    const lookups: string[] = [];
    const runtime = createRuntime<P>({
      storage: mem.storage,
      context: defineContext<P, unknown>({ build: async () => ({}) }),
      agents: {
        a: defineAgent<P>({
          model: lookupThenSlowModel(),
          instructions: "Look, then talk.",
          tools: { lookup: tool({ inputSchema: z.object({}), execute: async () => (lookups.push("ran"), "42") }) },
        }),
      },
    });
    const chunks = chunksOf(await runtime.handleChat({ agent: "a", principal, chatId: "c1", message: user("talk") }));
    await waitFor(() => lookups.length === 1);
    await new Promise((r) => setTimeout(r, 60));
    await runtime.stopRun({ principal, chatId: "c1" });
    await chunks;
    await waitFor(() => [...mem.runs.values()].at(-1)!.status === "completed");

    const answer = mem.messages.get("c1")!.at(-1)!;
    expect(answer.role).toBe("assistant");
    expect(answer.metadata?.stopped).toBe(true);
    const types = answer.parts.map((p) => p.type);
    expect(types).toEqual(["step-start", "reasoning", "tool-lookup"]);
    expect(answer.parts[2]).toMatchObject({ state: "output-available", output: "42" });
    expect(textOf(answer)).not.toContain("w0");
  });

  it("returns null when nothing is running in the chat", async () => {
    const mem = memoryStorage<P>();
    const runtime = runtimeOn(mem.storage, slowModel(2, 0));
    await chunksOf(await runtime.handleChat({ agent: "a", principal, chatId: "c1", message: user("talk") }));
    expect(await runtime.stopRun({ principal, chatId: "c1" })).toBeNull();
    expect(await runtime.stopRun({ principal, chatId: "nope" })).toBeNull();
    expect(mem.messages.get("c1")!.at(-1)!.metadata?.stopped).toBeUndefined();
  });

  it("stops an answer running on another server, through the run row", async () => {
    const shared = stoppableStorage();
    const running = runtimeOn(shared.storage, slowModel(), 20);
    const other = runtimeOn(shared.storage, slowModel(), 20);
    const chunks = chunksOf(await running.handleChat({ agent: "a", principal, chatId: "c1", message: user("talk") }));
    await new Promise((r) => setTimeout(r, 60));

    const run = [...shared.runs.values()].at(-1)!;
    expect(await other.stopRun({ principal, chatId: "c1" })).toEqual({ runId: run.id });
    expect(shared.runs.get(run.id)!.stopRequestedAt).toEqual(expect.any(Number));

    const startedWaiting = Date.now();
    expect((await chunks).map((c) => c.type)).toContain("abort");
    expect(Date.now() - startedWaiting).toBeLessThan(500);
    await waitFor(() => shared.runs.get(run.id)!.status === "completed");
    expect(shared.messages.get("c1")!.map((m) => m.role)).toEqual(["user"]);
  });

  it("doesn't check the row when stopCheckMs is false", async () => {
    const shared = stoppableStorage();
    const running = runtimeOn(shared.storage, slowModel(10, 10), false);
    const other = runtimeOn(shared.storage, slowModel(), false);
    const chunks = chunksOf(await running.handleChat({ agent: "a", principal, chatId: "c1", message: user("talk") }));
    await new Promise((r) => setTimeout(r, 30));
    await other.stopRun({ principal, chatId: "c1" });
    expect((await chunks).map((c) => c.type)).not.toContain("abort");
    expect(textOf(shared.messages.get("c1")!.at(-1))).toContain("w9");
  });
});

describe("runAgent abortSignal", () => {
  it("returns stopped, without the cut-off step", async () => {
    const mem = memoryStorage<P>();
    const runtime = runtimeOn(mem.storage, slowModel());
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 60);
    const result = await runtime.runAgent({ principal, agent: "a", prompt: "talk", abortSignal: controller.signal });
    expect(result.stopped).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.answer).toBe("");
    expect([...mem.runs.values()].at(-1)!.status).toBe("completed");
  });

  it("doesn't call a lost lease a stop", async () => {
    const mem = memoryStorage<P>();
    const storage: StorageAdapter<P> = {
      ...mem.storage,
      async claimRun(input) {
        const run = await mem.storage.createRun(input.principal, { chatId: input.chatId, agent: input.agent });
        const leased = { ...run, leaseOwner: input.owner, fencingToken: 1 };
        mem.runs.set(run.id, leased);
        return leased;
      },
      // Another server took the run over.
      async heartbeatRun() {
        return false;
      },
    };
    const runtime = createRuntime<P>({
      storage,
      context: defineContext<P, unknown>({ build: async () => ({}) }),
      durability: { enabled: true, heartbeatMs: 30 },
      agents: { a: defineAgent<P>({ model: slowModel(30, 10, true), instructions: "Talk." }) },
    });
    const result = await runtime.runAgent({ principal, agent: "a", prompt: "talk" });
    expect(result.stopped).toBeUndefined();
    expect(result.error).toBeDefined();
    expect([...mem.runs.values()].at(-1)!.status).toBe("errored");
  });

  it("stops a subagent along with the run that spawned it", async () => {
    const mem = memoryStorage<P>();
    const runtime = createRuntime<P>({
      storage: mem.storage,
      context: defineContext<P, unknown>({ build: async () => ({}) }),
      agents: {
        parent: defineAgent<P>({ model: delegatingModel(), instructions: "Delegate.", subagents: ["child"] }),
        child: defineAgent<P>({ model: slowModel(), instructions: "Talk." }),
      },
    });
    const controller = new AbortController();
    const result = runtime.runAgent({ principal, agent: "parent", prompt: "go", abortSignal: controller.signal });
    await waitFor(() => [...mem.runs.values()].filter((r) => r.status === "active").length === 2);
    await new Promise((r) => setTimeout(r, 40));
    controller.abort();
    expect((await result).stopped).toBe(true);

    const runs = [...mem.runs.values()];
    await waitFor(() => runs.every((r) => mem.runs.get(r.id)!.status !== "active"));
    const child = runs.find((r) => r.agent === "child")!;
    expect(mem.runs.get(child.id)!.status).toBe("completed");
    expect(mem.messages.get(child.chatId)!.map((m) => m.role)).toEqual(["user"]);
  });
});

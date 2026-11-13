import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { createResumableStreamContext, type Publisher, type Subscriber } from "resumable-stream/generic";
import { chunksOf, principal, user } from "./__tests__/turn.js";
import { memoryStorage } from "./__tests__/memory-storage.js";
import { createRuntime } from "./runtime.js";
import { defineAgent } from "./agent.js";
import { memoryLiveStreams, type LiveStreams } from "./live-stream.js";

/**
 * Live streams: a request other than the one that started an answer reads
 * that answer's stream, from its start. Checked with the in-memory store and
 * with the `resumable-stream` package over a pub/sub that stands in for Redis.
 */

/** A model whose n-th answer is written only once `release(n)` is called. */
function gated(answers: string[]) {
  const gates = answers.map(() => {
    let open!: () => void;
    const wait = new Promise<void>((resolve) => (open = resolve));
    return { open, wait };
  });
  let n = 0;
  const model = new MockLanguageModelV4({
    modelId: "mock",
    doStream: (async () => {
      const i = Math.min(n++, answers.length - 1);
      const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } };
      return {
        stream: new ReadableStream({
          async start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "t0" });
            await gates[i]!.wait;
            controller.enqueue({ type: "text-delta", id: "t0", delta: answers[i]! });
            controller.enqueue({ type: "text-end", id: "t0" });
            controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage });
            controller.close();
          },
        }),
      };
    }) as never,
  });
  return { model, release: (i: number) => gates[i]!.open() };
}

/** Redis's part of `resumable-stream`: keys and pub/sub, in memory. */
function fakeRedis(): { publisher: Publisher; subscriber: Subscriber } {
  const keys = new Map<string, string>();
  const channels = new Map<string, (message: string) => void>();
  return {
    publisher: {
      connect: async () => {},
      publish: async (channel, message) => {
        const to = channels.get(channel);
        if (to) queueMicrotask(() => to(message));
        return to ? 1 : 0;
      },
      set: async (key, value) => {
        keys.set(key, value);
        return "OK";
      },
      get: async (key) => keys.get(key) ?? null,
      incr: async (key) => {
        const next = Number(keys.get(key) ?? 0) + 1;
        keys.set(key, String(next));
        return next;
      },
    },
    subscriber: {
      connect: async () => {},
      subscribe: async (channel, callback) => {
        channels.set(channel, callback);
      },
      unsubscribe: async (channel) => {
        channels.delete(channel);
      },
    },
  };
}

/** `LiveStreams` over `resumable-stream`: the whole adapter a host writes. */
function resumableLiveStreams(): LiveStreams {
  const streams = createResumableStreamContext({ waitUntil: null, ...fakeRedis() });
  return {
    publish: async (id, stream) => {
      await streams.createNewResumableStream(id, () => stream);
    },
    subscribe: async (id) => (await streams.resumeExistingStream(id)) ?? null,
  };
}

const stores: [string, () => LiveStreams][] = [
  ["in memory", memoryLiveStreams],
  ["resumable-stream", resumableLiveStreams],
];

const setup = (liveStreams: LiveStreams | undefined, answers: string[]) => {
  const mem = memoryStorage<typeof principal>();
  const { model, release } = gated(answers);
  const background: Promise<unknown>[] = [];
  const runtime = createRuntime<typeof principal>({
    storage: mem.storage,
    agents: { a: defineAgent<typeof principal>({ model, instructions: "Be brief." }) },
    waitUntil: (work) => void background.push(work),
    ...(liveStreams ? { liveStreams } : {}),
  });
  const send = (text: string, id: string, queue = false) =>
    runtime.handleChat({ agent: "a", principal, chatId: "chat_1", message: user(text, id), ...(queue ? { ifBusy: "queue" as const } : {}) });
  const settle = async () => {
    for (let i = 0; i < background.length; i++) await background[i];
  };
  return { mem, runtime, release, send, settle };
};

const textOf = (chunks: Array<Record<string, unknown>>) =>
  chunks.filter((c) => c.type === "text-delta").map((c) => c.delta).join("");

describe.each(stores)("a running answer's stream, kept %s", (_name, store) => {
  it("is read from its start by a second request", async () => {
    const t = setup(store(), ["a1"]);
    const first = await t.send("q1", "u1");
    const second = await t.runtime.streamChat({ chatId: "chat_1", principal });
    expect(second).not.toBeNull();
    t.release(0);
    const [mine, theirs] = await Promise.all([chunksOf(first), chunksOf(second!)]);
    expect(textOf(theirs)).toBe("a1");
    expect(theirs).toEqual(mine);
  });

  it("is there for the answer to a held message, which no request is attached to", async () => {
    const t = setup(store(), ["a1", "a2"]);
    const first = await t.send("q1", "u1");
    expect((await t.send("q2", "u2", true)).status).toBe(202);
    t.release(0);
    await first.text();
    // The first answer's request is over. The held turn starts after it.
    await expect.poll(async () => (await t.runtime.pollChat({ chatId: "chat_1", principal }))!.running).toBe(true);
    const live = await t.runtime.streamChat({ chatId: "chat_1", principal });
    expect(live).not.toBeNull();
    t.release(1);
    expect(textOf(await chunksOf(live!))).toBe("a2");
    await t.settle();
    expect(t.mem.messages.get("chat_1")!.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("is gone once the answer has ended", async () => {
    const t = setup(store(), ["a1"]);
    const first = await t.send("q1", "u1");
    t.release(0);
    await first.text();
    await t.settle();
    expect(await t.runtime.streamChat({ chatId: "chat_1", principal })).toBeNull();
  });
});

describe("streamChat", () => {
  it("returns nothing when the runtime keeps no live streams, or the chat isn't there", async () => {
    const t = setup(undefined, ["a1"]);
    const first = await t.send("q1", "u1");
    expect(await t.runtime.streamChat({ chatId: "chat_1", principal })).toBeNull();
    t.release(0);
    await first.text();
    expect(await setup(memoryLiveStreams(), ["a1"]).runtime.streamChat({ chatId: "nope", principal })).toBeNull();
  });

  it("lets the answer go on when its stream can't be published", async () => {
    const t = setup({ publish: async () => Promise.reject(new Error("redis down")), subscribe: async () => null }, ["a1"]);
    const first = await t.send("q1", "u1");
    t.release(0);
    expect(textOf(await chunksOf(first))).toBe("a1");
  });
});

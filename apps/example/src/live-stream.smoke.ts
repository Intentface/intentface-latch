import { createClient as createRedis } from "redis";
import { createResumableStreamContext } from "resumable-stream";
import { createClient } from "@libsql/client";
import { AbstractChat, DefaultChatTransport, type ChatState, type UIMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { createRuntime, defineAgent, defineContext, type ChatEvent, type LiveStreams } from "@intentface/latch-core";
import { createSqliteAdapter, migrate } from "@intentface/latch-drizzle";
import { createLatchHandler } from "@intentface/latch-server";
import { assert, latchDb, owner, type Principal } from "./setup.js";

/**
 * Live streams over a real Redis (Valkey), across two server instances, read
 * by the AI SDK's own chat client. No model key: the model is scripted.
 *
 *   valkey-server --port 6390 &
 *   REDIS_URL=redis://127.0.0.1:6390 pnpm --filter @intentface/latch-example smoke:live-stream
 *
 * Instance A and instance B are two runtimes with their own Redis
 * connections and one database, as two serverless functions would be. Tab 1
 * talks to A, tab 2 to B. Tab 2 never sends anything: it watches the chat
 * (`GET chats/:id/events`) and reads each answer live (`GET chats/:id/stream`).
 */

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6390";

/** `LiveStreams` over Redis: what a host writes. Two connections, as pub/sub needs. */
async function redisLiveStreams(): Promise<{ live: LiveStreams; close: () => Promise<void> }> {
  const publisher = createRedis({ url: REDIS_URL });
  const subscriber = publisher.duplicate();
  await Promise.all([publisher.connect(), subscriber.connect()]);
  const streams = createResumableStreamContext({ waitUntil: null, publisher, subscriber });
  const live: LiveStreams = {
    publish: async (id, stream) => {
      await streams.createNewResumableStream(id, () => stream);
    },
    subscribe: async (id) => (await streams.resumeExistingStream(id)) ?? null,
    notify: async (channel, message) => {
      await publisher.publish(`latch:${channel}`, message);
    },
    listen: async (channel) => {
      let listener: ((message: string) => void) | undefined;
      return new ReadableStream<string>({
        async start(controller) {
          listener = (message) => controller.enqueue(message);
          await subscriber.subscribe(`latch:${channel}`, listener);
        },
        async cancel() {
          if (listener) await subscriber.unsubscribe(`latch:${channel}`, listener);
        },
      });
    },
  };
  return { live, close: async () => void (await Promise.all([publisher.quit(), subscriber.quit()])) };
}

/** A model whose n-th answer comes in two halves, each written when released. */
function gated(answers: [string, string][]) {
  const gate = () => {
    let open!: () => void;
    const wait = new Promise<void>((resolve) => (open = resolve));
    return { open, wait };
  };
  const gates = answers.map(() => [gate(), gate()] as const);
  let n = 0;
  const model = new MockLanguageModelV4({
    modelId: "mock",
    doStream: (async () => {
      const i = Math.min(n++, answers.length - 1);
      return {
        stream: new ReadableStream({
          async start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "t0" });
            await gates[i]![0].wait;
            controller.enqueue({ type: "text-delta", id: "t0", delta: answers[i]![0] });
            await gates[i]![1].wait;
            controller.enqueue({ type: "text-delta", id: "t0", delta: answers[i]![1] });
            controller.enqueue({ type: "text-end", id: "t0" });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
            });
            controller.close();
          },
        }),
      };
    }) as never,
  });
  return { model, release: (answer: number, half: 0 | 1) => gates[answer]![half].open() };
}

/** The AI SDK chat client `useChat` wraps, with plain state in place of React's. */
class Tab extends AbstractChat<UIMessage> {
  constructor(chatId: string, fetchFrom: typeof fetch) {
    const state: ChatState<UIMessage> = {
      status: "ready",
      error: undefined,
      messages: [],
      pushMessage: (m) => void state.messages.push(m),
      popMessage: () => void state.messages.pop(),
      replaceMessage: (i, m) => void (state.messages[i] = m),
      snapshot: (thing) => structuredClone(thing),
    };
    super({
      id: chatId,
      state,
      transport: new DefaultChatTransport({
        api: `http://latch.test/api/agents/assistant/${chatId}`,
        fetch: fetchFrom,
        prepareSendMessagesRequest: ({ messages, body }) => ({ body: { ...body, message: messages.at(-1) } }),
        prepareReconnectToStreamRequest: () => ({ api: `http://latch.test/api/chats/${chatId}/stream` }),
      }),
    });
  }
  text(): string[] {
    return this.messages.map(
      (m) => `${m.role}: ${m.parts.filter((p): p is { type: "text"; text: string } => p.type === "text").map((p) => p.text).join("")}`,
    );
  }
}

const until = async (what: string, check: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert(false, `timed out waiting for: ${what}`);
};

async function main() {
  const client = createClient({ url: ":memory:" });
  await migrate(client);
  const storage = createSqliteAdapter<Principal>(latchDb(client), { owner });
  const { model, release } = gated([
    ["Hel", "lo."],
    ["Sec", "ond."],
    ["Thi", "rd."],
  ]);
  const me: Principal = { orgId: "org_a", userId: "user_1" };

  const instance = async () => {
    const redis = await redisLiveStreams();
    const background: Promise<unknown>[] = [];
    const runtime = createRuntime<Principal>({
      storage,
      context: defineContext<Principal, unknown>({ build: async () => ({}) }),
      agents: { assistant: defineAgent<Principal>({ model, instructions: "Be brief." }) },
      liveStreams: redis.live,
      waitUntil: (work) => void background.push(work),
    });
    const handler = createLatchHandler<Principal>({
      runtime,
      connections: { oauth: () => undefined, status: async () => [], testTools: async () => [] } as never,
      basePath: "/api",
      resolvePrincipal: () => me,
    });
    const fetchFrom = (async (input: RequestInfo | URL, init?: RequestInit) =>
      (await handler(new Request(input, init))) ?? new Response("no route", { status: 404 })) as typeof fetch;
    return { runtime, fetchFrom, background, close: redis.close };
  };
  const a = await instance();
  const b = await instance();

  const chatId = "chat_1";
  const tab1 = new Tab(chatId, a.fetchFrom);
  const tab2 = new Tab(chatId, b.fetchFrom);

  // Tab 1 creates the chat with a first answer.
  const first = tab1.sendMessage({ text: "hi" });
  release(0, 0);
  release(0, 1);
  await first;
  assert(tab1.text().join(" | ") === "user: hi | assistant: Hello.", `tab 1 got its answer (${tab1.text().join(" | ")})`);

  // Tab 2 opens the chat on the other instance: history, then it watches.
  const history = (await (await b.fetchFrom(`http://latch.test/api/chats/${chatId}/poll`)).json()) as { messages: UIMessage[] };
  tab2.messages = history.messages;
  const seen: ChatEvent[] = [];
  const stop = new AbortController();
  const events = await b.fetchFrom(`http://latch.test/api/chats/${chatId}/events`, { signal: stop.signal });
  assert(events.status === 200, `events route answers 200 (got ${events.status})`);
  let reading: Promise<void> = Promise.resolve();
  void (async () => {
    const reader = events.body!.pipeThrough(new TextDecoderStream()).getReader();
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done || !value) return;
      for (const line of value.split("\n\n")) {
        if (!line.startsWith("data: ")) continue;
        const event = JSON.parse(line.slice(6)) as ChatEvent;
        seen.push(event);
        // What a page does. An answer started: take the history (the message
        // that started it may have come from elsewhere), then read the
        // answer. Anything else: the history, once no answer is being read.
        const refresh = async () => {
          const poll = (await (await b.fetchFrom(`http://latch.test/api/chats/${chatId}/poll`)).json()) as { messages: UIMessage[] };
          tab2.messages = poll.messages;
        };
        if (event.type === "started") reading = reading.then(refresh).then(() => tab2.resumeStream());
        else reading = reading.then(refresh);
      }
    }
  })();
  const types = () => seen.map((e) => e.type).join(",");
  await until("hello", () => seen.length === 1);
  assert(JSON.stringify(seen[0]) === JSON.stringify({ type: "hello", running: false }), "tab 2 is told nothing is running");

  // 1. Tab 1 sends a message on instance A. Tab 2, on B, is told and reads it live.
  const second = tab1.sendMessage({ text: "again" });
  await until("started on B", () => types() === "hello,started");
  release(1, 0);
  await until("first half on tab 2", () => tab2.text().at(-1) === "assistant: Sec");
  assert(tab1.text().at(-1) === "assistant: Sec", "tab 1 shows the first half");
  assert(true, "tab 2 shows the first half of an answer written on the other instance, before it is finished");
  release(1, 1);
  await second;
  await until("answer ended on tab 2", () => tab2.text().at(-1) === "assistant: Second." && tab2.status === "ready");
  await until("ended event", () => types() === "hello,started,ended");
  // The user's message was sent from tab 1; tab 2 got it from the history.
  await until("tab 2 has tab 1's message", () => tab2.text().join(" | ") === "user: hi | assistant: Hello. | user: again | assistant: Second.");
  assert(true, `tab 2 ends with the same conversation as tab 1 (${tab2.text().length} messages)`);

  // 2. A signal from server code, with nobody's request attached, sent on
  //    instance A. Tab 2 on B reads the answer live.
  const signal = a.runtime.sendSignal({ chatId, principal: me, text: "The export is ready.", visibility: "user" });
  await until("signal's answer started", () => types() === "hello,started,ended,started");
  release(2, 0);
  await until("first half of the signal's answer on tab 2", () => tab2.text().at(-1) === "assistant: Thi");
  assert(true, "tab 2 reads the answer to a signal live");
  release(2, 1);
  await signal;
  await until("signal's answer ended on tab 2", () => tab2.text().at(-1) === "assistant: Third." && tab2.status === "ready");
  await until("ended event", () => types() === "hello,started,ended,started,ended");

  // 3. Nothing running: the stream route says so, and the client takes it.
  const none = await b.fetchFrom(`http://latch.test/api/chats/${chatId}/stream`);
  assert(none.status === 204, `stream route answers 204 with nothing running (got ${none.status})`);
  await tab2.resumeStream();
  assert(tab2.status === "ready" && tab2.error === undefined, "resuming with nothing running leaves the tab as it was");

  stop.abort();
  await Promise.all([reading, ...a.background, ...b.background]);
  await Promise.all([a.close(), b.close()]);
  console.log("live-stream smoke: ok");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);

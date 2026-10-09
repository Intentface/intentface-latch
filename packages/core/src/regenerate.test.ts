import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { simulateReadableStream } from "ai";
import { createRuntime, resumeShapeOf } from "./runtime.js";
import { DAY_MS, LimitExceededError, usageKey, type LimitStore, type LimitUsage } from "./limits.js";
import { defineContext } from "./context.js";
import { defineAgent } from "./agent.js";
import { isInvalidMessageError, RewindNotSupportedError, type AppMessage } from "./message.js";
import { memoryStorage } from "./__tests__/memory-storage.js";

/**
 * What a stock `useChat` client sends beyond a plain new message: parts with
 * fields of its own, and `regenerate()`, which resends the last user message
 * to get a fresh answer. A regenerate hides the answers it replaces from the
 * user and the model (it never deletes them) and runs again from that message.
 */

type P = { orgId: string };
const principal: P = { orgId: "org_a" };

/** Answers "answer 1", "answer 2", … and keeps every prompt it was given. */
function answering() {
  let n = 0;
  const prompts: string[] = [];
  const model = new MockLanguageModelV4({
    modelId: "mock",
    doStream: (async (opts: { prompt: unknown }) => {
      prompts.push(JSON.stringify(opts.prompt));
      n++;
      return {
        stream: simulateReadableStream({
          initialDelayInMs: 0,
          chunkDelayInMs: 0,
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: `answer ${n}` },
            { type: "text-end", id: "t" },
            { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } },
          ],
        }),
      };
    }) as never,
  });
  return { model, prompts };
}

/** Counters in memory, atomic enough for a single-threaded test. */
function memoryLimits(): LimitStore {
  const rows = new Map<string, LimitUsage>();
  return {
    async read(refs) {
      return Object.fromEntries(refs.map((r) => [usageKey(r), rows.get(usageKey(r)) ?? { turns: 0, tokens: 0, cost: 0 }]));
    },
    async add(entries) {
      const out: Record<string, LimitUsage> = {};
      for (const e of entries) {
        const k = usageKey(e);
        const cur = rows.get(k) ?? { turns: 0, tokens: 0, cost: 0 };
        const next = { turns: cur.turns + (e.usage.turns ?? 0), tokens: cur.tokens + (e.usage.tokens ?? 0), cost: cur.cost + (e.usage.cost ?? 0) };
        rows.set(k, next);
        out[k] = next;
      }
      return out;
    },
  };
}

function setup(opts: { maxTurns?: number } = {}) {
  const mem = memoryStorage();
  const { model, prompts } = answering();
  const rt = createRuntime<P>({
    storage: mem.storage,
    context: defineContext<P, unknown>({ build: async () => ({}) }),
    agents: { a: defineAgent({ model }) },
    ...(opts.maxTurns
      ? { limits: { store: memoryLimits(), limitsFor: () => [{ key: "org:org_a", windowMs: DAY_MS, max: { turns: opts.maxTurns } }] } }
      : {}),
  });
  const send = async (message: AppMessage) => (await rt.handleChat({ agent: "a", chatId: "c", principal, message })).text();
  return { mem, rt, prompts, send };
}

const user = (id: string, text: string): AppMessage => ({ id, role: "user", parts: [{ type: "text", text }] });
const texts = (ms: AppMessage[]) =>
  ms.map((m) => `${m.role}: ${(m.parts as Array<{ type: string; text?: string }>).filter((p) => p.type === "text").map((p) => p.text).join("")}`);

describe("parts a client sends", () => {
  it("are stored with their known fields only", async () => {
    const { send, mem } = setup();
    await send({
      id: "u1",
      role: "user",
      parts: [
        { type: "file", mediaType: "image/png", url: "data:image/png;base64,AAAA", filename: "a.png", providerMetadata: { anthropic: { cacheControl: { type: "ephemeral" } } } },
        { type: "text", text: "what is this?", state: "done", providerMetadata: { anthropic: { cacheControl: { type: "ephemeral" } } } },
      ],
    } as unknown as AppMessage);
    expect(mem.messages.get("c")![0]!.parts).toEqual([
      { type: "file", mediaType: "image/png", url: "data:image/png;base64,AAAA", filename: "a.png" },
      { type: "text", text: "what is this?" },
    ]);
  });

  it("keep a provider file id from the SDK's uploadFile", async () => {
    const { send, mem } = setup();
    await send({
      id: "u1",
      role: "user",
      parts: [{ type: "file", mediaType: "application/pdf", url: "https://example.com/r.pdf", providerReference: { anthropic: "file_011C" } }],
    } as unknown as AppMessage);
    expect(mem.messages.get("c")![0]!.parts).toEqual([
      { type: "file", mediaType: "application/pdf", url: "https://example.com/r.pdf", providerReference: { anthropic: "file_011C" } },
    ]);
  });

  it("are refused when the files sent inline are over the limit", async () => {
    const mem = memoryStorage();
    const { model } = answering();
    const rt = createRuntime<P>({
      storage: mem.storage,
      context: defineContext<P, unknown>({ build: async () => ({}) }),
      agents: { a: defineAgent({ model }) },
      maxInlineFileBytes: 4,
    });
    const send = async (url: string) =>
      (await rt.handleChat({ agent: "a", chatId: "c", principal, message: { id: `u${url.length}`, role: "user", parts: [{ type: "file", mediaType: "image/png", url }] } })).text();
    // 6 bytes inline: refused, nothing stored.
    await expect(send("data:image/png;base64,AAAAAAAA")).rejects.toSatisfy(isInvalidMessageError);
    expect(mem.chats.has("c")).toBe(false);
    // 3 bytes inline, or any size by URL: accepted.
    await send("data:image/png;base64,AAAA");
    await send("https://example.com/huge.png");
    expect(mem.messages.get("c")!.filter((m) => m.role === "user")).toHaveLength(2);
  });

  it("are refused when a text or file part is missing what makes it one", async () => {
    const { send } = setup();
    await expect(send({ id: "u1", role: "user", parts: [{ type: "file", url: "x" }] } as unknown as AppMessage)).rejects.toSatisfy(isInvalidMessageError);
  });
});

describe("regenerate", () => {
  it("hides the old answer and answers again from the same message", async () => {
    const { send, rt, mem, prompts } = setup();
    await send(user("u1", "hi"));
    await send(user("u1", "hi")); // useChat's regenerate(): the last user message, resent unchanged
    // The user sees one question and the new answer…
    expect(texts(await rt.loadHistory({ chatId: "c", principal }))).toEqual(["user: hi", "assistant: answer 2"]);
    // …the model was not shown the answer it replaced…
    expect(prompts[1]).not.toContain("answer 1");
    // …and the old answer is still stored, hidden.
    const old = mem.messages.get("c")!.find((m) => texts([m])[0] === "assistant: answer 1")!;
    expect(old.metadata).toMatchObject({ visibility: "internal", sendToModel: false });
  });

  it("can be repeated", async () => {
    const { send, rt } = setup();
    await send(user("u1", "hi"));
    await send(user("u1", "hi"));
    await send(user("u1", "hi"));
    expect(texts(await rt.loadHistory({ chatId: "c", principal }))).toEqual(["user: hi", "assistant: answer 3"]);
  });

  it("is refused for an earlier question, which belongs in a fork", async () => {
    const { send, mem } = setup();
    await send(user("u1", "first"));
    await send(user("u2", "second"));
    const before = JSON.stringify(mem.messages.get("c"));
    // `regenerate({ messageId })` on the first answer resends "u1" with later messages after it.
    await expect(send(user("u1", "first"))).rejects.toBeInstanceOf(RewindNotSupportedError);
    // …and so does editing it.
    await expect(send(user("u1", "changed"))).rejects.toBeInstanceOf(RewindNotSupportedError);
    expect(JSON.stringify(mem.messages.get("c"))).toBe(before);
  });
});

describe("editing the last question", () => {
  it("answers the new wording and hides the old one with its answer", async () => {
    const { send, rt, mem, prompts } = setup();
    await send(user("u1", "first"));
    await send(user("u2", "how tall is it?"));
    // `sendMessage({ messageId: "u2", text })` edits the last question.
    await send(user("u2", "how wide is it?"));
    expect(texts(await rt.loadHistory({ chatId: "c", principal }))).toEqual([
      "user: first",
      "assistant: answer 1",
      "user: how wide is it?",
      "assistant: answer 3",
    ]);
    // The model saw the new wording only.
    expect(prompts[2]).toContain("how wide is it?");
    expect(prompts[2]).not.toContain("how tall is it?");
    expect(prompts[2]).not.toContain("answer 2");
    // The old wording is still stored, hidden, under a new id.
    const old = mem.messages.get("c")!.find((m) => texts([m])[0] === "user: how tall is it?")!;
    expect(old.id).not.toBe("u2");
    expect(old.metadata).toMatchObject({ visibility: "internal", sendToModel: false });
  });

  it("can be edited again, and regenerated after", async () => {
    const { send, rt } = setup();
    await send(user("u1", "one"));
    await send(user("u1", "two"));
    await send(user("u1", "three"));
    await send(user("u1", "three"));
    expect(texts(await rt.loadHistory({ chatId: "c", principal }))).toEqual(["user: three", "assistant: answer 4"]);
  });

  it("can't reuse the id of a hidden message", async () => {
    const { send, mem } = setup();
    await send(user("u1", "one"));
    await send(user("u1", "two"));
    const hiddenId = mem.messages.get("c")!.find((m) => texts([m])[0] === "user: one")!.id;
    await expect(send(user(hiddenId, "resurrected"))).rejects.toSatisfy(isInvalidMessageError);
  });
});

describe("after the chat was compacted", () => {
  it("regenerating the last question also retires the summary that covered its answer", async () => {
    const { send, rt, mem, prompts } = setup();
    await send(user("u1", "first"));
    await send(user("u2", "second"));
    // compactChat's marker: an internal user message carrying the summary.
    const summary: AppMessage = {
      id: "summary_1",
      role: "user",
      parts: [{ type: "text", text: "SUMMARY of everything so far" }, { type: "data-compaction", data: { compacted: 4, at: 1 } }],
      metadata: { visibility: "internal" },
    } as AppMessage;
    await mem.storage.appendMessages("c", [summary]);

    await send(user("u2", "second"));

    expect(texts(await rt.loadHistory({ chatId: "c", principal }))).toEqual([
      "user: first",
      "assistant: answer 1",
      "user: second",
      "assistant: answer 3",
    ]);
    // The summary mentioned the replaced answer: it is retired, and the model
    // works from the full history again, as before it was written.
    expect(mem.messages.get("c")!.find((m) => m.id === "summary_1")!.metadata).toMatchObject({ sendToModel: false });
    expect(prompts[2]).not.toContain("SUMMARY");
    expect(prompts[2]).toContain("first");
    expect(prompts[2]).not.toContain("answer 2");
  });
});

describe("a regenerate that can't run", () => {
  it("leaves the previous answer visible", async () => {
    const { send, rt } = setup({ maxTurns: 1 });
    await send(user("u1", "hi"));
    // The usage limit refuses the second turn.
    await expect(send(user("u1", "hi"))).rejects.toBeInstanceOf(LimitExceededError);
    expect(texts(await rt.loadHistory({ chatId: "c", principal }))).toEqual(["user: hi", "assistant: answer 1"]);
  });
});

describe("crash recovery after a regenerate hid the old answer", () => {
  it("still sees work left to do", () => {
    const history: AppMessage[] = [
      user("u1", "hi"),
      { id: "a1", role: "assistant", parts: [{ type: "step-start" }, { type: "text", text: "answer 1" }], metadata: { visibility: "internal", sendToModel: false } },
    ];
    expect(resumeShapeOf(history)).toBe("continue");
  });
});

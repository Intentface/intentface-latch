import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { simulateReadableStream } from "ai";
import { createRuntime, resumeShapeOf } from "./runtime.js";
import { defineContext } from "./context.js";
import { defineAgent } from "./agent.js";
import { isInvalidMessageError, type AppMessage } from "./message.js";
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

function setup() {
  const mem = memoryStorage();
  const { model, prompts } = answering();
  const rt = createRuntime<P>({
    storage: mem.storage,
    context: defineContext<P, unknown>({ build: async () => ({}) }),
    agents: { a: defineAgent({ model }) },
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

  it("only works for the last question, resent unchanged", async () => {
    const { send, mem } = setup();
    await send(user("u1", "first"));
    await send(user("u2", "second"));
    const before = JSON.stringify(mem.messages.get("c"));
    // An earlier question, unchanged: there is a later one after it.
    await expect(send(user("u1", "first"))).rejects.toSatisfy(isInvalidMessageError);
    // The last question, changed: that would rewrite what was asked.
    await expect(send(user("u2", "something else"))).rejects.toSatisfy(isInvalidMessageError);
    expect(JSON.stringify(mem.messages.get("c"))).toBe(before);
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

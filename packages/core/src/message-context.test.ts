import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { simulateReadableStream, tool } from "ai";
import { z } from "zod";
import { createRuntime } from "./runtime.js";
import { defineAgent } from "./agent.js";
import type { ToolContext } from "./context.js";
import { isInvalidMessageError, MAX_CONTEXT_BYTES, type AppMessage } from "./message.js";
import { memoryStorage } from "./__tests__/memory-storage.js";

/**
 * A client attaches what the user is looking at as one `data-context` part on
 * its message. The model reads it as text in that message, the agent and its
 * tools get it as data, and a continuation of the same answer (an approval)
 * sees the same values, because it's saved with the message.
 */

type P = { orgId: string };
const principal: P = { orgId: "org_a" };

const finish = (reason: string) => ({
  type: "finish",
  finishReason: { unified: reason, raw: reason },
  usage: { inputTokens: { total: 5 }, outputTokens: { total: 3 } },
});
const textStep = (text: string) => ({
  stream: simulateReadableStream({
    initialDelayInMs: 0,
    chunkDelayInMs: 0,
    chunks: [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "0" },
      { type: "text-delta", id: "0", delta: text },
      { type: "text-end", id: "0" },
      finish("stop"),
    ],
  }),
});
const says = () => new MockLanguageModelV4({ modelId: "mock", doStream: (async () => textStep("ok")) as never });
function callsThenSays(name: string, input: string) {
  let n = 0;
  return new MockLanguageModelV4({
    modelId: "mock-tools",
    doStream: (async () =>
      n++ % 2 === 0
        ? {
            stream: simulateReadableStream({
              initialDelayInMs: 0,
              chunkDelayInMs: 0,
              chunks: [
                { type: "stream-start", warnings: [] },
                { type: "tool-input-start", id: "call_1", toolName: name },
                { type: "tool-input-delta", id: "call_1", delta: input },
                { type: "tool-input-end", id: "call_1" },
                { type: "tool-call", toolCallId: "call_1", toolName: name, input },
                finish("tool-calls"),
              ],
            }),
          }
        : textStep("done")) as never,
  });
}

/** The user-message texts the model received on its latest call. */
function userTexts(model: MockLanguageModelV4): string[] {
  const prompt = model.doStreamCalls.at(-1)!.prompt as { role: string; content: { type: string; text?: string }[] }[];
  return prompt.filter((m) => m.role === "user").flatMap((m) => m.content.filter((c) => c.type === "text").map((c) => c.text!));
}
function systemText(model: MockLanguageModelV4, call: number): string {
  const prompt = model.doStreamCalls[call]!.prompt as { role: string; content: unknown }[];
  return prompt.filter((m) => m.role === "system").map((m) => String(m.content)).join("\n");
}

const withContext = (id: string, text: string, data: unknown): AppMessage =>
  ({ id, role: "user", parts: [{ type: "text", text }, { type: "data-context", data }] }) as AppMessage;
const user = (id: string, text: string): AppMessage => ({ id, role: "user", parts: [{ type: "text", text }] });

async function refusal(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e;
  }
}

describe("a data-context part", () => {
  it("reaches the model as text in its message, and the agent as data", async () => {
    const mem = memoryStorage();
    const model = says();
    let seen: unknown;
    const rt = createRuntime<P>({
      storage: mem.storage,
      agents: {
        a: defineAgent<P>(({ messageContext }) => {
          seen = messageContext;
          return { model, instructions: "You help." };
        }),
      },
    });
    await (await rt.handleChat({ agent: "a", chatId: "c1", principal, message: withContext("u1", "Summarize this", { activeFile: "Q3 budget", openTabs: ["Roadmap"] }) })).text();

    expect(userTexts(model)).toEqual(["Summarize this", '[Context]\nactiveFile: Q3 budget\nopenTabs: ["Roadmap"]']);
    expect(seen).toEqual({ activeFile: "Q3 budget", openTabs: ["Roadmap"] });
    // Saved with the message, so it is part of the conversation from now on.
    const stored = mem.messages.get("c1")![0]!;
    expect(stored.parts).toContainEqual({ type: "data-context", data: { activeFile: "Q3 budget", openTabs: ["Roadmap"] } });
  });

  it("keeps each message's own view, and leaves the instructions alone", async () => {
    const mem = memoryStorage();
    const model = says();
    const rt = createRuntime<P>({ storage: mem.storage, agents: { a: defineAgent({ model, instructions: "You help." }) } });
    await (await rt.handleChat({ agent: "a", chatId: "c1", principal, message: withContext("u1", "first", { activeFile: "A" }) })).text();
    await (await rt.handleChat({ chatId: "c1", principal, message: withContext("u2", "second", { activeFile: "B" }) })).text();

    expect(userTexts(model)).toEqual(["first", "[Context]\nactiveFile: A", "second", "[Context]\nactiveFile: B"]);
    // The system prompt is identical across both calls: nothing per-message in it.
    expect(systemText(model, 0)).toBe(systemText(model, 1));
  });

  it("is the same for tools after an approval, which carries none", async () => {
    const mem = memoryStorage();
    const seen: unknown[] = [];
    const open_file = tool({
      description: "Open the file the user is looking at",
      inputSchema: z.object({}),
      execute: async (_i, { context }) => {
        seen.push((context as ToolContext<P, unknown, unknown, { activeFile: string }>).messageContext);
        return { ok: true };
      },
    });
    const rt = createRuntime<P>({
      storage: mem.storage,
      agents: { a: defineAgent({ model: callsThenSays("open_file", "{}"), tools: { open_file }, toolApproval: { open_file: "user-approval" } }) },
    });
    await (await rt.handleChat({ agent: "a", chatId: "c1", principal, message: withContext("u1", "open it", { activeFile: "Q3 budget" }) })).text();
    const parts = mem.messages.get("c1")!.flatMap((m) => m.parts) as { type: string; approval?: { id: string } }[];
    const approvalId = parts.find((p) => p.type === "tool-open_file")!.approval!.id;
    await (await rt.applyApproval({ chatId: "c1", principal, decisions: [{ approvalId, approved: true }] })).text();
    expect(seen).toEqual([{ activeFile: "Q3 budget" }]);
  });

  it("is checked against messageContext.schema, and refused before anything is saved", async () => {
    const mem = memoryStorage();
    const rt = createRuntime<P>({
      storage: mem.storage,
      messageContext: { schema: z.object({ activeFile: z.string() }) },
      agents: { a: defineAgent({ model: says() }) },
    });
    const e = await refusal(rt.handleChat({ agent: "a", chatId: "c1", principal, message: withContext("u1", "hi", { activeFile: 7 }) }));
    expect(isInvalidMessageError(e)).toBe(true);
    expect(mem.chats.has("c1")).toBe(false);
  });

  it("reads the way toModel says, and an agent can word it its own way", async () => {
    const mem = memoryStorage();
    const plainModel = says();
    const writerModel = says();
    const rt = createRuntime<P>({
      storage: mem.storage,
      messageContext: { toModel: (c: { activeFile: string }) => `[Viewing ${c.activeFile}]` },
      agents: {
        plain: defineAgent({ model: plainModel }),
        writer: defineAgent({ model: writerModel }, { messageContext: { toModel: () => undefined } }),
      },
    });
    await (await rt.handleChat({ agent: "plain", chatId: "c1", principal, message: withContext("u1", "hi", { activeFile: "A" }) })).text();
    await (await rt.handleChat({ agent: "writer", chatId: "c2", principal, message: withContext("u1", "hi", { activeFile: "A" }) })).text();
    expect(userTexts(plainModel)).toEqual(["hi", "[Viewing A]"]);
    expect(userTexts(writerModel)).toEqual(["hi"]);
  });

  it("is refused twice in a message, alone, or too large", async () => {
    const rt = createRuntime<P>({ storage: memoryStorage().storage, agents: { a: defineAgent({ model: says() }) } });
    const two = { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }, { type: "data-context", data: {} }, { type: "data-context", data: {} }] };
    const alone = { id: "u1", role: "user", parts: [{ type: "data-context", data: { a: 1 } }] };
    const big = withContext("u1", "hi", { blob: "x".repeat(MAX_CONTEXT_BYTES) });
    for (const message of [two, alone, big]) {
      const e = await refusal(rt.handleChat({ agent: "a", chatId: "c1", principal, message: message as AppMessage }));
      expect(isInvalidMessageError(e)).toBe(true);
    }
  });

  it("is absent for a message that has none", async () => {
    const mem = memoryStorage();
    let seen: unknown = "unset";
    const rt = createRuntime<P>({
      storage: mem.storage,
      agents: {
        a: defineAgent<P>(({ messageContext }) => {
          seen = messageContext;
          return { model: says() };
        }),
      },
    });
    await (await rt.handleChat({ agent: "a", chatId: "c1", principal, message: user("u1", "hi") })).text();
    expect(seen).toBeUndefined();
  });
});

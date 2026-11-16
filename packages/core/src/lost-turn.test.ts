import { describe, expect, it, vi } from "vitest";
import { simulateReadableStream, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { chunksOf, harness, principal, user } from "./__tests__/turn.js";
import { isToolCallNotFoundError } from "./storage.js";

/**
 * A turn the client saw must be a turn the server has. A tool result that
 * can't be stored used to fail the step after it was streamed, and the answer
 * to a question from that step then went nowhere (an empty 200).
 */

const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } };
/** First call: the `work` tool and a question for the user, in one step. Then text. */
function askingModel() {
  let n = 0;
  return new MockLanguageModelV4({
    modelId: "mock",
    doStream: (async () => {
      const chunks: unknown[] =
        n++ === 0
          ? [
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: "c1", toolName: "work", input: "{}" },
              { type: "tool-call", toolCallId: "c2", toolName: "askUser", input: "{}" },
              { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage },
            ]
          : [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: "done" },
              { type: "text-end", id: "t" },
              { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
            ];
      return { stream: simulateReadableStream({ initialDelayInMs: 0, chunkDelayInMs: 0, chunks }) };
    }) as never,
  });
}
const askUser = tool({ description: "Ask the user.", inputSchema: z.object({}) });
const withWork = (execute: () => unknown) => ({
  work: tool({ description: "Work.", inputSchema: z.object({}), execute: execute as never }),
  askUser,
});
type Part = { type: string; state?: string; output?: unknown; errorText?: string; toolCallId?: string };
const partsOf = (h: ReturnType<typeof harness>) => (h.mem.messages.get("chat_1")!.at(-1)!.parts as Part[]).filter((p) => p.type.startsWith("tool-"));
const answer = (h: ReturnType<typeof harness>, toolCallId = "c2") =>
  h.runtime.applyToolResult({ chatId: "chat_1", principal, toolCallId, output: "yes" });

describe("a tool result that can't be stored as it is", () => {
  it("is stored without its functions, and the question asked beside it can be answered", async () => {
    const h = harness({ model: askingModel(), tools: withWork(async () => ({ ok: true, close: () => 1 })) });
    await h.turn(user("go"));
    expect(partsOf(h).map((p) => [p.type, p.state, p.output])).toEqual([
      ["tool-work", "output-available", { ok: true }],
      ["tool-askUser", "input-available", undefined],
    ]);
    const chunks = await chunksOf(await answer(h));
    expect(chunks.filter((c) => c.type === "text-delta").map((c) => c.delta)).toEqual(["done"]);
    expect([...h.mem.runs.values()].map((r) => r.status)).toEqual(["completed", "completed"]);
  });

  it("fails as that tool's error when it has no stored form, and the rest of the step stands", async () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    const h = harness({ model: askingModel(), tools: withWork(async () => loop) });
    await h.turn(user("go"));
    const [work, ask] = partsOf(h);
    expect(work).toMatchObject({ type: "tool-work", state: "output-error" });
    expect(work!.errorText).toContain(`Tool "work" returned a value that can't be stored`);
    expect(ask).toMatchObject({ type: "tool-askUser", state: "input-available" });
    expect((await answer(h)).headers.get("content-type")).toContain("text/event-stream");
  });

  it("is checked for each part a streaming tool yields", async () => {
    const h = harness({
      model: askingModel(),
      tools: withWork(async function* () {
        yield { step: 1, log: () => {} };
        yield { step: 2, log: () => {} };
      }),
    });
    await h.turn(user("go"));
    expect(partsOf(h)[0]).toMatchObject({ type: "tool-work", state: "output-available", output: { step: 2 } });
  });

  it("is left as it is when it can be stored", async () => {
    const out = { when: "2026-11-16", items: [1, 2] };
    const h = harness({ model: askingModel(), tools: withWork(async () => out) });
    await h.turn(user("go"));
    expect(partsOf(h)[0]!.output).toEqual(out);
  });
});

describe("a turn that was streamed and could not be saved", () => {
  const unsaved = async () => {
    const h = harness({ model: askingModel(), tools: withWork(async () => ({ ok: true })) });
    const append = h.mem.storage.appendMessages.bind(h.mem.storage);
    let down = false;
    h.mem.storage.appendMessages = async (id, messages, ...rest) => {
      if (down && messages.some((m) => m.role === "assistant")) throw new Error("storage down");
      return append(id, messages, ...rest);
    };
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    down = true;
    const res = await h.runtime.handleChat({ agent: "a", principal, chatId: "chat_1", message: user("go") });
    const streamed = await res.text().then(
      () => "ended",
      () => "failed",
    );
    down = false;
    quiet.mockRestore();
    return { h, streamed };
  };

  it("ends the client's stream as a failure and leaves the run errored, not completed", async () => {
    const { h, streamed } = await unsaved();
    expect(streamed).toBe("failed");
    const run = [...h.mem.runs.values()].at(-1)!;
    expect(run.status).toBe("errored");
    expect(run.error).toContain("the answer could not be saved: storage down");
    expect(h.mem.messages.get("chat_1")!.map((m) => m.role)).toEqual(["user"]);
  });

  it("refuses an answer to a question from it, where it used to answer an empty 200", async () => {
    const { h } = await unsaved();
    await expect(answer(h)).rejects.toSatisfy(isToolCallNotFoundError);
    // Nothing ran and nothing was stored.
    expect(h.mem.runs.size).toBe(1);
    expect(h.mem.messages.get("chat_1")!.map((m) => m.role)).toEqual(["user"]);
  });
});

describe("an answer to a tool call", () => {
  it("is a no-op the second time", async () => {
    const h = harness({ model: askingModel(), tools: withWork(async () => ({ ok: true })) });
    await h.turn(user("go"));
    await (await answer(h)).text();
    const again = await answer(h);
    expect(again.status).toBe(200);
    expect(await again.text()).toBe("");
    expect(h.mem.runs.size).toBe(2);
  });

  it("is refused for an id the chat never held", async () => {
    const h = harness({ model: askingModel(), tools: withWork(async () => ({ ok: true })) });
    await h.turn(user("go"));
    await expect(answer(h, "nope")).rejects.toSatisfy(isToolCallNotFoundError);
  });
});

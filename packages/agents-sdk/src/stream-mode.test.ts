/**
 * Streaming whole steps instead of deltas.
 *
 * The visible difference is cosmetic — a reader sees finished thoughts rather
 * than a sentence assembling itself. The useful difference is that `render`
 * can finally act on TEXT: a masking rule cannot catch a secret that arrives
 * four characters at a time, but it can catch one in a finished paragraph.
 */
import { describe, it, expect } from "vitest";
import {
  MockLanguageModelV4,
  convertArrayToReadableStream,
  convertReadableStreamToArray,
} from "ai/test";
import type { UIMessage } from "ai";
import { runAgentLoop } from "./loop.js";
import { defineExtension, type Extension } from "./extension.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
} as never;

/** Four deltas, so "did it coalesce" is answerable. */
const inPieces = (...parts: string[]) =>
  new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: "stream-start", warnings: [] },
        { type: "response-metadata", id: "1", modelId: "m", timestamp: new Date(0) },
        { type: "text-start", id: "t" },
        ...parts.map((delta) => ({ type: "text-delta", id: "t", delta })),
        { type: "text-end", id: "t" },
        { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
      ] as never),
    }),
  });

const messages: UIMessage[] = [{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }];
const deltasOf = (chunks: Array<{ type: string; delta?: string }>) =>
  chunks.filter((c) => c.type === "text-delta").map((c) => c.delta);

describe("stream: steps", () => {
  it("coalesces a step's deltas into one, and deltas mode does not", async () => {
    const pieces = ["The ", "key ", "is ", "abc123."];

    const asDeltas = await convertReadableStreamToArray(
      await runAgentLoop({ model: inPieces(...pieces), tools: {}, messages }),
    );
    expect(deltasOf(asDeltas as never)).toEqual(pieces);

    const asSteps = await convertReadableStreamToArray(
      await runAgentLoop({ model: inPieces(...pieces), tools: {}, messages, stream: "steps" }),
    );
    expect(deltasOf(asSteps as never)).toEqual(["The key is abc123."]);
  });

  it("lets a render rule mask text, which deltas mode cannot", async () => {
    const pieces = ["The ", "key ", "is ", "abc123."];
    const masker = defineExtension("mask", (ext) =>
      ext.registerRenderer((p) =>
        p.type === "text" && String((p as { text?: string }).text).includes("abc123")
          ? { replace: { type: "text", text: "The key is [redacted]." } as never }
          : undefined,
      ),
    ) as Extension;

    const masked = await convertReadableStreamToArray(
      await runAgentLoop({
        model: inPieces(...pieces),
        tools: {},
        messages,
        stream: "steps",
        extensions: [masker],
      }),
    );
    expect(JSON.stringify(masked)).toContain("[redacted]");
    expect(JSON.stringify(masked)).not.toContain("abc123");

    // The same rule in deltas mode sees "abc1" and "23." separately and never
    // matches — which is why `render` is documented as presentation, not a
    // security boundary, outside this mode.
    const leaked = await convertReadableStreamToArray(
      await runAgentLoop({
        model: inPieces(...pieces),
        tools: {},
        messages,
        extensions: [masker],
      }),
    );
    expect(JSON.stringify(leaked)).toContain("abc123");
  });

  it("a hidden text part sends no chunks at all", async () => {
    const hide = defineExtension("hide", (ext) =>
      ext.registerRenderer((p) => (p.type === "text" ? { hide: true } : undefined)),
    ) as Extension;

    const chunks = await convertReadableStreamToArray(
      await runAgentLoop({
        model: inPieces("secret ", "thing"),
        tools: {},
        messages,
        stream: "steps",
        extensions: [hide],
      }),
    );
    expect(JSON.stringify(chunks)).not.toContain("secret");
    expect(chunks.some((c) => c.type === "text-start")).toBe(false);
    // The run still completes normally.
    expect(chunks.some((c) => c.type === "finish")).toBe(true);
  });

  it("storage is unaffected: the reader's view is a lens, not the record", async () => {
    let stored: UIMessage[] = [];
    const hide = defineExtension("hide", (ext) => {
      ext.registerRenderer((p) => (p.type === "text" ? { hide: true } : undefined));
      ext.on("agent_end", ({ messages: m }) => void (stored = m));
    }) as Extension;

    await convertReadableStreamToArray(
      await runAgentLoop({
        model: inPieces("secret ", "thing"),
        tools: {},
        messages,
        stream: "steps",
        extensions: [hide],
      }),
    );
    // Hidden from the reader, kept in the transcript.
    expect(JSON.stringify(stored)).toContain("secret thing");
  });
});

import { describe, expect, it } from "vitest";
import type { RenderEvent } from "../types.js";
import { SlackApiError, type StreamChunk } from "./api.js";
import { renderSlackStream, type SlackStreamOptions } from "./stream.js";

type Recorded = { method: string; args: Record<string, unknown> };

function fakeApi(overrides: Partial<SlackStreamOptions["api"]> = {}) {
  const calls: Recorded[] = [];
  const api: SlackStreamOptions["api"] = {
    async startStream(args) {
      calls.push({ method: "startStream", args });
      return { ts: "100.1", channel: args.channel };
    },
    async appendStream(args) {
      calls.push({ method: "appendStream", args });
    },
    async stopStream(args) {
      calls.push({ method: "stopStream", args });
    },
    async postMessage(args) {
      calls.push({ method: "postMessage", args });
      return { ts: "200.1", channel: args.channel };
    },
    async update(args) {
      calls.push({ method: "update", args });
    },
    ...overrides,
  };
  return { api, calls };
}

async function* gen(...events: RenderEvent[]): AsyncGenerator<RenderEvent> {
  for (const e of events) yield e;
}

const noSleep = async () => {};

function opts(api: SlackStreamOptions["api"], extra: Partial<SlackStreamOptions> = {}): SlackStreamOptions {
  return {
    api,
    channel: "C1",
    threadTs: "1.0",
    recipientTeamId: "T1",
    flushIntervalMs: 0,
    fallbackUpdateIntervalMs: 0,
    sleep: noSleep,
    ...extra,
  };
}

const chunksOf = (c: Recorded) => (c.args.chunks ?? []) as StreamChunk[];

describe("renderSlackStream — streaming mode", () => {
  it("starts on first delta with recipient_team_id, appends, closes with the tail", async () => {
    const { api, calls } = fakeApi();
    const r = await renderSlackStream(
      gen(
        { type: "text-delta", text: "Hello " },
        { type: "text-delta", text: "world" },
        { type: "finish" },
      ),
      opts(api),
    );
    expect(r.mode).toBe("stream");
    expect(r.text).toBe("Hello world");
    const start = calls.find((c) => c.method === "startStream")!;
    expect(start.args.recipient_team_id).toBe("T1");
    expect(start.args.thread_ts).toBe("1.0");
    const streamedText = calls
      .filter((c) => c.method === "appendStream" || c.method === "stopStream")
      .map((c) => String(c.args.markdown_text ?? ""))
      .join("");
    expect(streamedText).toBe("Hello world");
    expect(calls[calls.length - 1]!.method).toBe("stopStream");
  });

  it("coalesces deltas inside the flush interval into the final close", async () => {
    const { api, calls } = fakeApi();
    let t = 0;
    await renderSlackStream(
      gen(
        { type: "text-delta", text: "a" },
        { type: "text-delta", text: "b" },
        { type: "text-delta", text: "c" },
        { type: "finish" },
      ),
      opts(api, { flushIntervalMs: 60_000, now: () => (t += 1) }),
    );
    // First content creates the stream (one append); the rest waits for close.
    const appends = calls.filter((c) => c.method === "appendStream");
    expect(appends.length).toBe(1);
    expect(appends[0]!.args.markdown_text).toBe("a");
    const stop = calls.find((c) => c.method === "stopStream")!;
    expect(stop.args.markdown_text).toBe("bc");
  });

  it("renders tool calls as task_update chunks with settled status", async () => {
    const { api, calls } = fakeApi();
    await renderSlackStream(
      gen(
        { type: "tool-start", toolCallId: "t1", toolName: "web_search", input: {} },
        { type: "tool-end", toolCallId: "t1", toolName: "web_search", output: {} },
        { type: "tool-start", toolCallId: "t2", toolName: "edit_file", input: {} },
        { type: "tool-end", toolCallId: "t2", toolName: "edit_file", error: "nope" },
        { type: "text-delta", text: "done" },
        { type: "finish" },
      ),
      opts(api),
    );
    const all = calls.flatMap(chunksOf).filter((c) => c.type === "task_update");
    expect(all).toContainEqual({
      type: "task_update",
      id: "t1",
      title: "Using web_search",
      status: "in_progress",
    });
    expect(all).toContainEqual({
      type: "task_update",
      id: "t1",
      title: "Using web_search",
      status: "complete",
    });
    expect(all).toContainEqual({
      type: "task_update",
      id: "t2",
      title: "Using edit_file",
      status: "error",
    });
  });

  it("collapses reasoning into ONE task and never streams it as text", async () => {
    const { api, calls } = fakeApi();
    const r = await renderSlackStream(
      gen(
        { type: "reasoning-delta", text: "let me think about secrets" },
        { type: "reasoning-delta", text: " and more thinking" },
        { type: "text-delta", text: "The answer." },
        { type: "finish" },
      ),
      opts(api),
    );
    expect(r.text).toBe("The answer.");
    const streamedText = calls
      .filter((c) => c.method === "appendStream" || c.method === "stopStream")
      .map((c) => String(c.args.markdown_text ?? ""))
      .join("");
    expect(streamedText).not.toContain("think");
    const reasoning = calls
      .flatMap(chunksOf)
      .filter((c) => c.type === "task_update" && c.id === "reasoning");
    expect(reasoning.map((c) => (c as { status: string }).status)).toEqual([
      "in_progress",
      "complete",
    ]);
  });

  it("treats stopped_by_user on append as a stop, not an error", async () => {
    const { api, calls } = fakeApi({
      async appendStream() {
        throw new SlackApiError("chat.appendStream", 200, "stopped_by_user");
      },
    });
    const r = await renderSlackStream(
      gen(
        { type: "text-delta", text: "long answer " },
        { type: "text-delta", text: "never seen" },
        { type: "finish" },
      ),
      opts(api),
    );
    expect(r.stopped).toBe(true);
    const stop = calls.find((c) => c.method === "stopStream")!;
    expect(String(stop.args.markdown_text)).toContain("Stopped");
  });

  it("honors the host-backed stop flag between flushes", async () => {
    const { api } = fakeApi();
    let polls = 0;
    const r = await renderSlackStream(
      gen(
        { type: "text-delta", text: "a" },
        { type: "text-delta", text: "b" },
        { type: "finish" },
      ),
      opts(api, { shouldStop: async () => ++polls > 1 }),
    );
    expect(r.stopped).toBe(true);
  });

  it("overflows past the streamed budget into a follow-up markdown message", async () => {
    const { api, calls } = fakeApi();
    const r = await renderSlackStream(
      gen(
        { type: "text-delta", text: "aaaaa" },
        { type: "text-delta", text: "bbbbb" },
        { type: "text-delta", text: "ccccc" },
        { type: "finish" },
      ),
      opts(api, { maxStreamedChars: 10 }),
    );
    expect(r.text).toBe("aaaaabbbbbccccc");
    expect(r.overflowTs).toEqual(["200.1"]);
    const post = calls.find((c) => c.method === "postMessage")!;
    const blocks = post.args.blocks as { type: string; text: string }[];
    expect(blocks[0]).toEqual({ type: "markdown", text: "ccccc" });
  });

  it("appends error and feedback blocks on close", async () => {
    const { api, calls } = fakeApi();
    const r = await renderSlackStream(
      gen(
        { type: "text-delta", text: "partial" },
        { type: "error", message: "boom" },
        { type: "finish" },
      ),
      opts(api, { feedback: true }),
    );
    expect(r.errorMessage).toBe("boom");
    const stop = calls.find((c) => c.method === "stopStream")!;
    const blocks = stop.args.blocks as { type: string }[];
    expect(blocks.some((b) => b.type === "section")).toBe(true); // error surface
    expect(blocks.some((b) => b.type === "context_actions")).toBe(true); // feedback
  });
});

describe("renderSlackStream — fallback + edge modes", () => {
  it("falls back to post+update when startStream is unavailable", async () => {
    const { api, calls } = fakeApi({
      async startStream() {
        throw new SlackApiError("chat.startStream", 200, "feature_disabled");
      },
    });
    const r = await renderSlackStream(
      gen(
        { type: "text-delta", text: "Hello " },
        { type: "tool-start", toolCallId: "t1", toolName: "web_search", input: {} },
        { type: "text-delta", text: "world" },
        { type: "finish" },
      ),
      opts(api, { feedback: true }),
    );
    expect(r.mode).toBe("fallback");
    expect(calls.filter((c) => c.method === "appendStream")).toEqual([]);
    const post = calls.find((c) => c.method === "postMessage")!;
    expect((post.args.blocks as { type: string }[])[0]!.type).toBe("markdown");
    const finalUpdate = calls.filter((c) => c.method === "update").pop()!;
    const blocks = finalUpdate.args.blocks as { type: string; text?: string }[];
    expect(blocks.some((b) => b.type === "context_actions")).toBe(true);
    // Status line is working-state only — the final render drops it.
    expect(JSON.stringify(blocks)).not.toContain("Running web_search");
  });

  it("posts only an error card when the run produced nothing else", async () => {
    const { api, calls } = fakeApi();
    const r = await renderSlackStream(
      gen({ type: "error", message: "it broke" }, { type: "finish" }),
      opts(api),
    );
    expect(r.mode).toBe("none");
    expect(calls.map((c) => c.method)).toEqual(["postMessage"]);
    expect(JSON.stringify(calls[0]!.args.blocks)).toContain("it broke");
  });

  it("posts nothing at all for an empty run (approval-parked turns)", async () => {
    const { api, calls } = fakeApi();
    const r = await renderSlackStream(gen({ type: "finish" }), opts(api));
    expect(r.mode).toBe("none");
    expect(calls).toEqual([]);
  });
});

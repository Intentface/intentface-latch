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
    async deleteMessage(args) {
      calls.push({ method: "deleteMessage", args });
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
    sleep: noSleep,
    ...extra,
  };
}

const chunksOf = (c: Recorded) => (c.args.chunks ?? []) as StreamChunk[];
/** Streamed text of one call — always a markdown_text CHUNK (one streaming mode). */
const textOf = (c: Recorded) =>
  chunksOf(c)
    .map((k) => (k.type === "markdown_text" ? k.text : ""))
    .join("");

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
      .map(textOf)
      .join("");
    expect(streamedText).toBe("Hello world");
    expect(calls[calls.length - 1]!.method).toBe("stopStream");
    // Never the top-level markdown field: mixing modes breaks the stream.
    expect(calls.some((c) => c.args.markdown_text !== undefined)).toBe(false);
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
    expect(textOf(appends[0]!)).toBe("a");
    const stop = calls.find((c) => c.method === "stopStream")!;
    expect(textOf(stop)).toBe("bc");
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
      .map(textOf)
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
    expect(textOf(stop)).toContain("Stopped");
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

  it("puts the attribution footer on the LAST message: the overflow post if any, else the close", async () => {
    const footer = { type: "context", elements: [{ type: "mrkdwn", text: "_requested by <@U1>_" }] };
    const withOverflow = fakeApi();
    await renderSlackStream(
      gen(
        { type: "text-delta", text: "aaaaa" },
        { type: "text-delta", text: "bbbbb" },
        { type: "text-delta", text: "ccccc" },
        { type: "finish" },
      ),
      opts(withOverflow.api, { maxStreamedChars: 10, attribution: "_requested by <@U1>_" }),
    );
    const stop = withOverflow.calls.find((c) => c.method === "stopStream")!;
    expect(JSON.stringify(stop.args.blocks ?? [])).not.toContain("requested by");
    const post = withOverflow.calls.find((c) => c.method === "postMessage")!;
    const blocks = post.args.blocks as unknown[];
    expect(blocks[blocks.length - 1]).toEqual(footer);

    const noOverflow = fakeApi();
    await renderSlackStream(
      gen({ type: "text-delta", text: "short" }, { type: "finish" }),
      opts(noOverflow.api, { attribution: "_requested by <@U1>_" }),
    );
    const stop2 = noOverflow.calls.find((c) => c.method === "stopStream")!;
    const closeBlocks = stop2.args.blocks as unknown[];
    expect(closeBlocks[closeBlocks.length - 1]).toEqual(footer);
    expect(noOverflow.calls.some((c) => c.method === "postMessage")).toBe(false);
  });

  it("never adds the footer to a stopped or error-only turn", async () => {
    const stoppedApi = fakeApi();
    await renderSlackStream(
      gen({ type: "text-delta", text: "partial" }, { type: "finish" }),
      opts(stoppedApi.api, { attribution: "_requested by <@U1>_", shouldStop: async () => true }),
    );
    const errApi = fakeApi();
    await renderSlackStream(
      gen({ type: "error", message: "boom" }, { type: "finish" }),
      opts(errApi.api, { attribution: "_requested by <@U1>_" }),
    );
    for (const { calls } of [stoppedApi, errApi]) {
      expect(JSON.stringify(calls.map((c) => c.args))).not.toContain("requested by");
    }
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

describe("renderSlackStream — mode telemetry + status box", () => {
  it("reports stream mode once on success", async () => {
    const { api } = fakeApi();
    const modes: unknown[] = [];
    await renderSlackStream(
      gen({ type: "text-delta", text: "hi" }, { type: "finish" }),
      opts(api, { onStreamMode: (i) => void modes.push(i) }),
    );
    expect(modes).toEqual([{ mode: "stream" }]);
  });

  it("reports fallback with Slack's code and detail", async () => {
    const { api } = fakeApi({
      async startStream() {
        throw new SlackApiError(
          "chat.startStream",
          200,
          "invalid_arguments",
          undefined,
          "[ERROR] json-pointer:/task_display_mode",
        );
      },
    });
    const modes: { mode: string; code?: string; detail?: string }[] = [];
    await renderSlackStream(
      gen({ type: "text-delta", text: "hi" }, { type: "finish" }),
      opts(api, { onStreamMode: (i) => void modes.push(i) }),
    );
    expect(modes).toEqual([
      {
        mode: "fallback",
        code: "invalid_arguments",
        detail: "[ERROR] json-pointer:/task_display_mode",
      },
    ]);
  });

  it("drives the legacy status box through the turn and clears it", async () => {
    const { api } = fakeApi();
    const statuses: string[] = [];
    await renderSlackStream(
      gen(
        { type: "reasoning-delta", text: "hmm" },
        { type: "tool-start", toolCallId: "t1", toolName: "web_search", input: {} },
        { type: "tool-end", toolCallId: "t1", toolName: "web_search", output: {} },
        { type: "text-delta", text: "done" },
        { type: "finish" },
      ),
      opts(api, { setStatus: (t) => void statuses.push(t) }),
    );
    expect(statuses).toEqual(["is thinking…", "is using web_search…", "", ""]);
  });

  it("awaits telemetry persistence before the turn settles", async () => {
    const { api } = fakeApi();
    let persisted = false;
    await renderSlackStream(
      gen({ type: "text-delta", text: "hi" }, { type: "finish" }),
      opts(api, {
        onStreamMode: () => new Promise<void>((r) => setTimeout(() => {
          persisted = true;
          r();
        }, 20)),
      }),
    );
    // A fire-and-forget write would still be pending here; on serverless the
    // function may freeze the moment the turn promise resolves.
    expect(persisted).toBe(true);
  });

  it("never streams task_display_mode (Slack rejected it as invalid_arguments)", async () => {
    const { api, calls } = fakeApi();
    await renderSlackStream(gen({ type: "text-delta", text: "hi" }, { type: "finish" }), opts(api));
    const start = calls.find((c) => c.method === "startStream")!;
    expect("task_display_mode" in start.args).toBe(false);
  });
});

describe("renderSlackStream — resilience (text must never vanish)", () => {
  it("recovers a mid-turn stream death: delete the corpse, post the full text once at finish", async () => {
    let appends = 0;
    const { api, calls } = fakeApi({
      async appendStream() {
        appends++;
        throw new SlackApiError("chat.appendStream", 200, "message_not_in_streaming_state");
      },
    });
    const modes: { mode: string; code?: string }[] = [];
    const r = await renderSlackStream(
      gen(
        { type: "text-delta", text: "the answer " },
        { type: "text-delta", text: "in full" },
        { type: "finish" },
      ),
      opts(api, { onStreamMode: (i) => void modes.push(i) }),
    );
    expect(r.mode).toBe("fallback");
    expect(appends).toBe(1); // no retrying into a corpse
    // The dead streamed message is removed — no stranded ⚠️ ghost, no
    // duplicated prefix above the final post.
    const del = calls.find((c) => c.method === "deleteMessage")!;
    expect(del.args.ts).toBe("100.1");
    // The engine change is reported so binding health reflects the truth.
    expect(modes.map((m) => m.mode)).toEqual(["stream", "fallback"]);
    // The full text arrived as EXACTLY ONE fresh regular message, at finish.
    const posts = calls.filter((c) => c.method === "postMessage");
    expect(posts.length).toBe(1);
    expect(JSON.stringify(posts[0]!.args.blocks)).toContain("the answer in full");
    expect(calls.filter((c) => c.method === "stopStream")).toEqual([]);
  });

  it("posts the undelivered tail as a regular message when the close fails for good", async () => {
    const { api, calls } = fakeApi({
      async stopStream() {
        throw new SlackApiError("chat.stopStream", 200, "message_not_in_streaming_state");
      },
    });
    let t = 0;
    const r = await renderSlackStream(
      gen(
        { type: "text-delta", text: "first flushed. " },
        { type: "text-delta", text: "tail never streamed" },
        { type: "finish" },
      ),
      // Large interval: only the stream-opening flush sends; the rest is tail.
      opts(api, { flushIntervalMs: 60_000, now: () => (t += 1) }),
    );
    expect(r.mode).toBe("stream");
    const recovery = calls.filter((c) => c.method === "postMessage").pop()!;
    expect(JSON.stringify(recovery.args.blocks)).toContain("tail never streamed");
  });

  it("never posts the tail when the viewer stopped during the close retry", async () => {
    let closes = 0;
    const { api, calls } = fakeApi({
      async stopStream() {
        closes++;
        if (closes === 1) throw new SlackApiError("chat.stopStream", 500);
        throw new SlackApiError("chat.stopStream", 200, "stopped_by_user");
      },
    });
    let t = 0;
    await renderSlackStream(
      gen(
        { type: "text-delta", text: "opening. " },
        { type: "text-delta", text: "refused tail" },
        { type: "finish" },
      ),
      opts(api, { flushIntervalMs: 60_000, now: () => (t += 1) }),
    );
    // No recovery post: the only postMessage-free path is streamed-only calls.
    expect(
      calls.filter((c) => c.method === "postMessage" && JSON.stringify(c.args).includes("refused tail")),
    ).toEqual([]);
  });

  it("settles open task cards before closing (parked approvals are not warnings)", async () => {
    const { api, calls } = fakeApi();
    await renderSlackStream(
      gen(
        // A gated tool: input arrives, the turn parks — no tool-end ever.
        { type: "tool-start", toolCallId: "t9", toolName: "post_to_channel", input: {} },
        { type: "finish" },
      ),
      opts(api),
    );
    const all = calls.flatMap(chunksOf).filter((c) => c.type === "task_update" && c.id === "t9");
    expect(all.map((c) => (c as { status: string }).status)).toEqual(["in_progress", "complete"]);
  });

  it("names resumed tools whose stream carries no tool name", async () => {
    const { api, calls } = fakeApi();
    await renderSlackStream(
      gen(
        { type: "tool-end", toolCallId: "t1", toolName: "", output: {} },
        { type: "text-delta", text: "done" },
        { type: "finish" },
      ),
      opts(api, { resumedToolName: "post_to_channel" }),
    );
    const task = calls.flatMap(chunksOf).find((c) => c.type === "task_update")!;
    expect((task as { title: string }).title).toBe("Using post_to_channel");
  });
});

describe("renderSlackStream — fallback + edge modes", () => {
  it("posts the finished answer ONCE when startStream is unavailable — never edit-to-mimic", async () => {
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
    // Exactly one message, at finish, holding the complete answer + feedback.
    const posts = calls.filter((c) => c.method === "postMessage");
    expect(posts.length).toBe(1);
    const blocks = posts[0]!.args.blocks as { type: string; text?: string }[];
    expect(blocks[0]!.type).toBe("markdown");
    expect(JSON.stringify(blocks)).toContain("Hello world");
    expect(blocks.some((b) => b.type === "context_actions")).toBe(true);
    // No progressive rendering artifacts: no interim posts, no status lines.
    expect(JSON.stringify(blocks)).not.toContain("Running web_search");
    expect(JSON.stringify(blocks)).not.toContain("⏳");
  });

  it("posts nothing mid-turn in fallback mode even across many events", async () => {
    const { api, calls } = fakeApi({
      async startStream() {
        throw new SlackApiError("chat.startStream", 200, "feature_disabled");
      },
    });
    let t = 0;
    await renderSlackStream(
      gen(
        { type: "text-delta", text: "part one. " },
        { type: "tool-start", toolCallId: "t1", toolName: "web_search", input: {} },
        { type: "tool-end", toolCallId: "t1", toolName: "web_search", output: {} },
        { type: "text-delta", text: "part two." },
        { type: "finish" },
      ),
      // Zero flush interval: every event is flush-due, yet nothing may post.
      opts(api, { now: () => (t += 1000) }),
    );
    const posts = calls.filter((c) => c.method === "postMessage");
    expect(posts.length).toBe(1);
    expect(JSON.stringify(posts[0]!.args.blocks)).toContain("part one. part two.");
  });

  it("suppresses the fallback final post when the viewer stopped the turn", async () => {
    const { api, calls } = fakeApi({
      async startStream() {
        throw new SlackApiError("chat.startStream", 200, "feature_disabled");
      },
    });
    const r = await renderSlackStream(
      gen({ type: "text-delta", text: "half an answer" }, { type: "finish" }),
      opts(api, { shouldStop: async () => true }),
    );
    expect(r.stopped).toBe(true);
    expect(calls.filter((c) => c.method === "postMessage")).toEqual([]);
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

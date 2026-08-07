import { describe, expect, it } from "vitest";
import { COMPACTION_PART_TYPE, toModelMessages } from "@intentface/latch-core";
import type { AppMessage } from "@intentface/latch-core";

/**
 * Regression: an APPROVED tool call whose execution was interrupted
 * (crash/restart mid-run) leaves `approval-responded` + no output in history.
 * Once a later message buries it, no re-run will execute it — the projection
 * must close it, or every subsequent turn 400s at the provider with
 * "`tool_use` ids were found without `tool_result` blocks".
 */

const asst = (id: string, parts: unknown[]): AppMessage =>
  ({ id, role: "assistant", parts }) as never;
const user = (id: string, text: string): AppMessage =>
  ({ id, role: "user", parts: [{ type: "text", text }] }) as never;

const approvedNoOutput = {
  type: "tool-run_evals",
  toolCallId: "toolu_dangling",
  state: "approval-responded",
  input: { agentName: "x" },
  approval: { id: "ap1", approved: true },
};

/** Every tool-call id in the converted messages must have a tool-result. */
function assertBalanced(model: unknown[]) {
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const m of model as { content?: unknown }[]) {
    if (!Array.isArray(m.content)) continue;
    for (const c of m.content as { type?: string; toolCallId?: string }[]) {
      if (c.type === "tool-call" && c.toolCallId) calls.add(c.toolCallId);
      if (c.type === "tool-result" && c.toolCallId) results.add(c.toolCallId);
    }
  }
  for (const id of calls) expect(results, `tool_use ${id} has no tool_result`).toContain(id);
  return { calls, results };
}

/**
 * Regression: voice messages ingested before channel-side transcription were
 * stored as audio/* file parts. Anthropic rejects audio input, so every later
 * turn in such a chat 500s with AI_UnsupportedFunctionalityError — the
 * projection must swap the part for a text placeholder.
 */
describe("toModelMessages audio file parts", () => {
  const flatContent = (model: unknown[]) =>
    (model as { content?: unknown }[]).flatMap((m) =>
      Array.isArray(m.content) ? (m.content as { type?: string; mediaType?: string; text?: string }[]) : [],
    );

  it("replaces a stored voice-message file part with a text placeholder", async () => {
    const model = await toModelMessages([
      {
        id: "u1",
        role: "user",
        parts: [
          {
            type: "file",
            mediaType: "audio/ogg",
            filename: "voice.ogg",
            url: "data:audio/ogg;base64,T2dnUw==",
          },
        ],
      } as never,
      user("u2", "hello again"),
    ]);
    const content = flatContent(model);
    expect(content.some((c) => c.mediaType?.startsWith("audio/"))).toBe(false);
    expect(
      content.some((c) => c.type === "text" && c.text?.includes('voice message ("voice.ogg")')),
    ).toBe(true);
  });

  it("leaves non-audio file parts untouched", async () => {
    const model = await toModelMessages([
      {
        id: "u1",
        role: "user",
        parts: [
          { type: "text", text: "look at this" },
          {
            type: "file",
            mediaType: "image/jpeg",
            filename: "photo.jpg",
            url: "data:image/jpeg;base64,/9j/4A==",
          },
        ],
      } as never,
    ]);
    const content = flatContent(model);
    expect(content.some((c) => c.mediaType === "image/jpeg" || c.type === "image")).toBe(true);
  });
});

describe("toModelMessages dangling-call closure", () => {
  it("closes a buried approved call that never executed", async () => {
    const model = await toModelMessages([
      asst("a1", [approvedNoOutput]),
      user("u1", "hello? are you stuck?"),
    ]);
    const { calls } = assertBalanced(model);
    expect(calls).toContain("toolu_dangling");
  });

  it("closes buried interrupted (input-available) calls", async () => {
    const model = await toModelMessages([
      asst("a1", [
        {
          type: "tool-test_agent",
          toolCallId: "toolu_interrupted",
          state: "input-available",
          input: { name: "x", message: "hi" },
        },
      ]),
      user("u1", "next"),
    ]);
    assertBalanced(model);
  });

  it("keeps completed calls untouched around the closed one", async () => {
    const done = {
      type: "tool-save_agent",
      toolCallId: "toolu_done",
      state: "output-available",
      input: { name: "x" },
      output: { saved: true },
      approval: { id: "ap0", approved: true },
    };
    const model = await toModelMessages([
      asst("a1", [done, approvedNoOutput]),
      user("u1", "and then"),
    ]);
    const { calls } = assertBalanced(model);
    expect(calls).toContain("toolu_done");
    expect(calls).toContain("toolu_dangling");
  });
});

/**
 * `/compact` appends a summary message carrying a `data-compaction` part; from
 * then on the model must see that summary INSTEAD of the turns it replaces,
 * while stored history (and the web UI) keep everything.
 */
describe("toModelMessages compaction boundary", () => {
  const marker = (id: string, summary: string): AppMessage =>
    ({
      id,
      role: "user",
      parts: [
        { type: "text", text: summary },
        { type: COMPACTION_PART_TYPE, data: { compacted: 4, at: 1 } },
      ],
      metadata: { visibility: "internal" },
    }) as never;

  const textsOf = (model: unknown[]) =>
    JSON.stringify((model as { content?: unknown }[]).map((m) => m.content));

  it("leaves a chat that was never compacted alone", async () => {
    const history = [user("u1", "first"), asst("a1", [{ type: "text", text: "reply" }])];
    expect(await toModelMessages(history)).toHaveLength(2);
  });

  it("drops everything before the marker and keeps the summary", async () => {
    const model = await toModelMessages([
      user("u1", "ancient history"),
      asst("a1", [{ type: "text", text: "long forgotten" }]),
      marker("c1", "the user is training for a marathon"),
      user("u2", "what pace should I run?"),
    ]);
    const dump = textsOf(model);
    expect(dump).not.toContain("ancient history");
    expect(dump).not.toContain("long forgotten");
    expect(dump).toContain("training for a marathon");
    expect(dump).toContain("what pace should I run?");
    // The marker part itself is dropped by the SDK — only its text survives.
    expect(dump).not.toContain(COMPACTION_PART_TYPE);
  });

  it("slices at the LAST marker when a chat was compacted twice", async () => {
    const model = await toModelMessages([
      user("u1", "ancient history"),
      marker("c1", "first summary"),
      user("u2", "middle"),
      marker("c2", "second summary"),
      user("u3", "now"),
    ]);
    const dump = textsOf(model);
    expect(dump).not.toContain("first summary");
    expect(dump).not.toContain("middle");
    expect(dump).toContain("second summary");
  });

  it("the model conversation opens on a user turn", async () => {
    // Anthropic rejects a prompt that starts with an assistant message, and after
    // slicing the summary IS the first message — hence its `user` role.
    const model = (await toModelMessages([
      user("u1", "ancient"),
      marker("c1", "summary"),
      asst("a2", [{ type: "text", text: "carrying on" }]),
    ])) as { role: string }[];
    expect(model[0].role).toBe("user");
  });

  it("a tool call left behind the boundary can't orphan a result", async () => {
    const model = await toModelMessages([
      asst("a1", [approvedNoOutput]),
      marker("c1", "summary"),
      user("u2", "next"),
    ]);
    const { calls } = assertBalanced(model);
    expect(calls.size).toBe(0); // the call went away with its message
  });
});

import { describe, expect, it } from "vitest";
import { trimTrailingAssistantPrefill } from "./runtime.js";
import { toModelMessages } from "./projections.js";
import type { AppMessage } from "./message.js";

/**
 * The resume paths (`applyApproval` / `applyToolResult`) re-run the model over
 * history whose LAST message is the assistant turn that paused — no fresh user
 * message is appended. If that turn streamed user-facing text before pausing,
 * the projection ends on an assistant message and some providers reject it
 * ("This model does not support assistant message prefill. The conversation
 * must end with a user message.").
 *
 * `trimTrailingAssistantPrefill` drops that trailing text so the projection
 * ends on the tool result — a user turn — instead.
 *
 * The load-bearing detail is WHICH part anchors the trim: `toModelMessages`
 * drops every `data-*` part, so only a part the projection keeps can end a
 * turn. Anchoring on a bubbled `data-subagent-approval` (which the
 * agent-builder appends last on every approval round) meant the text BEFORE it
 * was kept — the exact prefill this exists to prevent.
 */

const msg = (
  role: "user" | "assistant",
  parts: Array<{ type: string } & Record<string, unknown>>,
): AppMessage => ({ id: `m_${role}`, role, parts }) as AppMessage;

const types = (m: AppMessage) => (m.parts ?? []).map((p) => p.type);

describe("trimTrailingAssistantPrefill", () => {
  it("anchors on the tool part, not on a data-* approval that follows it", () => {
    // The shape the agent-builder produces on every approval round.
    const messages = [
      msg("user", [{ type: "text", text: "build me an agent" }]),
      msg("assistant", [
        { type: "tool-spawn_agent", state: "output-available", output: { answer: "ok" } },
        { type: "data-subagent-progress", data: {} },
        { type: "data-subagent-approval", data: { approvalId: "sapv_1", approved: true } },
        { type: "step-start" },
        { type: "text", text: "Once approved, it'll be OKR Status Reporter…" },
        { type: "data-subagent-approval", data: { approvalId: "sapv_2", approved: true } },
      ]),
    ];

    // The text goes, and the step boundary goes WITH it — `step-start` tells
    // the converter to open a new assistant message, and with the text gone
    // that message is empty, so keeping it ends the projection on
    // `{ role: "assistant", content: [] }` (see the projection tests below).
    // The approval markers stay: the model never sees them, and the resumed
    // turn re-persists this message, so dropping them would erase what the UI
    // renders and `hasPendingApproval` reads.
    expect(types(trimTrailingAssistantPrefill(messages)[1])).toEqual([
      "tool-spawn_agent",
      "data-subagent-progress",
      "data-subagent-approval",
      "data-subagent-approval",
    ]);
  });

  it("drops trailing reasoning as well as text", () => {
    const messages = [
      msg("user", [{ type: "text", text: "q" }]),
      msg("assistant", [
        { type: "tool-askUser", state: "output-available" },
        { type: "reasoning", text: "thinking out loud" },
      ]),
    ];
    expect(types(trimTrailingAssistantPrefill(messages)[1])).toEqual(["tool-askUser"]);
  });

  it("leaves the messages untouched when nothing after the anchor is prefill", () => {
    const messages = [
      msg("user", [{ type: "text", text: "q" }]),
      msg("assistant", [
        { type: "tool-askUser", state: "output-available" },
        { type: "data-subagent-approval", data: { approvalId: "sapv_1" } },
      ]),
    ];
    // Same array identity — the callers rely on this being a no-op, not a copy.
    expect(trimTrailingAssistantPrefill(messages)).toBe(messages);
  });

  it("leaves a message with no tool anchor alone", () => {
    const messages = [
      msg("user", [{ type: "text", text: "hello" }]),
      msg("assistant", [{ type: "text", text: "hi" }]),
    ];
    expect(trimTrailingAssistantPrefill(messages)).toBe(messages);
  });

  it("ignores history that does not end on an assistant turn", () => {
    const messages = [msg("user", [{ type: "text", text: "hello" }])];
    expect(trimTrailingAssistantPrefill(messages)).toBe(messages);
  });
});

/**
 * The assertions that actually pin the bug class. The trim's own output can
 * look right while the converted projection still ends on an assistant
 * message — which is the thing providers reject. Assert on what the MODEL
 * receives, not only on the parts array.
 */
describe("the converted projection after trimming", () => {
  const paused = [
    msg("user", [{ type: "text", text: "build me an agent" }]),
    msg("assistant", [
      {
        type: "tool-spawn_agent",
        toolCallId: "tc1",
        state: "output-available",
        input: {},
        output: { status: "awaiting_approval" },
      },
      { type: "data-subagent-approval", data: { approvalId: "sapv_1", approved: true } },
      { type: "step-start" },
      { type: "text", text: "Once approved, it'll be OKR Status Reporter…" },
      { type: "data-subagent-approval", data: { approvalId: "sapv_2", approved: true } },
    ]),
  ];

  it("ends on the tool result — the user's side — after the trim", async () => {
    const modelMsgs = await toModelMessages(trimTrailingAssistantPrefill(paused));
    expect((modelMsgs[modelMsgs.length - 1] as { role: string }).role).toBe("tool");
  });

  it("regression: untrimmed, it ends on assistant text (the prefill)", async () => {
    const modelMsgs = await toModelMessages(paused);
    expect((modelMsgs[modelMsgs.length - 1] as { role: string }).role).toBe("assistant");
  });

  it("keeping step-start no longer strands an empty assistant message", async () => {
    // This shape USED to convert to a trailing assistant message with no
    // content — the original reason step-start is in the drop set. The AI SDK
    // now drops the empty message itself, so the conversion ends on the tool
    // result either way.
    //
    // step-start stays in the drop set regardless: the tests above cover what
    // the trim is actually for (a trailing assistant PREFILL), and a drop set
    // that relies on the SDK's conversion to clean up after it is a worse
    // contract than one that never emits the part.
    const keptStepStart = [
      paused[0],
      msg("assistant", [
        (paused[1].parts as { type: string }[])[0],
        { type: "data-subagent-approval", data: { approvalId: "sapv_1", approved: true } },
        { type: "step-start" },
        { type: "data-subagent-approval", data: { approvalId: "sapv_2", approved: true } },
      ] as never),
    ];
    const modelMsgs = await toModelMessages(keptStepStart);
    const last = modelMsgs[modelMsgs.length - 1] as { role: string; content: unknown[] };
    expect(last.role).toBe("tool");
  });
});

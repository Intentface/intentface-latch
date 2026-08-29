import { describe, expect, it } from "vitest";
import { trimTrailingAssistantPrefill } from "./runtime.js";
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

    // The text goes. The approval markers and step boundary stay: the model
    // never sees them, and the resumed turn re-persists this message, so
    // dropping them would erase what the UI renders and `hasPendingApproval`
    // reads.
    expect(types(trimTrailingAssistantPrefill(messages)[1])).toEqual([
      "tool-spawn_agent",
      "data-subagent-progress",
      "data-subagent-approval",
      "step-start",
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

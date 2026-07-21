import { describe, expect, it } from "vitest";
import { toModelMessages } from "@intentface/latch-core";
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

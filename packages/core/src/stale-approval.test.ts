import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { simulateReadableStream, tool } from "ai";
import { z } from "zod";
import { createRuntime } from "./runtime.js";
import { defineContext } from "./context.js";
import { defineAgent } from "./agent.js";
import type { AppMessage } from "./message.js";
import { memoryStorage } from "./__tests__/memory-storage.js";

/**
 * A decision only applies to the message a turn is paused on — the chat's
 * last — and only to a call the agent hasn't acted on yet. Anything else (an
 * old tab, an old Slack card, a double click, a re-sent button press) is a
 * no-op: continuing would run the agent again and append an answer nobody
 * asked for. A decision saved but never continued (a crash) still continues.
 */

type P = { orgId: string };
const principal: P = { orgId: "org_a" };
const finish = (r: string) => ({ type: "finish", finishReason: { unified: r, raw: r }, usage: { inputTokens: { total: 5 }, outputTokens: { total: 3 } } });
const textStep = (t: string) => ({
  stream: simulateReadableStream({
    initialDelayInMs: 0,
    chunkDelayInMs: 0,
    chunks: [{ type: "stream-start", warnings: [] }, { type: "text-start", id: "0" }, { type: "text-delta", id: "0", delta: t }, { type: "text-end", id: "0" }, finish("stop")],
  }),
});
const callStep = () => ({
  stream: simulateReadableStream({
    initialDelayInMs: 0,
    chunkDelayInMs: 0,
    chunks: [{ type: "stream-start", warnings: [] }, { type: "tool-call", toolCallId: "c1", toolName: "send_email", input: '{"to":"x"}' }, finish("tool-calls")],
  }),
});
const user = (t: string): AppMessage => ({ id: `u_${t.replace(/\W/g, "")}`, role: "user", parts: [{ type: "text", text: t }] });

function setup() {
  const mem = memoryStorage();
  const sent: string[] = [];
  let n = 0;
  // First call asks to send an email; every later call just answers.
  const model = new MockLanguageModelV4({ modelId: "m", doStream: (async () => (n++ === 0 ? callStep() : textStep(`reply ${n}`))) as never });
  const rt = createRuntime<P>({
    storage: mem.storage,
    context: defineContext<P, unknown>({ build: async () => ({}) }),
    agents: {
      a: defineAgent({
        model,
        instructions: "x",
        tools: { send_email: tool({ description: "send", inputSchema: z.object({ to: z.string() }), execute: async ({ to }) => (sent.push(to), { sent: true }) }) },
        toolApproval: { send_email: "user-approval" },
      }),
    },
  });
  const approvalId = () =>
    (mem.messages.get("c")!.flatMap((m) => m.parts) as { approval?: { id: string } }[]).find((p) => p.approval)!.approval!.id;
  return { mem, rt, model, sent, approvalId };
}

describe("applyApproval and stale approvals", () => {
  it("ignores an approval the chat has moved past: no model call, nothing appended, nothing executed", async () => {
    const { mem, rt, model, sent, approvalId } = setup();
    await (await rt.handleChat({ agent: "a", chatId: "c", principal, message: user("send it") })).text();
    const id = approvalId();
    // The user moves on instead of deciding; the paused call is declined.
    for (const t of ["never mind", "something else"]) await (await rt.handleChat({ agent: "a", chatId: "c", principal, message: user(t) })).text();
    const calls = model.doStreamCalls.length;
    const before = JSON.stringify(mem.messages.get("c"));

    // The old tab's Approve arrives.
    const res = await rt.applyApproval({ chatId: "c", principal, decisions: [{ approvalId: id, approved: true }] });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(model.doStreamCalls).toHaveLength(calls);
    expect(JSON.stringify(mem.messages.get("c"))).toBe(before);
    expect(sent).toEqual([]);
  });

  it("still applies a decision for the paused message", async () => {
    const { rt, sent, approvalId } = setup();
    await (await rt.handleChat({ agent: "a", chatId: "c", principal, message: user("send it") })).text();
    await (await rt.applyApproval({ chatId: "c", principal, decisions: [{ approvalId: approvalId(), approved: true }] })).text();
    expect(sent).toEqual(["x"]);
  });

  it("ignores the same decision once the agent acted on it — approve twice, decline twice, or flip it", async () => {
    for (const [first, second] of [[true, true], [false, false], [false, true]] as const) {
      const { mem, rt, model, sent, approvalId } = setup();
      await (await rt.handleChat({ agent: "a", chatId: "c", principal, message: user("send it") })).text();
      const id = approvalId();
      await (await rt.applyApproval({ chatId: "c", principal, decisions: [{ approvalId: id, approved: first }] })).text();
      const calls = model.doStreamCalls.length;
      const before = JSON.stringify(mem.messages.get("c"));
      // A double click, Slack re-sending the button press, a second tab.
      const res = await rt.applyApproval({ chatId: "c", principal, decisions: [{ approvalId: id, approved: second }] });
      expect(await res.text()).toBe("");
      expect(model.doStreamCalls).toHaveLength(calls);
      expect(JSON.stringify(mem.messages.get("c"))).toBe(before);
      expect(sent).toEqual(first ? ["x"] : []);
    }
  });

  it("ignores a decision for an approval that doesn't exist", async () => {
    const { rt, model } = setup();
    await (await rt.handleChat({ agent: "a", chatId: "c", principal, message: user("send it") })).text();
    const calls = model.doStreamCalls.length;
    expect(await (await rt.applyApproval({ chatId: "c", principal, decisions: [{ approvalId: "nope", approved: true }] })).text()).toBe("");
    expect(model.doStreamCalls).toHaveLength(calls);
  });

  it("still continues a retry of a decision that was saved but never acted on", async () => {
    const { mem, rt, model, approvalId } = setup();
    await (await rt.handleChat({ agent: "a", chatId: "c", principal, message: user("send it") })).text();
    const id = approvalId();
    // A crash after the decision was persisted, before the turn continued:
    // the approval is decided, and still on the last message.
    const last = mem.messages.get("c")!.at(-1)!;
    for (const p of last.parts as { state?: string; approval?: { id: string; approved?: boolean } }[]) {
      if (p.approval?.id === id) (p.state = "approval-responded"), (p.approval = { ...p.approval, approved: true });
    }
    const calls = model.doStreamCalls.length;
    await (await rt.applyApproval({ chatId: "c", principal, decisions: [{ approvalId: id, approved: true }] })).text();
    expect(model.doStreamCalls.length).toBeGreaterThan(calls);
  });
});

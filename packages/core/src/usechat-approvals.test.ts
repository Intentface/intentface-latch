import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { simulateReadableStream, tool } from "ai";
import { z } from "zod";
import { createRuntime } from "./runtime.js";
import { defineContext } from "./context.js";
import { defineAgent } from "./agent.js";
import { isInvalidMessageError, type AppMessage } from "./message.js";
import { memoryStorage } from "./__tests__/memory-storage.js";

/**
 * Approvals with two cards in one step, decided the two ways a client can:
 * through `applyApproval` (one card at a time or all at once), and through
 * `useChat`'s own flow, where `addToolApprovalResponse` marks the cards on the
 * client's copy of the message and `sendAutomaticallyWhen` sends it back once
 * every card is answered. Either way the step waits for every card, then runs
 * exactly the approved calls, with the inputs the agent asked for.
 */

type P = { orgId: string };
const principal: P = { orgId: "org_a" };

const finish = (r: string) => ({ type: "finish", finishReason: { unified: r, raw: r }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } });
const call = (id: string, input: string) => [
  { type: "tool-input-start", id, toolName: "refund" },
  { type: "tool-input-delta", id, delta: input },
  { type: "tool-input-end", id },
  { type: "tool-call", toolCallId: id, toolName: "refund", input },
];

/** Step 1 asks to refund 100 and 200 in parallel; every later step answers "done". */
function model() {
  let n = 0;
  return new MockLanguageModelV4({
    modelId: "mock",
    doStream: (async () => {
      n++;
      const chunks =
        n === 1
          ? [{ type: "stream-start", warnings: [] }, ...call("c1", '{"cents":100}'), ...call("c2", '{"cents":200}'), finish("tool-calls")]
          : [{ type: "stream-start", warnings: [] }, { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "done" }, { type: "text-end", id: "t" }, finish("stop")];
      return { stream: simulateReadableStream({ initialDelayInMs: 0, chunkDelayInMs: 0, chunks }) };
    }) as never,
  });
}

async function pausedOnTwoCards() {
  const mem = memoryStorage();
  const ran: unknown[] = [];
  const m = model();
  const refund = tool({
    description: "Refund.",
    inputSchema: z.object({ cents: z.number() }),
    execute: async (input) => {
      ran.push(input);
      return { ok: true };
    },
  });
  const rt = createRuntime<P>({
    storage: mem.storage,
    context: defineContext<P, unknown>({ build: async () => ({}) }),
    agents: { a: defineAgent({ model: m, tools: { refund }, toolApproval: { refund: "user-approval" } }) },
  });
  await (await rt.handleChat({ agent: "a", chatId: "c", principal, message: { id: "u1", role: "user", parts: [{ type: "text", text: "refund both" }] } })).text();
  const paused = mem.messages.get("c")!.at(-1)!;
  const cards = (paused.parts as Array<{ state?: string; approval?: { id: string } }>)
    .filter((p) => p.state === "approval-requested")
    .map((p) => p.approval!.id);
  expect(cards).toHaveLength(2);
  const outcome = () =>
    (mem.messages.get("c")!.flatMap((x) => x.parts) as Array<{ type: string; toolCallId?: string; state?: string }>)
      .filter((p) => p.type === "tool-refund")
      .map((p) => `${p.toolCallId}:${p.state}`);
  return { mem, rt, ran, cards, paused, outcome, modelCalls: () => m.doStreamCalls.length };
}

/** What `useChat` sends after `addToolApprovalResponse` on each card. */
function answered(paused: AppMessage, decide: (approvalId: string) => boolean, edit?: (part: Record<string, unknown>) => void): AppMessage {
  const copy = structuredClone(paused) as AppMessage;
  for (const part of copy.parts as Array<Record<string, unknown> & { state?: string; approval?: { id: string } }>) {
    if (part.state !== "approval-requested") continue;
    part.state = "approval-responded";
    part.approval = { id: part.approval!.id, approved: decide(part.approval!.id) } as never;
    edit?.(part);
  }
  return copy;
}

describe("two approval cards in one step, through applyApproval", () => {
  it("waits for both cards, then runs only the approved one", async () => {
    const { rt, ran, cards, outcome } = await pausedOnTwoCards();
    const first = await rt.applyApproval({ chatId: "c", principal, decisions: [{ approvalId: cards[0]!, approved: true }] });
    expect(await first.text()).toBe(""); // the other card is still open: nothing runs yet
    expect(ran).toEqual([]);
    const second = await rt.applyApproval({ chatId: "c", principal, decisions: [{ approvalId: cards[1]!, approved: false }] });
    expect(second.headers.get("content-type")).toMatch(/event-stream/);
    await second.text();
    expect(ran).toEqual([{ cents: 100 }]);
    expect(outcome()).toEqual(["c1:output-available", "c2:output-denied"]);
  });

  it("takes both decisions in one call", async () => {
    const { rt, ran, cards, outcome } = await pausedOnTwoCards();
    await (await rt.applyApproval({ chatId: "c", principal, decisions: cards.map((id) => ({ approvalId: id, approved: true })) })).text();
    expect(ran).toEqual([{ cents: 100 }, { cents: 200 }]);
    expect(outcome()).toEqual(["c1:output-available", "c2:output-available"]);
  });
});

describe("useChat's own approval flow, through handleChat", () => {
  it("runs exactly the approved calls and streams the continuation", async () => {
    const { rt, ran, cards, paused, outcome } = await pausedOnTwoCards();
    const res = await rt.handleChat({ agent: "a", chatId: "c", principal, message: answered(paused, (id) => id === cards[0]) });
    expect(res.headers.get("content-type")).toMatch(/event-stream/);
    await res.text();
    expect(ran).toEqual([{ cents: 100 }]);
    expect(outcome()).toEqual(["c1:output-available", "c2:output-denied"]);
  });

  it("runs the input the agent asked for, not one the client edited", async () => {
    const { rt, ran, paused } = await pausedOnTwoCards();
    const edited = answered(paused, () => true, (part) => {
      part.input = { cents: 1_000_000 };
    });
    await (await rt.handleChat({ agent: "a", chatId: "c", principal, message: edited })).text();
    expect(ran).toEqual([{ cents: 100 }, { cents: 200 }]);
  });

  it("ignores the same answers sent twice", async () => {
    const { rt, ran, cards, paused, modelCalls } = await pausedOnTwoCards();
    const msg = answered(paused, (id) => id === cards[0]);
    await (await rt.handleChat({ agent: "a", chatId: "c", principal, message: msg })).text();
    const calls = modelCalls();
    const again = await rt.handleChat({ agent: "a", chatId: "c", principal, message: msg });
    expect(await again.text()).toBe("");
    expect(ran).toEqual([{ cents: 100 }]);
    expect(modelCalls()).toBe(calls);
  });

  it("refuses an assistant message that answers nothing", async () => {
    const { rt, paused } = await pausedOnTwoCards();
    await expect(rt.handleChat({ agent: "a", chatId: "c", principal, message: paused })).rejects.toSatisfy(isInvalidMessageError);
  });
});

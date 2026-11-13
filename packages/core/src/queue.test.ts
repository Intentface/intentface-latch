import { describe, expect, it } from "vitest";
import { tool } from "ai";
import { z } from "zod";
import { MockLanguageModelV4 } from "ai/test";
import { isChatBusyError, isQueueFullError } from "./storage.js";
import type { AppMessage } from "./message.js";
import { call, harness, principal, promptsOf, scripted, text, user } from "./__tests__/turn.js";

/**
 * The input queue: a message or signal that arrives while an answer is
 * running is held, and the answer that ends starts the next turn with
 * everything held. Held inputs join the history only when that turn opens.
 */

const roles = (messages: Array<{ role: string }>) => messages.map((m) => m.role);
const ids = (messages: AppMessage[]) => messages.map((m) => m.id);
type H = ReturnType<typeof harness>;

/** A turn that is opened and not yet read: the chat is busy until `live.text()`. */
const open = (h: H, message = user("q1")) => h.runtime.handleChat({ agent: "a", principal, chatId: "chat_1", message });
const send = (h: H, message: AppMessage) =>
  h.runtime.handleChat({ agent: "a", principal, chatId: "chat_1", message, ifBusy: "queue" });
const stored = (h: H) => h.mem.messages.get("chat_1")!;

describe("a message sent while an answer is running", () => {
  it("is refused without ifBusy: queue", async () => {
    const h = harness({ model: scripted([text("a1")]) });
    const live = await open(h);
    await expect(open(h, user("q2", "u2"))).rejects.toSatisfy(isChatBusyError);
    await live.text();
  });

  it("is held, then answered when that answer ends", async () => {
    const model = scripted([text("a1"), text("a2")]);
    const h = harness({ model });
    const live = await open(h);

    const res = await send(h, user("q2", "u2"));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ queued: { id: "u2" } });
    // Held apart from the history, which is still the first turn alone.
    expect(ids(stored(h))).toEqual(["u1"]);
    expect(ids(await h.runtime.listQueued({ chatId: "chat_1", principal }))).toEqual(["u2"]);

    await live.text();
    expect(roles(stored(h))).toEqual(["user", "assistant", "user", "assistant"]);
    expect(ids(stored(h)).filter((id) => id.startsWith("u"))).toEqual(["u1", "u2"]);
    expect(await h.runtime.listQueued({ chatId: "chat_1", principal })).toEqual([]);
    expect(roles(promptsOf(model)[1]!)).toEqual(["system", "user", "assistant", "user"]);
    expect([...h.mem.runs.values()].map((r) => r.status)).toEqual(["completed", "completed"]);
  });

  it("answers everything held in one turn, signals read with the messages", async () => {
    const model = scripted([text("a1"), text("a2")]);
    const h = harness({ model, notices: "system" });
    const live = await open(h);
    await send(h, user("q2", "u2"));
    const sent = await h.runtime.sendSignal({ chatId: "chat_1", principal, text: "The export is ready." });
    await send(h, user("q3", "u3"));
    expect(sent).toMatchObject({ queued: true });
    expect(sent!.turn).toBeUndefined();

    await live.text();
    expect(model.doStreamCalls).toHaveLength(2);
    const second = promptsOf(model)[1]!;
    expect(roles(second)).toEqual(["system", "user", "assistant", "user", "user", "system"]);
    expect(second.at(-1)).toEqual({ role: "system", content: "The export is ready." });
    // The signal is one that waits, stored before the messages it is read with.
    expect(roles(stored(h))).toEqual(["user", "assistant", "system", "user", "user", "assistant"]);
    expect(stored(h)[2]!.metadata!.signal).toEqual({ kind: "notice" });
  });

  it("later turns send what that turn sent", async () => {
    const model = scripted([text("a1"), text("a2"), text("a3")]);
    const h = harness({ model, notices: "system" });
    const live = await open(h);
    await send(h, user("q2", "u2"));
    await h.runtime.sendSignal({ chatId: "chat_1", principal, text: "The export is ready." });
    await live.text();
    await h.turn(user("q3", "u3"));
    const [, second, third] = promptsOf(model);
    expect(third!.slice(0, second!.length)).toEqual(second);
  });

  it("is not held when it regenerates the question being answered", async () => {
    const h = harness({ model: scripted([text("a1")]) });
    const live = await open(h);
    await expect(send(h, user("q1"))).rejects.toSatisfy(isChatBusyError);
    await live.text();
    expect(await h.runtime.listQueued({ chatId: "chat_1", principal })).toEqual([]);
  });

  it("is refused past the cap, and a signal past it waits for the next message", async () => {
    const model = scripted([text("a1"), text("a2")]);
    const h = harness({ model, inputQueue: { max: 2 } });
    const live = await open(h);
    await send(h, user("q2", "u2"));
    await send(h, user("q3", "u3"));
    await expect(send(h, user("q4", "u4"))).rejects.toSatisfy(isQueueFullError);
    const sent = await h.runtime.sendSignal({ chatId: "chat_1", principal, text: "late" });
    expect(sent!.queued).toBeUndefined();
    expect(stored(h).at(-1)!.metadata!.signal).toEqual({ kind: "notice" });
    await live.text();
    expect(ids(stored(h))).not.toContain("u4");
  });

  it("can be taken back before its turn starts", async () => {
    const model = scripted([text("a1"), text("a2")]);
    const h = harness({ model });
    const live = await open(h);
    await send(h, user("q2", "u2"));
    expect(await h.runtime.cancelQueued({ chatId: "chat_1", principal, id: "u2" })).toBe(true);
    expect(await h.runtime.cancelQueued({ chatId: "chat_1", principal, id: "u2" })).toBe(false);
    await live.text();
    expect(model.doStreamCalls).toHaveLength(1);
    expect(ids(stored(h))).not.toContain("u2");
  });

  it("gets the turn after, when it arrives while held inputs are being answered", async () => {
    const h: { current?: H } = {};
    const base = scripted([text("a1"), text("a2"), text("a3")]);
    let calls = 0;
    const model = new MockLanguageModelV4({
      modelId: "mock",
      doStream: (async (o: never) => {
        // While the second answer is written, a third question arrives.
        if (++calls === 2) await send(h.current!, user("q3", "u3"));
        return (base.doStream as (o: never) => unknown)(o);
      }) as never,
    });
    h.current = harness({ model });
    const live = await open(h.current);
    await send(h.current, user("q2", "u2"));
    await live.text();
    expect(calls).toBe(3);
    expect(roles(stored(h.current))).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
  });
});

describe("a signal sent while the chat is busy", () => {
  it("starts its turn when the answer ends", async () => {
    const model = scripted([text("a1"), text("Your export is ready.")]);
    const h = harness({ model, notices: "system" });
    const live = await open(h);
    const sent = await h.runtime.sendSignal({ chatId: "chat_1", principal, text: "one", id: "s1" });
    await h.runtime.sendSignal({ chatId: "chat_1", principal, text: "two", id: "s2" });
    expect(sent).toEqual({ id: "s1", queued: true });
    // A retried call is held once.
    expect(await h.runtime.sendSignal({ chatId: "chat_1", principal, text: "one", id: "s1" })).toEqual({ id: "s1", queued: true });
    expect(h.mem.queued.get("chat_1")).toHaveLength(2);
    // The user doesn't see a signal they wouldn't see in the history.
    expect(await h.runtime.listQueued({ chatId: "chat_1", principal })).toEqual([]);

    await live.text();
    expect(model.doStreamCalls).toHaveLength(2);
    expect(roles(stored(h))).toEqual(["user", "assistant", "system", "system", "assistant"]);
    // One turn for both: the last opens it, the one before is read with it.
    expect(stored(h)[2]!.metadata!.signal).toEqual({ kind: "notice" });
    expect(stored(h)[3]!.metadata!.signal).toEqual({ kind: "notice", startsTurn: true });
    expect(JSON.stringify(promptsOf(model)[1])).toContain("one");
    expect(JSON.stringify(promptsOf(model)[1])).toContain("two");
  });

  it("is never held with wake: false", async () => {
    const model = scripted([text("a1")]);
    const h = harness({ model });
    const live = await open(h);
    const sent = await h.runtime.sendSignal({ chatId: "chat_1", principal, text: "fyi", wake: false });
    await live.text();
    expect(sent!.queued).toBeUndefined();
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it("waits for the person the chat is waiting on, then gets its turn", async () => {
    const tools = { getTimezone: tool({ description: "The user's timezone.", inputSchema: z.object({}) }) };
    const model = scripted([call("getTimezone"), text("Helsinki then."), text("Noted.")]);
    const h = harness({ model, tools });
    await h.turn(user("what time is it for me?"));
    const sent = await h.runtime.sendSignal({ chatId: "chat_1", principal, text: "The office moved to Oslo." });
    expect(sent).toMatchObject({ queued: true });
    expect(model.doStreamCalls).toHaveLength(1);

    const res = await h.runtime.applyToolResult({ chatId: "chat_1", principal, toolCallId: "call_1", output: { tz: "Europe/Helsinki" } });
    await res.text();
    // The paused answer finished without the signal, which then got its own.
    expect(JSON.stringify(promptsOf(model)[1])).not.toContain("Oslo");
    expect(model.doStreamCalls).toHaveLength(3);
    expect(roles(stored(h))).toEqual(["user", "assistant", "system", "assistant"]);
  });

  it("started by another signal's turn, gets its turn when that one ends", async () => {
    const h: { current?: H } = {};
    const base = scripted([text("a1"), text("a2"), text("a3")]);
    let calls = 0;
    const model = new MockLanguageModelV4({
      modelId: "mock",
      doStream: (async (o: never) => {
        if (++calls === 2) await h.current!.runtime.sendSignal({ chatId: "chat_1", principal, text: "second" });
        return (base.doStream as (o: never) => unknown)(o);
      }) as never,
    });
    h.current = harness({ model });
    await h.current.turn(user("q1"));
    const sent = await h.current.runtime.sendSignal({ chatId: "chat_1", principal, text: "first" });
    // The first signal's own answer, not the one to the signal that arrived during it.
    expect(sent!.turn).toEqual({ answer: "a2", parked: false });
    expect(calls).toBe(3);
    expect(roles(stored(h.current))).toEqual(["user", "assistant", "system", "assistant", "system", "assistant"]);
  });
});

describe("with waitUntil", () => {
  it("closes the stream when its answer ends, and answers what is held after", async () => {
    const model = scripted([text("a1"), text("a2")]);
    const background: Promise<unknown>[] = [];
    const h = harness({ model, waitUntil: (work) => void background.push(work) });
    const live = await open(h);
    const res = await send(h, user("q2", "u2"));
    expect(res.status).toBe(202);

    await live.text();
    // The page's stream is done; the held turn is the host's to keep alive.
    await Promise.all(background);
    expect(roles(stored(h))).toEqual(["user", "assistant", "user", "assistant"]);
    expect(model.doStreamCalls).toHaveLength(2);
  });
});

describe("runtime.cron", () => {
  it("starts the turn for inputs nobody started one for", async () => {
    const model = scripted([text("a1"), text("a2")]);
    const h = harness({ model });
    await h.turn(user("q1"));
    // Held, and the process that would have started its turn is gone.
    await h.mem.storage.enqueueInput!(principal, "chat_1", user("q2", "u2"), { cap: 20 });

    // Too fresh to be stranded: whoever held it may still be about to start it.
    expect((await h.runtime.cron()).held).toBe(0);
    const tick = await h.runtime.cron({ now: Date.now() + 60_000 });
    expect(tick.held).toBe(1);
    expect(tick.errors.filter((e) => e.startsWith("held inputs"))).toEqual([]);
    expect(roles(stored(h))).toEqual(["user", "assistant", "user", "assistant"]);
    expect((await h.runtime.cron({ now: Date.now() + 60_000 })).held).toBe(0);
  });

  it("leaves a chat that is waiting on a person alone", async () => {
    const tools = { getTimezone: tool({ description: "The user's timezone.", inputSchema: z.object({}) }) };
    const model = scripted([call("getTimezone"), text("Helsinki then.")]);
    const h = harness({ model, tools });
    await h.turn(user("what time is it for me?"));
    await h.runtime.sendSignal({ chatId: "chat_1", principal, text: "news" });
    const tick = await h.runtime.cron({ now: Date.now() + 60_000 });
    expect(tick.held).toBe(0);
    expect(h.mem.queued.get("chat_1")).toHaveLength(1);
    expect(model.doStreamCalls).toHaveLength(1);
  });
});

describe("a storage adapter without the queue", () => {
  it("refuses a message and keeps a signal for the next one, as before", async () => {
    const model = scripted([text("a1")]);
    const h = harness({ model, queue: false });
    const live = await open(h);
    await expect(send(h, user("q2", "u2"))).rejects.toSatisfy(isChatBusyError);
    const sent = await h.runtime.sendSignal({ chatId: "chat_1", principal, text: "news" });
    await live.text();
    expect(sent!.queued).toBeUndefined();
    expect(model.doStreamCalls).toHaveLength(1);
    expect(await h.runtime.listQueued({ chatId: "chat_1", principal })).toEqual([]);
  });
});

describe("pollChat", () => {
  it("returns the history only when it changed", async () => {
    const h = harness({ model: scripted([text("a1"), text("a2")]) });
    expect(await h.runtime.pollChat({ chatId: "chat_1", principal })).toBeNull();
    await h.turn(user("q1"));

    const first = (await h.runtime.pollChat({ chatId: "chat_1", principal }))!;
    expect(roles(first.messages!)).toEqual(["user", "assistant"]);
    expect(first).toMatchObject({ running: false, queued: [] });

    const same = (await h.runtime.pollChat({ chatId: "chat_1", principal, cursor: first.cursor }))!;
    expect(same.messages).toBeUndefined();
    expect(same.cursor).toBe(first.cursor);

    // A signal's turn ran with no page attached: the next poll has it.
    await h.runtime.sendSignal({ chatId: "chat_1", principal, text: "The export is ready." });
    const after = (await h.runtime.pollChat({ chatId: "chat_1", principal, cursor: first.cursor }))!;
    expect(roles(after.messages!)).toEqual(["user", "assistant", "assistant"]);
    expect(after.cursor).not.toBe(first.cursor);
  });

  it("says an answer is running and what is held", async () => {
    const h = harness({ model: scripted([text("a1"), text("a2")]) });
    const live = await open(h);
    await send(h, user("q2", "u2"));
    const during = (await h.runtime.pollChat({ chatId: "chat_1", principal }))!;
    expect(during.running).toBe(true);
    expect(ids(during.queued)).toEqual(["u2"]);
    await live.text();
    const after = (await h.runtime.pollChat({ chatId: "chat_1", principal }))!;
    expect(after).toMatchObject({ running: false, queued: [] });
  });
});

import { describe, expect, it } from "vitest";
import { tool } from "ai";
import { z } from "zod";
import { MockLanguageModelV4 } from "ai/test";
import { isChatBusyError, isQueueFullError } from "./storage.js";
import type { AppMessage } from "./message.js";
import { call, harness, principal, promptsOf, scripted, text, user } from "./__tests__/turn.js";
import { memoryStorage } from "./__tests__/memory-storage.js";
import { createRuntime } from "./runtime.js";
import { defineAgent } from "./agent.js";
import { defineContext } from "./context.js";
import { DAY_MS, usageKey, type LimitStore } from "./limits.js";

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

describe("taking held inputs when their turn opens", () => {
  it("frees their place in the queue while they are being answered", async () => {
    const h: { current?: H } = {};
    const base = scripted([text("a1"), text("a2"), text("a3")]);
    let calls = 0;
    let during: string[] | undefined;
    const model = new MockLanguageModelV4({
      modelId: "mock",
      doStream: (async (o: never) => {
        if (++calls === 2) {
          // The one place is free again: the held message is being answered, not waiting.
          await send(h.current!, user("q3", "u3"));
          during = ids(await h.current!.runtime.listQueued({ chatId: "chat_1", principal }));
        }
        return (base.doStream as (o: never) => unknown)(o);
      }) as never,
    });
    h.current = harness({ model, inputQueue: { max: 1 } });
    const live = await open(h.current);
    await send(h.current, user("q2", "u2"));
    await live.text();
    expect(during).toEqual(["u3"]);
    expect(calls).toBe(3);
  });

  it("never answers one that was taken back just as its turn opened", async () => {
    const model = scripted([text("a1"), text("a2")]);
    const h = harness({ model });
    const live = await open(h);
    await send(h, user("q2", "u2"));
    // The held turn's run opens, and in that instant the user takes the message back.
    const createRun = h.mem.storage.createRun.bind(h.mem.storage);
    let cancelled: boolean | undefined;
    h.mem.storage.createRun = async (p, input) => {
      const run = await createRun(p, input);
      cancelled = await h.runtime.cancelQueued({ chatId: "chat_1", principal, id: "u2" });
      return run;
    };
    await live.text();
    expect(cancelled).toBe(true);
    expect(model.doStreamCalls).toHaveLength(1);
    expect(ids(await h.runtime.loadHistory({ chatId: "chat_1", principal }))).not.toContain("u2");
    // The run it opened is closed, and the chat is free.
    expect([...h.mem.runs.values()].at(-1)).toMatchObject({ status: "errored", error: "not started: nothing left to answer" });
    h.mem.storage.createRun = createRun;
    await h.turn(user("q3", "u3"));
    expect(JSON.stringify(promptsOf(model).at(-1))).not.toContain("q2");
  });

  it("answers them once when two workers go for them at the same time", async () => {
    const model = scripted([text("a1"), text("a2"), text("a3")]);
    const h = harness({ model });
    await h.turn(user("q1"));
    await h.mem.storage.enqueueInput!(principal, "chat_1", user("q2", "u2"), { cap: 20 });
    const later = Date.now() + 60_000;
    const ticks = await Promise.all([h.runtime.cron({ now: later }), h.runtime.cron({ now: later })]);
    expect(ticks[0]!.held + ticks[1]!.held).toBe(1);
    expect(model.doStreamCalls).toHaveLength(2);
    expect(roles(stored(h).filter((m) => m.metadata?.sendToModel !== false))).toEqual(["user", "assistant", "user", "assistant"]);
  });
});

describe("a held turn and what happens around it", () => {
  it("is not undone by another worker that sees its inputs stored but not yet taken", async () => {
    const model = scripted([text("a1"), text("a2"), text("a3")]);
    const h = harness({ model });
    await h.turn(user("q1"));
    await h.mem.storage.enqueueInput!(principal, "chat_1", user("q2", "u2"), { cap: 20 });
    // Between the held turn storing its input and taking it from the queue,
    // a second worker looks at the same chat.
    const append = h.mem.storage.appendMessages.bind(h.mem.storage);
    let other: Promise<unknown> | undefined;
    h.mem.storage.appendMessages = async (chatId, messages, ...rest) => {
      const out = await append(chatId, messages, ...rest);
      if (!other && messages.some((m) => m.id === "u2")) {
        other = h.runtime.cron({ now: Date.now() + 120_000 });
        await other;
      }
      return out;
    };
    const tick = await h.runtime.cron({ now: Date.now() + 60_000 });
    expect(other).toBeDefined();
    expect(tick.held).toBe(1);
    expect(model.doStreamCalls).toHaveLength(2);
    // Answered, and still there for the user to see.
    expect(roles(await h.runtime.loadHistory({ chatId: "chat_1", principal }))).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("doesn't bring back a chat that was deleted while its inputs were held", async () => {
    const model = scripted([text("a1"), text("a2")]);
    const h = harness({ model });
    await h.turn(user("q1"));
    await h.mem.storage.enqueueInput!(principal, "chat_1", user("q2", "u2"), { cap: 20 });
    // Deleted just after the tick read what was held for it.
    const list = h.mem.storage.listQueuedInputs!.bind(h.mem.storage);
    h.mem.storage.listQueuedInputs = async (p, chatId) => {
      const held = await list(p, chatId);
      h.mem.chats.delete(chatId);
      h.mem.messages.delete(chatId);
      return held;
    };
    const tick = await h.runtime.cron({ now: Date.now() + 60_000 });
    expect(tick.held).toBe(0);
    expect(h.mem.chats.has("chat_1")).toBe(false);
    expect(h.mem.messages.has("chat_1")).toBe(false);
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it("answers a held message as a retry last replaced it", async () => {
    const model = scripted([text("a1"), text("a2")]);
    const h = harness({ model });
    const live = await open(h);
    await send(h, user("q2 as first sent", "u2"));
    // Replaced under the same id after the held turn's run opened, before it took the queue.
    const createRun = h.mem.storage.createRun.bind(h.mem.storage);
    h.mem.storage.createRun = async (p, input) => {
      const run = await createRun(p, input);
      await h.mem.storage.enqueueInput!(principal, "chat_1", user("q2 as revised", "u2"), { cap: 20 });
      return run;
    };
    await live.text();
    const second = JSON.stringify(promptsOf(model)[1]);
    expect(second).toContain("q2 as revised");
    expect(second).not.toContain("q2 as first sent");
    expect(h.mem.queued.get("chat_1")).toBeUndefined();
  });

  it("runs as the sender of what it really answers, in a chat two people share", async () => {
    const ann = { orgId: "org_a", userId: "ann" };
    const bo = { orgId: "org_a", userId: "bo" };
    const mem = memoryStorage<typeof principal>();
    const model = scripted([text("a1"), text("a2")]);
    const ranAs: string[] = [];
    const runtime = createRuntime<typeof principal>({
      storage: mem.storage,
      context: defineContext<typeof principal, unknown>({
        build: async ({ principal: p }) => {
          ranAs.push(p.userId);
          return {};
        },
      }),
      agents: { a: defineAgent<typeof principal>({ model, instructions: "Be brief." }) },
    });
    await (await runtime.handleChat({ agent: "a", principal: ann, chatId: "chat_1", message: user("q1") })).text();
    await mem.storage.enqueueInput!(ann, "chat_1", user("from ann", "u2"), { cap: 20 });
    await mem.storage.enqueueInput!(bo, "chat_1", user("from bo", "u3"), { cap: 20 });
    // Ann takes hers back just as the turn opened for it (as her) is about to take the queue.
    const createRun = mem.storage.createRun.bind(mem.storage);
    let once = false;
    mem.storage.createRun = async (p, input) => {
      const run = await createRun(p, input);
      if (!once) {
        once = true;
        await runtime.cancelQueued({ chatId: "chat_1", principal: ann, id: "u2" });
      }
      return run;
    };
    const tick = await runtime.cron({ now: Date.now() + 60_000 });
    expect(tick.held).toBe(1);
    // Opened as Ann, given up, then run as Bo: only Bo's message is answered.
    expect(ranAs.at(-1)).toBe("bo");
    expect([...mem.runs.values()].map((r) => r.status)).toEqual(["completed", "errored", "completed"]);
    const prompt = JSON.stringify(promptsOf(model)[1]);
    expect(prompt).toContain("from bo");
    expect(prompt).not.toContain("from ann");
  });

  it("keeps what is held when the agent can't be resolved for it, to try again", async () => {
    const mem = memoryStorage<typeof principal>();
    const model = scripted([text("a1"), text("a2")]);
    let broken = true;
    const runtime = createRuntime<typeof principal>({
      storage: mem.storage,
      agents: {
        a: defineAgent<typeof principal>(({ messageContext }) => {
          if (broken && (messageContext as { file?: string } | undefined)?.file === "three.md") throw new Error("lookup failed");
          return { model, instructions: "Be brief." };
        }),
      },
    });
    const viewing = (id: string, t: string, file: string): AppMessage =>
      ({ id, role: "user", parts: [{ type: "text", text: t }, { type: "data-context", data: { file } }], metadata: { visibility: "user" } }) as AppMessage;
    await (await runtime.handleChat({ agent: "a", principal, chatId: "chat_1", message: viewing("u1", "q1", "one.md") })).text();
    await mem.storage.enqueueInput!(principal, "chat_1", viewing("u2", "q2", "two.md"), { cap: 20 });
    await mem.storage.enqueueInput!(principal, "chat_1", viewing("u3", "q3", "three.md"), { cap: 20 });

    const failed = await runtime.cron({ now: Date.now() + 60_000 });
    expect(failed.held).toBe(0);
    expect(failed.errors.some((e) => e.includes("lookup failed"))).toBe(true);
    // Nothing stored, nothing lost: both wait again, taken by nobody.
    expect(mem.messages.get("chat_1")!.map((m) => m.id).filter((id) => id.startsWith("u"))).toEqual(["u1"]);
    expect(mem.queued.get("chat_1")!.map((q) => [q.message.id, q.takenBy])).toEqual([["u2", undefined], ["u3", undefined]]);

    broken = false;
    expect((await runtime.cron({ now: Date.now() + 120_000 })).held).toBe(1);
    expect(mem.messages.get("chat_1")!.map((m) => m.role)).toEqual(["user", "assistant", "user", "user", "assistant"]);
  });

  it("stops when its run is no longer the chat's live one", async () => {
    const model = scripted([text("a1"), text("a2")]);
    const h = harness({ model });
    await h.turn(user("q1"));
    await h.mem.storage.enqueueInput!(principal, "chat_1", user("q2", "u2"), { cap: 20 });
    // The worker paused after opening its run; by the time it takes the
    // queue, the run was superseded.
    const createRun = h.mem.storage.createRun.bind(h.mem.storage);
    h.mem.storage.createRun = async (p, input) => {
      const run = await createRun(p, input);
      h.mem.runs.set(run.id, { ...run, status: "errored" });
      return run;
    };
    const tick = await h.runtime.cron({ now: Date.now() + 60_000 });
    expect(tick.held).toBe(0);
    expect(model.doStreamCalls).toHaveLength(1);
    // Nothing stored, and the input waits for the run that has the chat now.
    expect(ids(stored(h))).not.toContain("u2");
    expect(h.mem.queued.get("chat_1")!.map((q) => [q.message.id, q.takenBy])).toEqual([["u2", undefined]]);
  });

  it("lets go of inputs a dead run took, when their sender may no longer act", async () => {
    const ann = { orgId: "org_a", userId: "ann" };
    const bo = { orgId: "org_a", userId: "bo" };
    const mem = memoryStorage<typeof principal>();
    const model = scripted([text("a1"), text("a2")]);
    const runtime = createRuntime<typeof principal>({
      storage: mem.storage,
      agents: { a: defineAgent<typeof principal>({ model, instructions: "Be brief." }) },
      // Ann has left since she sent her message.
      reconstructPrincipal: async (identity) => ((identity as typeof principal).userId === "ann" ? null : (identity as typeof principal)),
    });
    await (await runtime.handleChat({ agent: "a", principal: bo, chatId: "chat_1", message: user("q1") })).text();
    await mem.storage.enqueueInput!(ann, "chat_1", user("from ann", "u2"), { cap: 20 });
    await mem.storage.enqueueInput!(bo, "chat_1", user("from bo", "u3"), { cap: 20 });
    // A run took both and died before storing them.
    const dead = await mem.storage.createRun(bo, { chatId: "chat_1", agent: "a" });
    await mem.storage.takeQueuedInputs!("chat_1", dead.id);
    mem.runs.set(dead.id, { ...dead, status: "errored" });

    const tick = await runtime.cron({ now: Date.now() + 60_000 });
    expect(tick.held).toBe(1);
    const prompt = JSON.stringify(promptsOf(model)[1]);
    expect(prompt).toContain("from bo");
    expect(prompt).not.toContain("from ann");
    expect(mem.queued.get("chat_1")).toBeUndefined();
  });

  it("closes its run and gives the inputs back when checking their senders fails", async () => {
    const mem = memoryStorage<typeof principal>();
    const model = scripted([text("a1"), text("a2")]);
    let checks = 0;
    let down = true;
    const runtime = createRuntime<typeof principal>({
      storage: mem.storage,
      agents: { a: defineAgent<typeof principal>({ model, instructions: "Be brief." }) },
      // Works when the queue is first looked at, fails once the run has taken it.
      reconstructPrincipal: async (identity) => {
        if (down && ++checks > 2) throw new Error("directory down");
        return identity as typeof principal;
      },
    });
    await (await runtime.handleChat({ agent: "a", principal, chatId: "chat_1", message: user("q1") })).text();
    await mem.storage.enqueueInput!(principal, "chat_1", user("q2", "u2"), { cap: 20 });

    const failed = await runtime.cron({ now: Date.now() + 60_000 });
    expect(failed.held).toBe(0);
    expect(failed.errors.some((e) => e.includes("directory down"))).toBe(true);
    // The run it opened is closed, so the chat is free, and the input waits untaken.
    expect([...mem.runs.values()].at(-1)).toMatchObject({ status: "errored", error: "not started: it failed before it could start" });
    expect(mem.queued.get("chat_1")!.map((q) => [q.message.id, q.takenBy])).toEqual([["u2", undefined]]);

    down = false;
    expect((await runtime.cron({ now: Date.now() + 120_000 })).held).toBe(1);
    expect(mem.messages.get("chat_1")!.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("gives back the turn it reserved even when its run can't be closed", async () => {
    const mem = memoryStorage<typeof principal>();
    const turns = { n: 0 };
    const limitStore: LimitStore = {
      read: async (refs) => Object.fromEntries(refs.map((r) => [usageKey(r), { turns: turns.n, tokens: 0, cost: 0 }])),
      add: async (entries) => {
        for (const e of entries) turns.n += e.usage.turns ?? 0;
        return Object.fromEntries(entries.map((e) => [usageKey(e), { turns: turns.n, tokens: 0, cost: 0 }]));
      },
    };
    let checks = 0;
    const runtime = createRuntime<typeof principal>({
      storage: mem.storage,
      agents: { a: defineAgent<typeof principal>({ model: scripted([text("a1")]), instructions: "Be brief." }) },
      limits: { store: limitStore, limitsFor: () => [{ key: "all", windowMs: DAY_MS, max: { turns: 100 } }] },
      reconstructPrincipal: async (identity) => {
        if (++checks > 2) throw new Error("directory down");
        return identity as typeof principal;
      },
    });
    await (await runtime.handleChat({ agent: "a", principal, chatId: "chat_1", message: user("q1") })).text();
    await mem.storage.enqueueInput!(principal, "chat_1", user("q2", "u2"), { cap: 20 });
    const after = turns.n;

    // The storage refuses the write that closes the run it opened.
    const updateRun = mem.storage.updateRun.bind(mem.storage);
    mem.storage.updateRun = async (id, patch, ...rest) => {
      if (typeof patch.error === "string" && patch.error.startsWith("not started")) throw new Error("storage down");
      return updateRun(id, patch, ...rest);
    };
    const failed = await runtime.cron({ now: Date.now() + 60_000 });
    expect(failed.errors.some((e) => e.includes("directory down"))).toBe(true);
    expect(turns.n).toBe(after);
  });

  it("gives the agent the context of the message it really answers", async () => {
    const mem = memoryStorage<typeof principal>();
    const model = scripted([text("a1"), text("a2")]);
    const seen: unknown[] = [];
    const runtime = createRuntime<typeof principal>({
      storage: mem.storage,
      agents: {
        a: defineAgent<typeof principal>(({ messageContext }) => {
          seen.push(messageContext);
          return { model, instructions: "Be brief." };
        }),
      },
    });
    const viewing = (id: string, t: string, file: string): AppMessage =>
      ({ id, role: "user", parts: [{ type: "text", text: t }, { type: "data-context", data: { file } }], metadata: { visibility: "user" } }) as AppMessage;
    const live = await runtime.handleChat({ agent: "a", principal, chatId: "chat_1", message: viewing("u1", "q1", "one.md") });
    await runtime.handleChat({ agent: "a", principal, chatId: "chat_1", message: viewing("u2", "q2", "two.md"), ifBusy: "queue" });
    await runtime.handleChat({ agent: "a", principal, chatId: "chat_1", message: viewing("u3", "q3", "three.md"), ifBusy: "queue" });
    await live.text();
    // The held turn answers u2 and u3: the agent is built for the later one.
    expect(seen.at(-1)).toEqual({ file: "three.md" });
    expect(model.doStreamCalls).toHaveLength(2);
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

  it("carries on with the other chats when one fails", async () => {
    const model = scripted([text("a1"), text("a2"), text("a3")]);
    const h = harness({ model });
    await h.turn(user("q1"), "chat_broken");
    await h.turn(user("q1"), "chat_1");
    await h.mem.storage.enqueueInput!(principal, "chat_broken", user("q2", "u2"), { cap: 20 });
    await h.mem.storage.enqueueInput!(principal, "chat_1", user("q2", "u2"), { cap: 20 });
    // Its agent is gone since.
    h.mem.chats.get("chat_broken")!.agent = "retired";

    const tick = await h.runtime.cron({ now: Date.now() + 60_000 });
    expect(tick.held).toBe(1);
    expect(tick.errors.filter((e) => e.includes("chat_broken"))).toHaveLength(1);
    expect(roles(stored(h))).toEqual(["user", "assistant", "user", "assistant"]);
    // The failed one is still held, for when it can be answered.
    expect(h.mem.queued.get("chat_broken")).toHaveLength(1);
  });

  it("reads a shared chat as a sender who can still see it", async () => {
    const ann = { orgId: "org_a", userId: "ann" };
    const bo = { orgId: "org_a", userId: "bo" };
    const mem = memoryStorage<typeof principal>();
    const model = scripted([text("a1"), text("a2")]);
    const runtime = createRuntime<typeof principal>({
      storage: mem.storage,
      agents: { a: defineAgent<typeof principal>({ model, instructions: "Be brief." }) },
    });
    await (await runtime.handleChat({ agent: "a", principal: bo, chatId: "chat_1", message: user("q1") })).text();
    await mem.storage.enqueueInput!(ann, "chat_1", { ...user("fyi", "s1"), role: "system", metadata: { visibility: "internal", signal: { kind: "notice" } } } as AppMessage, { cap: 20 });
    await mem.storage.enqueueInput!(bo, "chat_1", user("from bo", "u2"), { cap: 20 });
    // Ann was moved out of the chat's owner since: her reads of it find nothing.
    const getChat = mem.storage.getChat.bind(mem.storage);
    mem.storage.getChat = async (p, id) => (p.userId === "ann" ? null : getChat(p, id));

    const tick = await runtime.cron({ now: Date.now() + 60_000 });
    expect(tick.held).toBe(1);
    expect(JSON.stringify(promptsOf(model)[1])).toContain("from bo");
  });

  it("leaves inputs a live run holds alone, also when their sender may no longer act", async () => {
    const mem = memoryStorage<typeof principal>();
    const model = scripted([text("a1"), text("a2")]);
    const runtime = createRuntime<typeof principal>({
      storage: mem.storage,
      agents: { a: defineAgent<typeof principal>({ model, instructions: "Be brief." }) },
      reconstructPrincipal: async (identity) => ((identity as typeof principal).userId === "gone" ? null : (identity as typeof principal)),
    });
    await (await runtime.handleChat({ agent: "a", principal, chatId: "chat_1", message: user("q1") })).text();
    await mem.storage.enqueueInput!({ orgId: "org_a", userId: "gone" }, "chat_1", user("q2", "u2"), { cap: 20 });
    await mem.storage.enqueueInput!(principal, "chat_1", user("q3", "u3"), { cap: 20 });
    const holder = await mem.storage.createRun(principal, { chatId: "chat_1", agent: "a" });
    await mem.storage.takeQueuedInputs!("chat_1", holder.id);

    const tick = await runtime.cron({ now: Date.now() + 60_000 });
    expect(tick.held).toBe(0);
    // Still that run's: neither put back in line nor dropped.
    expect(mem.queued.get("chat_1")!.map((q) => [q.message.id, q.takenBy])).toEqual([["u2", holder.id], ["u3", holder.id]]);

    // That run died without ending (no lease to expire). Once storage lets a
    // new run supersede it, the refused sender's input goes and the other is answered.
    mem.runs.set(holder.id, { ...holder, status: "errored" });
    expect((await runtime.cron({ now: Date.now() + 120_000 })).held).toBe(1);
    const prompt = JSON.stringify(promptsOf(model)[1]);
    expect(prompt).toContain("q3");
    expect(prompt).not.toContain("q2");
    expect(mem.queued.get("chat_1")).toBeUndefined();
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

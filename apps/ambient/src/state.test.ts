import { describe, expect, it } from "vitest";
import { createClient } from "@libsql/client";
import { createStateStore } from "./state.js";

const fresh = async (now = () => 1_000) => {
  const store = createStateStore(createClient({ url: ":memory:" }), now);
  await store.migrate();
  return store;
};

describe("channel state store", () => {
  it("reads an empty state for an unknown channel and round-trips a document", async () => {
    const store = await fresh();
    expect(await store.load("C1")).toEqual({ channel: "C1", doc: "", bootstrappedAt: null, updatedAt: null });
    await store.saveDoc("C1", "## Open questions\n- none");
    expect(await store.load("C1")).toMatchObject({ doc: "## Open questions\n- none", updatedAt: 1_000 });
  });

  it("bootstrapped is set once and survives a doc write", async () => {
    let t = 5;
    const store = await fresh(() => t);
    await store.markBootstrapped("C1");
    t = 9;
    await store.markBootstrapped("C1");
    await store.saveDoc("C1", "doc");
    expect(await store.load("C1")).toMatchObject({ bootstrappedAt: 5, doc: "doc", updatedAt: 9 });
  });

  it("the inbox is idempotent on key, drains oldest-first, and is per channel", async () => {
    const store = await fresh();
    await store.push("C1", "ev2", { kind: "message", ts: "200.1", text: "b" });
    await store.push("C1", "ev1", { kind: "message", ts: "100.1", text: "a" });
    await store.push("C1", "ev1", { kind: "message", ts: "100.1", text: "a (dup)" });
    await store.push("C2", "ev3", { kind: "reaction_added", ts: "300.1", emoji: "eyes", targetTs: "100.1" });
    expect(await store.pending("C1")).toBe(2);
    expect((await store.drain("C1")).map((o) => (o.kind === "message" ? o.text : o.kind))).toEqual(["a", "b"]);
    expect(await store.pending("C1")).toBe(0);
    expect(await store.drain("C1")).toEqual([]);
    expect(await store.drain("C2")).toEqual([{ kind: "reaction_added", ts: "300.1", emoji: "eyes", targetTs: "100.1" }]);
  });

  it("peek shows the queue and the oldest arrival without draining; triage verdicts are logged newest-first", async () => {
    let t = 100;
    const store = await fresh(() => t);
    await store.push("C1", "e1", { kind: "message", ts: "1.0", text: "a" });
    t = 250;
    await store.push("C1", "e2", { kind: "message", ts: "2.0", text: "b" });
    const peeked = await store.peek("C1");
    expect(peeked.events.map((o) => o.ts)).toEqual(["1.0", "2.0"]);
    expect(peeked.oldestReceivedAt).toBe(100);
    expect(await store.pending("C1")).toBe(2);
    expect(await store.peek("C2")).toEqual({ events: [], oldestReceivedAt: null });

    await store.logTriage("C1", { act: false, stage: "rule", reason: "noise", events: 2 });
    t = 300;
    await store.logTriage("C1", { act: true, stage: "model", reason: "a promise", events: 3, inputTokens: 120, outputTokens: 15 });
    expect(await store.listTriage("C1")).toEqual([
      { at: 300, act: true, stage: "model", reason: "a promise", events: 3, inputTokens: 120, outputTokens: 15 },
      { at: 250, act: false, stage: "rule", reason: "noise", events: 2 },
    ]);
  });

  it("remembers where it posted: recentPosts carries the thread", async () => {
    let t = 10;
    const store = await fresh(() => t);
    await store.recordPost("C1", "1.0", "addressed");
    t = 20;
    await store.recordPost("C1", "2.5", "addressed", "2.0");
    expect(await store.recentPosts("C1", 0)).toEqual([{ ts: "1.0", postedAt: 10 }, { ts: "2.5", threadTs: "2.0", postedAt: 20 }]);
    expect(await store.recentPosts("C1", 15)).toHaveLength(1);
  });

  it("counts only unprompted posts inside the window, per channel", async () => {
    let t = 0;
    const store = await fresh(() => t);
    t = 10;
    await store.recordPost("C1", "1.0", "unprompted");
    await store.recordPost("C1", "1.1", "addressed");
    await store.recordPost("C2", "1.2", "unprompted");
    t = 20;
    await store.recordPost("C1", "1.3", "unprompted");
    expect(await store.unpromptedPostsSince("C1", 0)).toBe(2);
    expect(await store.unpromptedPostsSince("C1", 15)).toBe(1);
    expect(await store.unpromptedPostsSince("C2", 0)).toBe(1);
  });
});

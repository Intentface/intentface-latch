import { describe, expect, it, vi } from "vitest";
import { createClient } from "@libsql/client";
import { HEARTBEAT_PROMPT, TICK_PROMPT } from "./agent.js";
import { createStateStore } from "./state.js";
import { createTick, type TickRuntime } from "./tick.js";
import { createTriage } from "./triage.js";

async function build(opts: { historyLength?: number } = {}) {
  const state = createStateStore(createClient({ url: ":memory:" }));
  await state.migrate();
  const calls: string[] = [];
  const runtime: TickRuntime = {
    runAgent: vi.fn(async (i) => void calls.push(`run:${i.prompt === TICK_PROMPT ? "tick" : "heartbeat"}`)),
    loadHistory: vi.fn(async () => new Array(opts.historyLength ?? 0).fill({})),
    compactChat: vi.fn(async () => ({ compacted: 7 })),
  };
  const slack = { setThinking: vi.fn(async (c: string, t: string, on: boolean) => void calls.push(`thinking:${t}:${on}`)) };
  const log = vi.fn();
  const tick = createTick({ runtime, state, triage: createTriage(), slack, compactAfter: 5, log });
  return { tick, state, runtime, slack, calls, log };
}

describe("tick", () => {
  it("an empty inbox is a heartbeat; a mention shows thinking on its thread around the run and clears it even if the run fails", async () => {
    const { tick, state, runtime, calls } = await build();
    expect(await tick("C1")).toBe(false);
    expect(calls).toEqual(["run:heartbeat"]);

    calls.length = 0;
    await state.push("C1", "e1", { kind: "mention", ts: "10.0", threadTs: "5.0", text: "<@B> ?" });
    await state.push("C1", "e2", { kind: "mention", ts: "11.0", text: "<@B> and this?" });
    await state.push("C1", "e3", { kind: "message", ts: "12.0", text: "unrelated" });
    (runtime.runAgent as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("model down"));
    await expect(tick("C1")).rejects.toThrow("model down");
    expect(calls).toEqual(["thinking:5.0:true", "thinking:11.0:true", "thinking:5.0:false", "thinking:11.0:false"]);
    expect(await state.pending("C1")).toBe(3); // nothing drained: the agent's read_inbox does that, and it never ran
  });

  it("a deferred batch runs nothing and is logged; an acted batch is logged too and compaction kicks in past the cap", async () => {
    const { tick, state, runtime, log } = await build({ historyLength: 5 });
    await state.push("C1", "r1", { kind: "reaction_added", ts: "1.0", emoji: "tada", targetTs: "999.0" });
    expect(await tick("C1")).toBe(false);
    expect(runtime.runAgent).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/deferred 1 event/));

    await state.push("C1", "m1", { kind: "message", ts: "2.0", text: "can someone review?" });
    expect(await tick("C1")).toBe(true); // the fake agent did not drain, so "more" is still pending
    expect(runtime.runAgent).toHaveBeenCalledWith(expect.objectContaining({ prompt: TICK_PROMPT, threadId: "ambient_C1" }));
    expect(runtime.compactChat).toHaveBeenCalledOnce();
    const verdicts = await state.listTriage("C1");
    expect(verdicts.map((v) => [v.act, v.events])).toEqual([[true, 2], [false, 1]]);
  });
});
